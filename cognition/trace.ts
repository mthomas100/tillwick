import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ScoredMemory } from "./retrieval.js";

// STRUCTURED PER-TICK TRACE (OBSERVABILITY.md §7) — one append-only JSON line per citizen per tick, written
// by the citizen loop right after reportUsage. It makes the paper's decision chain DURABLE + greppable:
// the retrieved working-set + WHY each memory surfaced (recency/importance/relevance subscores, §4.1) that
// today's trace-decision.ts can only RECONSTRUCT, plus a `result` health line so a silent no-op tick (the
// INC-2026-06-18 zombie loop logged "✓ success cost_usd=0" for ~1,300 ticks/agent) is one jq away:
//     jq 'select(.result.cost_usd==0)' sim/data/traces/*.jsonl | wc -l
//
// SAME GRAIN AS THE REST OF THE SYSTEM: plain JSONL, one writer-per-process (each citizen owns its own
// <id>.jsonl), NO tracing SDK (§7 is explicit: "Do not add OpenTelemetry — it's overkill for a single-box
// sim and fights the plain JSONL, greppable, forkable grain"). DEGRADE-DON'T-DIE: a trace-write failure is
// swallowed and NEVER throws into the tick (the repo rule — memory-stream.ts append(), run-state.ts writes).
//
// COST: zero tokens. Every field is already computed (retrieve() ran in renderTick; the SDK result + the
// cognition accumulator are in scope at the call site) — this just serializes what the tick already produced.

const HERE = dirname(fileURLToPath(import.meta.url)); // cognition/
const ROOT = dirname(HERE); // repo root
// sim/data/ is already gitignored (the sim runtime-data dir), so per-agent traces ride along untracked,
// next to the memory streams + transcripts they correspond to.
const DEFAULT_DIR = join(ROOT, "sim", "data", "traces");

// One retrieved memory + WHY it surfaced — the §7 `retrieved[]` element. The three subscores are the
// NORMALIZED [0,1] components retrieval.ts:128-134 already computed (so you can see the ranking math).
export type TraceRetrieved = {
  id: string;
  score: number;
  recency: number; // normalized [0,1]
  importance: number; // normalized [0,1]
  relevance: number; // normalized [0,1]
  text: string;
};

// One tool the ACT turn invoked (the §7 `actions[]` element) — the world-tool name + its input.
export type TraceAction = { tool: string; input: unknown };

// The per-tick health/outcome summary (the §7 `result` line) — the part that screams during a zombie loop.
export type TraceResult = {
  subtype: string; // SDK result subtype ("success" | "error_max_turns" | …)
  cost_usd: number; // notional on a subscription, but 0 is the zombie-loop tell; this is the WHOLE-tick metered burn
  num_turns: number;
  error: string | null;
};

// One trace line — the §7 JSONC shape. Optional blocks (`plan`, `social`) are omitted when absent rather
// than written null, to keep lines tight and the jq health-query (`.result.cost_usd`) stable.
export type TraceLine = {
  ts: string; // wall-clock ISO (when the tick finished) — NOT the game clock
  id: string;
  tick: number;
  gameMin: number;
  perceived: { at?: { x?: number; y?: number }; shop?: string | null; adjacentTo?: string[] };
  retrieved: TraceRetrieved[]; // the working-set + subscores (the piece trace-decision.ts can't reconstruct)
  plan?: string; // the plan chunk in play (optional)
  reasoning: string; // the ACT-turn narration (may be "")
  actions: TraceAction[]; // the tools the ACT turn called, in order
  wrote: { observations: number; reflections: number };
  result: TraceResult; // the health line
  social?: { newAdjacency: string[]; dialoguesFired: number };
};

/**
 * Project a retrieval working-set (ScoredMemory[] from retrieve()/Mind.lastRetrieved()) into the §7
 * `retrieved[]` shape — id + score + the three normalized subscores + the memory text. Lets the citizen
 * hook stay a one-liner (`retrieved: traceRetrieved(mind.lastRetrieved())`). `max` caps how many surface in
 * the trace (the working-set can be larger than is useful to log); defaults to the whole set.
 */
export function traceRetrieved(scored: readonly ScoredMemory[] | undefined, max?: number): TraceRetrieved[] {
  if (!scored || scored.length === 0) return [];
  const n = typeof max === "number" && max >= 0 ? max : scored.length;
  return scored.slice(0, n).map((s) => ({
    id: s.memory.id,
    score: round4(s.score),
    recency: round4(s.recency),
    importance: round4(s.importance),
    relevance: round4(s.relevance),
    text: s.memory.text,
  }));
}

/**
 * Append ONE trace line for a citizen's tick. `line` is a TraceLine missing only `ts` (we stamp wall-clock
 * here, so callers never have to). Best-effort: any failure (bad dir, serialize error, full disk) is
 * swallowed — a trace write must NEVER throw into the tick (degrade-don't-die). Returns true if written.
 *
 * `dir` overrides the store directory (tests/harness); defaults to sim/data/traces.
 */
export function appendTrace(id: string, line: Omit<TraceLine, "ts">, dir?: string): boolean {
  try {
    const safe = (id || "agent").replace(/[^A-Za-z0-9._-]/g, "_") || "agent"; // can't escape the dir
    const file = join(dir ?? DEFAULT_DIR, `${safe}.jsonl`);
    const rec: TraceLine = { ts: new Date().toISOString(), ...line };
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    return false; // never let a trace write crash a tick
  }
}

// Round a [0,1]-ish score to 4 dp — keeps the JSONL compact + readable without losing ranking detail.
function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0;
}
