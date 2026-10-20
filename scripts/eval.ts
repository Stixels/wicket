// Runs the model test set in evals/cases.yaml against one or more models and scores each reply.
// Each case is a chat with a signed-in person, run through the same conversation code as the
// server, with a fake tracker that starts from the file's `backlog`. So route cases can check
// what the assistant filed or added to, and no real ticket is ever created.
//
//   npm run eval                                  every case, twice, on AGENT_MODEL
//   npm run eval -- --models claude-haiku-5-5,openai/gpt-6-luna
//   npm run eval -- --only 24,25,26 --reps 1
//
// Uses the same env as the server (.env): a model key, the docs repo and config/wicket.yaml.
// Docs are indexed into a throwaway database, so nothing touches the real one. Results print
// as a table and are saved to evals/results/<time>.json.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { backlogSchema, caseSchema, type EvalCase } from "../src/eval/grade.js";
import { runCase } from "../src/eval/run.js";
import type { TrackerLog } from "../src/eval/tracker.js";
import { gatewayModelId } from "../src/gateway.js";
import { reindex } from "../src/knowledge/index.js";
import { knowledgeSources } from "../src/knowledge/sources.js";
import { loadSettings, resolveProfile } from "../src/settings.js";
import { costMicros } from "../src/usage.js";

const { values: args } = parseArgs({
  options: {
    models: { type: "string" },
    reps: { type: "string", default: "2" },
    only: { type: "string" },
    cases: { type: "string", default: "evals/cases.yaml" },
  },
});

const config = loadConfig();
const settings = loadSettings(config.WICKET_CONFIG);
const gateway = Boolean(config.AI_GATEWAY_API_KEY);
const client = gateway
  ? createGateway({ apiKey: config.AI_GATEWAY_API_KEY, ...(config.AI_GATEWAY_URL ? { baseURL: config.AI_GATEWAY_URL } : {}) })
  : config.ANTHROPIC_API_KEY
    ? createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;
if (!client) throw new Error("Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY to run the eval");

const only = args.only ? new Set(args.only.split(",").map(Number)) : null;
const file = z
  .object({ backlog: z.array(backlogSchema).default([]), cases: z.array(caseSchema) })
  .parse(parse(readFileSync(args.cases, "utf8")));
const cases = file.cases.filter((c) => !only || only.has(c.id));
const models = (args.models ?? config.AGENT_MODEL).split(",").map((m) => m.trim()).filter(Boolean);
const reps = Number(args.reps);

// A signed-in user on an ordinary page: the profile most people get. No app tools: the eval has no user token.
const profile = resolveProfile(settings, { signedIn: true, plan: null, path: "/app" });
if (!profile.tickets) throw new Error(`The "${profile.name}" profile has tickets off, so route cases can't run`);

const dir = mkdtempSync(join(tmpdir(), "wicket-eval-"));
const db = openDb(join(dir, "eval.db"));
const sources = knowledgeSources(config, settings);
console.log(`docs: indexed ${await reindex(db, sources)} sections`);

interface Run {
  model: string;
  case: number;
  kind: EvalCase["kind"];
  rep: number;
  pass: boolean;
  why: string[];
  reply: string;
  handedOff: boolean;
  toolCalls: number;
  costMicros: number;
  ms: number;
  /** What the assistant filed and added to in the fake tracker. */
  tickets?: TrackerLog;
  error?: string;
}

const runs: Run[] = [];
for (const model of models) {
  const agent = {
    model: gateway ? gatewayModelId(model) : model,
    effort: config.AGENT_EFFORT,
    maxSteps: config.AGENT_MAX_STEPS,
    productName: config.PRODUCT_NAME,
    productDescription: config.PRODUCT_DESCRIPTION,
    instructions: settings.assistant.instructions,
    code: settings.assistant.code,
  };
  for (const c of cases) {
    for (let rep = 1; rep <= reps; rep++) {
      const started = Date.now();
      const run: Run = { model, case: c.id, kind: c.kind, rep, pass: false, why: [], reply: "", handedOff: false, toolCalls: 0, costMicros: 0, ms: 0 };
      try {
        const r = await runCase(c, { db, models: client, agent, settings, backlog: file.backlog });
        Object.assign(run, {
          pass: r.pass,
          why: r.why,
          ...r.outcome,
          toolCalls: r.toolCalls,
          costMicros: r.usage.reduce((sum, u) => sum + costMicros(u, settings.budgets.prices), 0),
        });
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
        run.why = [`error: ${run.error.slice(0, 200)}`];
      }
      run.ms = Date.now() - started;
      runs.push(run);
      console.log(`${run.pass ? "pass" : "FAIL"}  ${model}  #${c.id} ${c.kind} (run ${rep})${run.why.length ? `: ${run.why.join("; ")}` : ""}`);
    }
  }
}

db.$client.close();
rmSync(dir, { recursive: true, force: true });

console.log("\nmodel                       pass      cost    avg time  avg tools  errors");
for (const model of models) {
  const mine = runs.filter((r) => r.model === model);
  const passed = mine.filter((r) => r.pass).length;
  const cost = mine.reduce((s, r) => s + r.costMicros, 0) / 1_000_000;
  const avg = (f: (r: Run) => number) => mine.reduce((s, r) => s + f(r), 0) / mine.length;
  console.log(
    `${model.padEnd(26)}  ${`${passed}/${mine.length}`.padEnd(8)}  $${cost.toFixed(4).padStart(6)}  ${(avg((r) => r.ms) / 1000).toFixed(1).padStart(6)}s  ${avg((r) => r.toolCalls).toFixed(1).padStart(9)}  ${mine.filter((r) => r.error).length}`,
  );
}

const kinds = [...new Set(runs.map((r) => r.kind))];
console.log(`\nby kind: ${kinds.map((k) => `${k} ${runs.filter((r) => r.kind === k && r.pass).length}/${runs.filter((r) => r.kind === k).length}`).join(", ")}`);

mkdirSync("evals/results", { recursive: true });
const out = join("evals/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ models, reps, runs }, null, 2));
console.log(`\nsaved ${out}`);
