import { MemoryStream } from "./memory-stream.js";
import { retrieve } from "./retrieval.js";
import { type Complete, stubComplete } from "./llm.js";

// CACHED AGENT-SUMMARY DESCRIPTION (Park et al., Generative Agents, UIST '23, Appendix A "Architecture
// Optimizations") — the stable [Agent's Summary Description] block prepended to nearly every prompt the
// agent issues. The paper builds it by retrieving on three fixed queries about the agent's identity,
// occupation, and recent self-assessment, summarizing each retrieved set with the LLM, and concatenating
// the three summaries under a header line of name (+ age + innate traits).
//
// WHY CACHE IT (Appendix A + INC-2026-06-18 efficiency win): regenerating this prefix every tick is wasted
// work — and in the post-mortem the leak was paying cache-creation every tick. The summary
// changes slowly (the agent's core characteristics don't churn minute-to-minute), so we build it once and
// REUSE it for many prompts, refreshing only periodically (needsRefresh). A stable prefix is also exactly
// what cache-reuse wants: identical leading bytes across calls → the model can reuse the cached prefix.
//
// COST DISCIPLINE (the seam, per llm.ts): we take an INJECTED `Complete` and never import the SDK. The
// three facet-summaries are the only model calls here; at build/unit-test time `stubComplete` makes them
// free and deterministic. A `Complete` that throws or returns "" degrades to the retrieved memories' own
// text (degrade-don't-die, the world-tools rule) — the summary is never empty just because a call failed.

export type AgentSummary = {
  text: string; // the rendered [Agent's Summary Description] block, ready to prepend to a prompt
  builtAtGameMin: number; // sim game-minutes when built — drives needsRefresh's staleness check
};

// How many memories to retrieve per facet query before summarizing (the paper retrieves a handful of the
// most relevant; small k keeps the prompt — and any real token spend — tight).
const RETRIEVE_K = 10;

// Default refresh cadence in GAME-minutes. The summary changes slowly, so a few game-hours between rebuilds
// is plenty; the paper refreshes periodically rather than per-tick. Overridable per call.
const DEFAULT_REFRESH_EVERY_GAME_MIN = 3 * 60; // 3 game-hours

// The three fixed retrieval queries from the paper (Appendix A), parameterized by the agent's name. Each
// pairs with a short instruction telling `Complete` how to summarize that facet's retrieved memories.
type Facet = { query: (name: string) => string; instruct: (name: string) => string };
const FACETS: Facet[] = [
  {
    query: (n) => `${n}'s core characteristics`,
    instruct: (n) =>
      `How would one describe ${n}'s core characteristics given the following statements?`,
  },
  {
    query: (n) => `${n}'s current daily occupation`,
    instruct: (n) =>
      `What is ${n}'s current daily occupation given the following statements?`,
  },
  {
    query: (n) => `${n}'s feeling about his recent progress in life`,
    instruct: (n) =>
      `What might one summarize about ${n}'s feeling about his recent progress in life given the following statements?`,
  },
];

/**
 * Build the cached [Agent's Summary Description] (paper Appendix A). For each of the three fixed facets it
 * retrieves the most relevant memories (recency·importance·relevance, via retrieval.ts) and asks `complete`
 * to summarize them, then concatenates the header (name [+ age] [+ innate traits]) with the three facet
 * summaries into the block. Async because retrieval embeds locally and the facets call the model.
 *
 * Degrade-don't-die: a facet whose `complete` throws or returns empty falls back to the retrieved memories'
 * own text (joined), so the summary is always non-empty and informative even if the model is unavailable.
 */
export async function buildSummary(
  stream: MemoryStream,
  complete: Complete,
  opts: { name: string; age?: number; traits?: string; nowGameMin: number },
): Promise<AgentSummary> {
  const { name, age, traits, nowGameMin } = opts;

  // Summarize each facet independently. Sequential (not Promise.all) so a real Complete sees the agent's
  // calls one at a time — gentler on rate limits and cheaper to reason about; this runs only ~periodically.
  const facetSummaries: string[] = [];
  for (const facet of FACETS) {
    const scored = await retrieve(stream, facet.query(name), { k: RETRIEVE_K, nowGameMin });
    const statements = scored.map((s) => `- ${s.memory.text}`).join("\n");
    facetSummaries.push(await summarizeFacet(complete, facet.instruct(name), statements));
  }

  return { text: renderBlock(name, age, traits, facetSummaries), builtAtGameMin: nowGameMin };
}

/**
 * True if the summary should be (re)built: no summary yet, or it is older than `everyGameMin` game-minutes
 * (default a few game-hours). A backwards clock (nowGameMin < builtAtGameMin, e.g. a fresh-day reset) also
 * forces a rebuild rather than treating the stale summary as fresh.
 */
export function needsRefresh(
  summary: AgentSummary | null,
  nowGameMin: number,
  everyGameMin: number = DEFAULT_REFRESH_EVERY_GAME_MIN,
): boolean {
  if (!summary) return true;
  const ageGameMin = nowGameMin - summary.builtAtGameMin;
  return ageGameMin < 0 || ageGameMin >= everyGameMin;
}

// ---- internals ----

// Ask the model to summarize one facet's retrieved statements. Returns trimmed model text, or — if the
// model throws / returns empty, or there were no statements — a safe fallback so the block is never blank.
async function summarizeFacet(complete: Complete, instruction: string, statements: string): Promise<string> {
  if (!statements) return "(no relevant memories yet)";
  const prompt = `${instruction}\n\n${statements}`;
  let out = "";
  try {
    out = (await complete(prompt, { maxTokens: 256 })) ?? "";
  } catch {
    out = ""; // degrade-don't-die: a failed completion → fall back to the raw statements below
  }
  out = out.trim();
  // Fallback keeps the facet informative (the retrieved memories) even with no/failed model output.
  return out || statements;
}

// Render the paper's [Agent's Summary Description] block: a header line of identity (name, optional age,
// optional innate traits) followed by the three facet summaries, in order.
function renderBlock(name: string, age: number | undefined, traits: string | undefined, facets: string[]): string {
  const headerBits = [name];
  if (age !== undefined) headerBits.push(`(age: ${age})`);
  const t = traits?.trim();
  if (t) headerBits.push(`Innate traits: ${t}`);
  const header = headerBits.join(" ");
  return [header, ...facets].join("\n");
}

// ---- runnable stub self-test (zero tokens) ----
// `tsx cognition/summary.ts` exercises buildSummary with stubComplete + a seeded stream and asserts the
// block contains the name and each summarized facet, plus the needsRefresh logic. No SDK, no model, no
// network beyond the local-embeddings model that retrieval may load; relevance degrades to 0 if it can't,
// so the test still passes. Mirrors the contract's "unit-test with stubComplete, report it".
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "summary-selftest-"));
    const stream = new MemoryStream("isabella", { dir, nowGameMin: () => 500 });
    // A few characteristic memories spanning the three facets (identity / occupation / recent progress).
    stream.add({ kind: "observation", text: "Isabella is warm, outgoing, and loves bringing people together.", createdAt: 100, importance: 8 });
    stream.add({ kind: "observation", text: "Isabella runs Hobbs Cafe and serves coffee to customers each morning.", createdAt: 200, importance: 7 });
    stream.add({ kind: "reflection", text: "Isabella feels her cafe has been thriving and she is proud of the regulars.", createdAt: 300, importance: 6 });

    // Deterministic per-facet stub: echo which facet was asked so we can assert each made it into the block.
    const complete = stubComplete((prompt) => {
      if (prompt.includes("core characteristics")) return "Warm and community-minded.";
      if (prompt.includes("daily occupation")) return "Runs Hobbs Cafe.";
      if (prompt.includes("progress in life")) return "Proud and optimistic about the cafe.";
      return "(unmatched facet)";
    });

    const summary = await buildSummary(stream, complete, {
      name: "Isabella",
      age: 34,
      traits: "friendly, organized",
      nowGameMin: 500,
    });

    const assert = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    };

    assert(summary.text.includes("Isabella"), "block contains the agent name");
    assert(summary.text.includes("(age: 34)"), "header contains the age");
    assert(summary.text.includes("Innate traits: friendly, organized"), "header contains innate traits");
    assert(summary.text.includes("Warm and community-minded."), "block contains the characteristics facet");
    assert(summary.text.includes("Runs Hobbs Cafe."), "block contains the occupation facet");
    assert(summary.text.includes("Proud and optimistic about the cafe."), "block contains the recent-progress facet");
    assert(summary.builtAtGameMin === 500, "builtAtGameMin records the build time");

    // needsRefresh: null → true; fresh → false; aged past cadence → true; backwards clock → true.
    assert(needsRefresh(null, 0) === true, "no summary yet → refresh");
    assert(needsRefresh(summary, 500 + 60) === false, "1 game-hour old (< 3h cadence) → no refresh");
    assert(needsRefresh(summary, 500 + 3 * 60) === true, "3 game-hours old (>= cadence) → refresh");
    assert(needsRefresh(summary, 500 + 30, 15) === true, "older than a custom 15-min cadence → refresh");
    assert(needsRefresh(summary, 400) === true, "backwards clock (day reset) → refresh");

    // Degrade-don't-die: a Complete that throws still yields a non-empty block (raw statements fall back in).
    const throwing = stubComplete(() => {
      throw new Error("model unavailable");
    });
    const degraded = await buildSummary(stream, throwing, { name: "Isabella", nowGameMin: 500 });
    assert(degraded.text.includes("Hobbs Cafe"), "degraded summary falls back to retrieved memory text");

    console.log("summary.ts self-test: ALL ASSERTIONS PASSED");
    console.log("---\nsample [Agent's Summary Description]:\n" + summary.text);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
