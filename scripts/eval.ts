// Runs the model test set in evals/cases.yaml against one or more models and scores each reply.
//
//   npm run eval                                  every case, twice, on AGENT_MODEL
//   npm run eval -- --models claude-haiku-5-5,openai/gpt-6-luna
//   npm run eval -- --only 24,25,26 --reps 1
//
// Uses the same env as the server (.env): a model key, the docs repo and config/wicket.yaml.
// Docs are indexed into a throwaway database, so nothing touches the real one. Results print
// as a table and are saved to evals/results/<time>.json.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { MarkdownRepoSource } from "../src/adapters/knowledge/markdownRepo.js";
import type { KnowledgeSource } from "../src/adapters/types.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { caseSchema, grade, type EvalCase } from "../src/eval/grade.js";
import { gatewayModelId } from "../src/gateway.js";
import { readDoc, reindex, searchDocs } from "../src/knowledge/index.js";
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
  ? new Anthropic({ apiKey: config.AI_GATEWAY_API_KEY, baseURL: config.AI_GATEWAY_URL })
  : config.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;
if (!client) throw new Error("Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY to run the eval");

const only = args.only ? new Set(args.only.split(",").map(Number)) : null;
const cases = z
  .object({ cases: z.array(caseSchema) })
  .parse(parse(readFileSync(args.cases, "utf8")))
  .cases.filter((c) => !only || only.has(c.id));
const models = (args.models ?? config.AGENT_MODEL).split(",").map((m) => m.trim()).filter(Boolean);
const reps = Number(args.reps);

// A signed-in user on an ordinary page: the profile most people get.
const profile = resolveProfile(settings, { signedIn: true, plan: null, path: "/app" });

const dir = mkdtempSync(join(tmpdir(), "wicket-eval-"));
const db = openDb(join(dir, "eval.db"));
const sources: KnowledgeSource[] = [];
if (config.DOCS_GITHUB_REPO) {
  sources.push(new MarkdownRepoSource({ repo: config.DOCS_GITHUB_REPO, ref: config.DOCS_GITHUB_REF, token: config.DOCS_GITHUB_TOKEN, baseUrl: config.DOCS_BASE_URL }));
}
for (const k of settings.knowledge) {
  sources.push(new MarkdownRepoSource({ repo: k.github, ref: k.ref, baseUrl: k.baseUrl, include: k.include, exclude: k.exclude, token: config.DOCS_GITHUB_TOKEN }));
}
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
  error?: string;
}

const runs: Run[] = [];
for (const model of models) {
  const agent = new Agent(client as any, {
    model: gateway ? gatewayModelId(model) : model,
    effort: profile.effort ?? config.AGENT_EFFORT,
    maxSteps: config.AGENT_MAX_STEPS,
    productName: config.PRODUCT_NAME,
    productDescription: config.PRODUCT_DESCRIPTION,
    instructions: settings.assistant.instructions,
    code: settings.assistant.code,
  });
  for (const c of cases) {
    for (let rep = 1; rep <= reps; rep++) {
      const started = Date.now();
      let handedOff = false;
      const run: Run = { model, case: c.id, kind: c.kind, rep, pass: false, why: [], reply: "", handedOff: false, toolCalls: 0, costMicros: 0, ms: 0 };
      try {
        const result = await agent.respond(
          [
            {
              role: "user",
              content: [
                { type: "text", text: `<app_context>\n${JSON.stringify({ page: "/app" }, null, 2)}\n</app_context>` },
                { type: "text", text: c.question },
              ],
            },
          ],
          {
            searchDocs: (q) => searchDocs(db, q),
            readDoc: (url) => readDoc(db, url),
            handoff: async () => void (handedOff = true),
          },
          { instructions: profile.instructions, effort: profile.effort, topics: profile.topics, offTopic: profile.offTopic },
        );
        handedOff ||= result.handedOff;
        const g = grade(c, { reply: result.reply, handedOff });
        Object.assign(run, {
          pass: g.pass,
          why: g.why,
          reply: result.reply,
          handedOff,
          toolCalls: result.newTurns.flatMap((t) => (Array.isArray(t.content) ? t.content : [])).filter((b) => b.type === "tool_use").length,
          costMicros: result.usage.reduce((sum, u) => sum + costMicros(u, settings.budgets.prices), 0),
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

mkdirSync("evals/results", { recursive: true });
const file = join("evals/results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ models, reps, runs }, null, 2));
console.log(`\nsaved ${file}`);
