import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PERSONAS } from "../citizens/personas.js";

// ── npm run trace -- <id> <tick> ────────────────────────────────────────────────────────────────────────
// Reconstruct ONE decision end-to-end — the chain the paper cares about:
//   PERCEPTION → RETRIEVED MEMORIES → REASONING → TOOL CALLS (the ACTION) → MEMORY WRITES → COST
// purely from the existing audit files (sim/data/agents/<id>.jsonl + sim/data/memory/<id>.jsonl). ZERO tokens.
//
// This is the "explain their behavior" microscope. It stitches:
//   • REASONING + ACTIONS + COST  — from <id>.jsonl (the raw SDK transcript: assistant text/tool_use, result).
//   • PERCEPTION + MEMORY context — from <id>.jsonl `system`/init + the memory stream around the tick's game-min
//     (the observations the agent banked + the reflections/plan in play). NOTE: the EXACT rendered prompt
//     (renderTick's perception+retrieved-working-set string) is NOT persisted verbatim today — only its inputs
//     are. The structured per-tick trace proposed in OBSERVABILITY.md would close that last gap.
//
// Usage:
//   npm run trace -- baker 4           # trace baker's tick 4
//   npm run trace -- grocer 5 --raw    # also dump the raw assistant/user record sequence

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root
const DATA = join(ROOT, "sim", "data");

const argv = process.argv.slice(2);
const raw = argv.includes("--raw");
const positional = argv.filter((a) => !a.startsWith("--"));
const id = positional[0];
const tick = Number(positional[1]);

if (!id || !Number.isFinite(tick)) {
  console.error("usage: npm run trace -- <citizenId> <tick> [--raw]   e.g.  npm run trace -- baker 4");
  process.exit(1);
}
if (!PERSONAS[id]) {
  console.error(`[trace] unknown citizen "${id}". Known: ${Object.keys(PERSONAS).join(", ")}.`);
  process.exit(1);
}

const C = { dim: "\x1b[2m", b: "\x1b[1m", cyan: "\x1b[36m", yel: "\x1b[33m", grn: "\x1b[32m", mag: "\x1b[35m", red: "\x1b[31m", blu: "\x1b[34m", off: "\x1b[0m" };
const rule = (s: string) => `${C.b}${C.cyan}┌─ ${s} ${"─".repeat(Math.max(0, 64 - s.length))}${C.off}`;

type Rec = { ts?: string; tick?: number; type?: string; msg?: any };
type Mem = { id: string; kind: string; text: string; createdAt: number; importance: number };
// The structured per-tick trace line (cognition/trace.ts / OBSERVABILITY §7). When present we render the
// EXACT retrieved working-set + subscores for the tick instead of reconstructing context from the stream.
type TraceRetrieved = { id: string; score: number; recency: number; importance: number; relevance: number; text: string };
type TraceLine = {
  ts?: string; id?: string; tick?: number; gameMin?: number;
  perceived?: { at?: { x?: number; y?: number }; shop?: string | null; adjacentTo?: string[] };
  retrieved?: TraceRetrieved[];
  plan?: string;
  result?: { subtype?: string; cost_usd?: number; num_turns?: number; error?: string | null };
};

function readJsonl<T>(file: string, filter?: (line: string) => boolean): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    if (filter && !filter(l)) continue; // cheap pre-filter on the 19MB transcript before JSON.parse
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Pull only this tick's records from the (large) transcript via a substring pre-filter, then keep the FIRST
// contiguous block for this tick number (tick numbers recur across game-days; the first block is the one run).
const allForTick = readJsonl<Rec>(join(DATA, "agents", `${id}.jsonl`), (l) => l.includes(`"tick":${tick},`)).filter((r) => r.tick === tick);
if (allForTick.length === 0) {
  console.error(`[trace] no transcript records for ${id} tick ${tick}. (Has the fleet run? Try a smaller tick, or 'npm run inspect -- ${id}'.)`);
  process.exit(1);
}
// keep the first contiguous run (stop at the first big time-gap → a later game-day reusing the tick number)
const recs: Rec[] = [];
let lastTs = 0;
for (const r of allForTick) {
  const t = r.ts ? Date.parse(r.ts) : lastTs;
  if (lastTs && t - lastTs > 5 * 60_000) break; // >5min gap ⇒ a different game-day's tick N
  recs.push(r);
  lastTs = t;
}

const t0 = recs[0]?.ts ? Date.parse(recs[0].ts!) : 0;
const tN = recs[recs.length - 1]?.ts ? Date.parse(recs[recs.length - 1].ts!) : 0;
const wallSec = t0 && tN ? ((tN - t0) / 1000).toFixed(1) : "?";

console.log(`\n${C.b}${C.mag}╔══ DECISION TRACE · ${id} · TICK ${tick} ══╗${C.off}`);
console.log(`${C.dim}${recs[0]?.ts ?? "?"} → ${recs[recs.length - 1]?.ts ?? "?"}  (~${wallSec}s wall · ${recs.length} records)${C.off}`);
console.log(`${C.dim}persona: ${PERSONAS[id].system.slice(0, 78)}…${C.off}`);

// ── 1. PERCEPTION + the MEMORY context that fed this tick ────────────────────────────────────────────────
// We can't see the exact rendered prompt, but we CAN show the memory the agent had banked just before/at this
// tick (its working context) — the closest faithful view of "what it knew going in".
console.log(`\n${rule("① PERCEPTION & MEMORY CONTEXT (what it knew going in)")}`);

// EXACT path: if a structured per-tick trace exists (cognition/trace.ts), render the real retrieved
// working-set + subscores for this tick — the piece the stream-reconstruction below can only approximate.
// Match the FIRST trace line for this tick (tick numbers recur across game-days; first block = the one run,
// mirroring the transcript window above). Falls through to reconstruction when no trace file/line is present.
const traceLines = readJsonl<TraceLine>(join(DATA, "traces", `${id}.jsonl`), (l) => l.includes(`"tick":${tick},`)).filter((t) => t.tick === tick);
const traceLine = traceLines[0];
if (traceLine) {
  const pc = traceLine.perceived ?? {};
  const at = pc.at ? `(${pc.at.x},${pc.at.y})` : "?";
  console.log(`  ${C.grn}● EXACT trace (sim/data/traces/${id}.jsonl)${C.off} ${C.dim}gameMin ${traceLine.gameMin ?? "?"}${C.off}`);
  console.log(`  ${C.b}perceived:${C.off} at ${at}${pc.shop ? ` · in ${pc.shop}` : ""}${pc.adjacentTo?.length ? ` · adjacent: ${pc.adjacentTo.join(", ")}` : ""}`);
  if (traceLine.plan) console.log(`  ${C.b}plan in play:${C.off} ${C.cyan}${traceLine.plan.slice(0, 200)}${C.off}`);
  const ret = traceLine.retrieved ?? [];
  if (ret.length) {
    console.log(`  ${C.b}retrieved working-set${C.off} ${C.dim}(score = recency+importance+relevance, normalized — paper §4.1)${C.off}`);
    for (const r of ret.slice(0, 12)) {
      const sub = `${C.dim}[rec ${r.recency.toFixed(2)} · imp ${r.importance.toFixed(2)} · rel ${r.relevance.toFixed(2)}]${C.off}`;
      console.log(`    ${C.yel}${r.score.toFixed(2)}${C.off} ${sub} ${r.text.slice(0, 120)}`);
    }
  } else {
    console.log(`  ${C.dim}(trace recorded an empty working-set this tick — retrieval may have degraded)${C.off}`);
  }
}

const mems = readJsonl<Mem>(join(DATA, "memory", `${id}.jsonl`));
// observations written DURING this tick's processing carry the perception the loop fed in (renderTick observes
// p.observationText before the ACT turn). Show the latest observation at-or-before this tick's banked memories.
const obs = mems.filter((m) => m.kind === "observation");
const lastObs = obs[obs.length - 1];
const refl = mems.filter((m) => m.kind === "reflection");
const plans = mems.filter((m) => m.kind === "plan");
// When no exact trace line exists, fall back to the stream RECONSTRUCTION (faithful but approximate — it
// can't show the exact retrieved set, only what was banked around this tick). Suppressed when the trace
// above already showed the exact working-set.
if (!traceLine) {
  if (obs.length) {
    console.log(`  ${C.b}most-recent perception banked:${C.off} ${C.yel}${lastObs?.text.slice(0, 220) ?? "(none)"}${C.off}`);
  }
  if (plans.length) console.log(`  ${C.b}plan in play:${C.off} ${C.cyan}${plans.slice(-3).map((p) => p.text).join("  ▸  ").slice(0, 240)}${C.off}`);
  if (refl.length) console.log(`  ${C.b}belief (reflection) in play:${C.off} ${C.grn}${refl[refl.length - 1].text.slice(0, 220)}${C.off}`);
  console.log(`  ${C.dim}↳ reconstructed from the memory stream — the literal retrieved set isn't traced for this tick (run with traces on for the exact set)${C.off}`);
}

// ── 2. REASONING + ACTIONS, interleaved in turn order (the live "conversation") ─────────────────────────
console.log(`\n${rule("② REASONING → ACTIONS (the decision unfolding)")}`);
let step = 0;
for (const r of recs) {
  if (r.type === "assistant" && Array.isArray(r.msg?.message?.content)) {
    for (const b of r.msg.message.content) {
      if (b?.type === "text" && b.text?.trim()) {
        console.log(`  ${C.grn}🗣${C.off}  ${b.text.trim()}`);
      } else if (b?.type === "thinking" && b.thinking?.trim()) {
        console.log(`  ${C.dim}💭 ${b.thinking.trim().slice(0, 200)}${C.off}`);
      } else if (b?.type === "tool_use") {
        const name = String(b.name ?? "").replace(/^mcp__world__/, "");
        if (name === "ToolSearch") continue; // the deferred-tool re-selection — noise; collapse it
        step++;
        const inp = JSON.stringify(b.input ?? {});
        console.log(`  ${C.blu}🔧 ${name}${C.off}(${inp.length > 180 ? inp.slice(0, 180) + "…" : inp})`);
      }
    }
  }
  if (r.type === "user" && Array.isArray(r.msg?.message?.content)) {
    for (const b of r.msg.message.content) {
      if (b?.type === "tool_result") {
        // surface the world tool's JSON reply (the perception/outcome the agent then reacted to)
        const c = Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? "").join("") : String(b.content ?? "");
        const txt = c.replace(/\s+/g, " ").trim();
        if (txt && !txt.startsWith("[{") /* skip the tool_reference echoes */) {
          console.log(`     ${C.dim}↳ result: ${txt.slice(0, 160)}${C.off}`);
        }
      }
    }
  }
  if (r.type === "result") {
    const m = r.msg ?? {};
    const denials = (m.permission_denials ?? []).length;
    console.log(
      `  ${m.is_error && m.subtype !== "success" ? C.red + "✗" : C.grn + "✓"} ${m.subtype}${C.off}` +
        ` ${C.dim}· ${m.num_turns} turns · notional $${m.total_cost_usd ?? "?"}${denials ? ` · ${C.red}${denials} GUARD veto(es)${C.off}` : ""}${C.dim}${C.off}`,
    );
  }
}

// ── 3. MEMORY WRITES this decision produced ─────────────────────────────────────────────────────────────
// The loop calls mind.observe("I decided: …") + maybeReflect after the ACT turn. Show the "I decided:" memory
// (and any reflection) that this tick most plausibly produced (the newest such, by game-min order).
console.log(`\n${rule("③ MEMORY WRITTEN BACK (what it remembered from this)")}`);
const decided = obs.filter((m) => m.text.startsWith("I decided:"));
if (decided.length) {
  console.log(`  ${C.mag}⊕ observation:${C.off} ${decided[decided.length - 1].text.slice(0, 240)}`);
} else {
  console.log(`  ${C.dim}(no "I decided:" memory matched — the narration may have been empty this tick)${C.off}`);
}
console.log(`  ${C.dim}total stream now: ${obs.length} obs · ${refl.length} reflections · ${plans.length} plans${C.off}`);

// ── raw dump (optional) ─────────────────────────────────────────────────────────────────────────────────
if (raw) {
  console.log(`\n${rule("RAW RECORD SEQUENCE")}`);
  for (const r of recs) console.log(`  ${C.dim}${r.ts ?? ""}${C.off} ${r.type}`);
}

console.log(`\n${C.dim}Full pretty stream:  grep '\\[${id} t${tick}\\]' sim/data/agents/${id}.log${C.off}`);
console.log(`${C.dim}Inner life:          npm run inspect -- ${id}${C.off}`);
