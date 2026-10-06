import { MemoryStream, type MemoryObject } from "./memory-stream.js";
import { retrieve } from "./retrieval.js";
import { type Complete } from "./llm.js";

// HIERARCHICAL PLANNING + REACT/RE-PLAN (Park et al., Generative Agents, UIST '23, §4.3) — the third
// leg of the cognitive core. Plans are first-class memory objects (kind:"plan"): the agent recursively
// turns its summary + yesterday into a broad daily agenda, decomposes chunks finer (daily → hourly →
// 5–15 min), and when a salient observation lands it decides react-vs-continue and, on react,
// regenerates the plan from now forward (§4.3.1).
//
// SAME DISCIPLINE AS reflection/summary: this module takes an INJECTED `Complete` (llm.ts seam) and
// never imports the SDK / never calls a real model at build — unit-tested with `stubComplete` for ZERO
// token spend (INC-2026-06-18). Every LLM call DEGRADES: a thrown/empty completion yields an empty plan
// (planDay/decompose return []) or "don't react" (reactAndMaybeReplan) rather than crashing a tick (the
// repo's degrade-don't-die rule).
//
// Plans live in the SAME stream as observations/reflections so retrieval can surface "what was I going to
// do?" beside "what did I see". A plan's importance is fixed (the paper scores poignancy on observations,
// not on the agent's own agenda) at PLAN_IMPORTANCE — high enough to compete in retrieval, not so high it
// drowns genuine events.

// Plans matter for "what am I doing next" but aren't the dramatic life-events the 1–10 poignancy scale is
// for; 6 keeps them retrievable without crowding out a real observation. Fixed (not LLM-scored) — one
// fewer model call per plan, and the agent's own intent doesn't need poignancy judged.
export const PLAN_IMPORTANCE = 6;

// Daily plan target band (the paper's "5–8 broad-strokes" agenda). We don't hard-truncate the model — we
// ask for this many and store whatever well-formed lines come back — but we cap absurd output so one bad
// completion can't flood the stream.
const DAILY_TARGET_MIN = 5;
const DAILY_TARGET_MAX = 8;
const MAX_PLAN_LINES = 40; // hard ceiling across any single planning call (decompose can be finer-grained)

// How many relevant memories to pull into the react prompt (the paper retrieves context before deciding).
const REACT_CONTEXT_K = 10;

/**
 * Broad-strokes DAILY PLAN (§4.3). Prompt `complete` with the agent summary + an optional previous-day
 * summary → a 5–8 chunk agenda, each a single line carrying a time + intended action/location. Each line
 * is stored as a plan memory (kind:"plan") via stream.add and the stored memories are returned in order.
 *
 * Degrades: an empty/whitespace/throwing completion → [] (nothing stored), so a model hiccup can't wedge
 * the day.
 */
export async function planDay(
  stream: MemoryStream,
  complete: Complete,
  opts: { nowGameMin: number; agentSummary: string; previousDaySummary?: string; buildings?: { workId: string; homeId: string; hangoutId: string } },
): Promise<MemoryObject[]> {
  const prev = opts.previousDaySummary?.trim()
    ? `\nYesterday, in broad strokes: ${opts.previousDaySummary.trim()}`
    : "";
  // A1: name the agent's REAL buildings (resolved from world.json by building-map.ts) so the agenda lines name
  // concrete locations currentStep()/the ACT loop can move() to — instead of generic "at home"/"at the shop"
  // that the world has no id for. The model is told to USE these exact ids in the place part of each line.
  const b = opts.buildings;
  const placeGuide = b
    ? `\nYour places (use these exact building ids in the agenda): you work/spend the day at "${b.workId}", ` +
      `you live and sleep at "${b.homeId}", and you relax off-hours at "${b.hangoutId}". A believable day is ` +
      `roughly: morning at or heading to "${b.workId}", the bulk of the day there, then "${b.hangoutId}" or ` +
      `errands, and home to "${b.homeId}" by night.\n`
    : "";
  const example = b
    ? `(e.g. "7:00am — wake up at ${b.homeId}", "8:00am — go to ${b.workId} and start work", "6:00pm — relax at ${b.hangoutId}", "10:00pm — head home to ${b.homeId}")`
    : `(e.g. "7:00am — wake up and make breakfast at home")`;
  const prompt =
    `${opts.agentSummary.trim()}\n${prev}\n${placeGuide}\n` +
    `In broad strokes, what is this agent's plan for today? Write a rough daily agenda as ` +
    `${DAILY_TARGET_MIN}–${DAILY_TARGET_MAX} lines, one per line, each beginning with a time and naming ` +
    `the intended action and the building id of the place ${example}. ` +
    `List only the agenda lines, in chronological order, no preamble.`;

  const lines = await completeToLines(complete, prompt, {
    system: "You write concise daily plans for a character in a simulated town. Output only the agenda lines.",
    maxTokens: 400,
  });
  // store each agenda line as a plan memory, in order
  return lines.map((text) =>
    stream.add({ kind: "plan", text, createdAt: opts.nowGameMin, importance: PLAN_IMPORTANCE }),
  );
}

/**
 * Recursively DECOMPOSE a plan chunk into finer sub-plans (§4.3: daily → hourly → 5–15 min). `granularityMin`
 * is the target granularity of the children (e.g. 60 to break a day into hours, 15 to break an hour into
 * quarter-hours). The finer plans are stored (kind:"plan", citing the parent) and returned.
 *
 * Degrades: empty/throwing completion → [] (the parent stands as-is).
 */
export async function decompose(
  parent: MemoryObject,
  stream: MemoryStream,
  complete: Complete,
  opts: { nowGameMin: number; granularityMin: number },
): Promise<MemoryObject[]> {
  const gran = Math.max(1, Math.round(opts.granularityMin));
  const prompt =
    `A character in a simulated town has this plan step:\n"${parent.text.trim()}"\n\n` +
    `Break it into a finer-grained sequence of sub-steps, each covering about ${gran} minutes. ` +
    `Write one sub-step per line, each beginning with a time and naming the concrete action and place. ` +
    `List only the sub-step lines, in chronological order, no preamble.`;

  const lines = await completeToLines(complete, prompt, {
    system: "You decompose a plan step into finer concrete sub-steps. Output only the sub-step lines.",
    maxTokens: 500,
  });
  // children cite the parent plan id (the paper's plan tree) so a later reflection/retrieval can trace lineage
  return lines.map((text) =>
    stream.add({
      kind: "plan",
      text,
      createdAt: opts.nowGameMin,
      importance: PLAN_IMPORTANCE,
      citations: [parent.id],
    }),
  );
}

/**
 * REACT / RE-PLAN on a new observation (§4.3.1). Retrieve relevant context, then ask the paper's literal
 * question — "Should [agent] react to the observation, and if so, what would be an appropriate reaction?"
 * — and parse a react/continue decision. If the agent reacts, REGENERATE the plan from `nowGameMin`
 * forward (a fresh daily-style agenda seeded by the reaction) and store+return those plan memories.
 *
 * Returns { react, suggestion?, replanned? }. Degrades: a throwing/empty decision → { react:false } (the
 * agent keeps its current plan) — never crash the tick.
 */
export async function reactAndMaybeReplan(
  stream: MemoryStream,
  complete: Complete,
  observation: string,
  opts: { nowGameMin: number; agentSummary: string },
): Promise<{ react: boolean; suggestion?: string; replanned?: MemoryObject[] }> {
  // retrieve context relevant to the observation first (the paper conditions the decision on memory).
  // retrieve() returns ScoredMemory[] (memory + its normalized recency/importance/relevance breakdown); we
  // only need the texts here. Best-effort: a retrieval/embedding failure must not block the decision.
  let context: MemoryObject[] = [];
  try {
    const scored = await retrieve(stream, observation, { k: REACT_CONTEXT_K, nowGameMin: opts.nowGameMin });
    context = scored.map((s) => s.memory);
  } catch {
    context = [];
  }
  const ctx = context.length
    ? `\nRelevant context (the agent's memories):\n${context.map((m) => `- ${m.text}`).join("\n")}`
    : "";

  const decisionPrompt =
    `${opts.agentSummary.trim()}\n${ctx}\n\n` +
    `Observation: ${observation.trim()}\n\n` +
    `Should the agent react to the observation, and if so, what would be an appropriate reaction? ` +
    `Answer on a single first line with exactly "REACT" or "CONTINUE". If REACT, add a second line ` +
    `giving the appropriate reaction in one sentence.`;

  let raw = "";
  try {
    raw = await complete(decisionPrompt, {
      system:
        "You decide whether a character in a simulated town should interrupt their plan to react to what " +
        "they just observed. Be conservative: most observations do not warrant reacting.",
      maxTokens: 120,
    });
  } catch {
    return { react: false }; // model hiccup → keep the current plan
  }

  const decision = parseReaction(raw);
  if (!decision.react) return { react: false };

  // The agent reacts → regenerate the plan from now forward, seeded by the chosen reaction (§4.3.1
  // "regenerate the agent's existing plan ... from the time ... onward"). Reuses planDay's daily-agenda
  // shape with the reaction folded into the summary so the new agenda accounts for it.
  const seededSummary =
    `${opts.agentSummary.trim()}\n` +
    `Just now the agent observed: ${observation.trim()}\n` +
    (decision.suggestion ? `The agent has decided to: ${decision.suggestion}\n` : "") +
    `Re-plan the REST of the day from this moment forward, accounting for this.`;

  const replanned = await planDay(stream, complete, {
    nowGameMin: opts.nowGameMin,
    agentSummary: seededSummary,
  });
  return { react: true, suggestion: decision.suggestion, replanned };
}

// ---- internals ----

// Run a completion and split it into clean agenda/sub-step lines. Centralizes the degrade-and-parse used by
// planDay/decompose: empty/whitespace/throw → []; strips bullets/numbering; drops blanks; caps at
// MAX_PLAN_LINES so one runaway completion can't flood the stream.
async function completeToLines(
  complete: Complete,
  prompt: string,
  opts: { system: string; maxTokens: number },
): Promise<string[]> {
  let raw = "";
  try {
    raw = await complete(prompt, { system: opts.system, maxTokens: opts.maxTokens });
  } catch {
    return []; // a thrown completion = no plan (degrade-don't-die)
  }
  return toPlanLines(raw);
}

// Parse a completion into plan lines: split on newlines, strip leading bullets/numbering ("- ", "* ",
// "1. ", "1) "), trim, drop blanks, cap the count. Exported-adjacent logic kept private — callers only see
// MemoryObject[].
function toPlanLines(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const cleaned = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!cleaned) continue;
    out.push(cleaned);
    if (out.length >= MAX_PLAN_LINES) break;
  }
  return out;
}

// Parse the react decision. The first non-blank line carries the verdict; "REACT" (case-insensitive,
// anywhere in that line) → react, with the next non-blank line as the suggestion. Anything else (incl.
// "CONTINUE", empty) → don't react. Lenient on purpose: a model that answers "Yes, React." still counts.
function parseReaction(raw: string): { react: boolean; suggestion?: string } {
  if (!raw || !raw.trim()) return { react: false };
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { react: false };
  const verdict = lines[0].toLowerCase();
  // an explicit CONTINUE wins even if the word "react" appears later in the sentence
  if (/\bcontinue\b/.test(verdict) && !/\breact\b/.test(verdict)) return { react: false };
  if (!/\breact\b/.test(verdict)) return { react: false };
  const suggestion = lines[1]?.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
  return { react: true, ...(suggestion ? { suggestion } : {}) };
}
