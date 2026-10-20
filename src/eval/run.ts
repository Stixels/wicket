import { Agent, type AgentOptions, type AgentResult, type ModelProvider } from "../agent/agent.js";
import { ConversationService } from "../conversations.js";
import { schema, type Db } from "../db/index.js";
import type { Settings } from "../settings.js";
import { TicketDesk } from "../tickets.js";
import type { TokenUsage } from "../usage.js";
import { grade, type EvalCase, type Grade, type Outcome } from "./grade.js";
import { EvalTracker, type BacklogTicket } from "./tracker.js";

/** Keeps every answer, so a run can be scored on tool calls and cost, and errors aren't hidden by a handoff. */
class RecordingAgent extends Agent {
  results: AgentResult[] = [];
  errors: unknown[] = [];
  override async respond(...a: Parameters<Agent["respond"]>) {
    try {
      const r = await super.respond(...a);
      this.results.push(r);
      return r;
    } catch (err) {
      this.errors.push(err);
      throw err;
    }
  }
}

export interface CaseRun extends Grade {
  outcome: Required<Outcome>;
  toolCalls: number;
  usage: TokenUsage[];
}

let runs = 0;

/** What the widget attaches to a chat in the app (see collectContext in widget/widget.ts), plus the version ED sends. */
export const APP_CONTEXT = {
  page: "https://app.escapedirector.com/app",
  title: "Escape Director",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  viewport: "1440x900",
  language: "en-US",
  appVersion: "2.14.0",
};

/**
 * Runs one case as a chat with a signed-in person on an ordinary page, through the same
 * conversation code the server uses, with a fake tracker that starts from `backlog`.
 * `db` must already have the docs indexed; its tickets are cleared first.
 */
export async function runCase(
  c: EvalCase,
  o: { db: Db; models: ModelProvider; agent: AgentOptions; settings: Settings; backlog: BacklogTicket[] },
): Promise<CaseRun> {
  // A fresh backlog each run, so one run's tickets and reports don't leak into the next.
  o.db.delete(schema.ticketLinks).run();
  o.db.delete(schema.tickets).run();
  const tracker = new EvalTracker(o.backlog);
  const agent = new RecordingAgent(o.models, o.agent);
  const service = new ConversationService(o.db, agent, null, {
    // The eval's own spend shouldn't hit the monthly cap, and the assistant always logs tickets here.
    settings: { ...o.settings, budgets: { ...o.settings.budgets, monthlyTotal: undefined }, tickets: { ...o.settings.tickets, assistant: true } },
    tickets: new TicketDesk(o.db, tracker, { notify: async () => {}, log: () => {} }),
    publicUrl: "https://wicket.test",
    log: () => {},
  });
  const who = { id: `eval-${++runs}`, name: "Sam", email: "sam@example.com", plan: null, account: null, budget: null, env: null };
  const { id } = service.create({}, APP_CONTEXT, { identity: who });
  for (const message of [c.question, ...c.then]) {
    await service.postUserMessage(id, message);
    await service.idle(id);
    if (agent.errors.length) throw agent.errors[0];
  }
  const outcome = {
    reply: service
      .list(id)
      .filter((m) => m.author === "agent")
      .map((m) => m.body)
      .join("\n\n"),
    handedOff: agent.results.some((r) => r.handedOff) || service.get(id)?.status === "needs_human",
    tickets: tracker.log,
  };
  return {
    ...grade(c, outcome),
    outcome,
    toolCalls: agent.results
      .flatMap((r) => r.newTurns)
      .flatMap((t) => (Array.isArray(t.content) ? t.content : []))
      .filter((b) => b.type === "tool_use").length,
    usage: agent.results.flatMap((r) => r.usage),
  };
}
