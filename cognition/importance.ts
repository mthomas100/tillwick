import { type Complete } from "./llm.js";

// POIGNANCY SCORING (Park et al., Generative Agents, UIST '23, §4.1) — the LLM rates how important a memory
// is, 1 (mundane: brushing teeth, making a bed) to 10 (poignant: a breakup, a fire, a sale that changes the
// day). Retrieval weights this; reflection sums it to decide when to reflect. The paper scores poignancy at
// memory-CREATION; Mind calls this from observe() when no explicit importance is supplied.
//
// SEAM DISCIPLINE (llm.ts, INC-2026-06-18): takes the INJECTED `Complete` — NO SDK import, free + determin-
// istic under stubComplete in tests. DEGRADE-DON'T-DIE: a thrown/empty/garbled completion → a LOW default
// (2), never throws into a tick. Low (not high) on failure so a model hiccup can't make everything look
// poignant and spuriously trip the reflection threshold.

export const DEFAULT_IMPORTANCE = 2; // mundane-ish fallback when the model can't be parsed
export const MIN_IMPORTANCE = 1;
export const MAX_IMPORTANCE = 10;

/**
 * Score a memory's poignancy 1..10 via the model (the paper's literal prompt). Parses the first integer in
 * the reply and clamps to 1..10. On any failure (throw, empty, no integer) returns DEFAULT_IMPORTANCE.
 */
export async function scoreImportance(complete: Complete, memoryText: string): Promise<number> {
  const text = (memoryText || "").trim();
  if (!text) return DEFAULT_IMPORTANCE;

  // The paper's poignancy prompt (App. A), verbatim in spirit: anchor both ends of the scale, ask for a
  // single integer rating.
  const prompt =
    `On the scale of 1 to 10, where 1 is purely mundane (e.g., brushing teeth, making bed) and 10 is ` +
    `extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the ` +
    `following piece of memory.\nMemory: ${text}\nRating (return ONLY the integer):`;

  let raw = "";
  try {
    raw = await complete(prompt, {
      system: "You rate the poignancy of a memory as a single integer from 1 to 10. Output only the number.",
      maxTokens: 8,
    });
  } catch {
    return DEFAULT_IMPORTANCE; // model hiccup → mundane default (degrade-don't-die)
  }
  return parseRating(raw);
}

// Pull the first integer out of the reply and clamp to 1..10. "7", "Rating: 7", "7/10", "I'd say 8." all
// work; no integer → the low default.
export function parseRating(raw: string): number {
  if (!raw) return DEFAULT_IMPORTANCE;
  const m = raw.match(/\d{1,2}/);
  if (!m) return DEFAULT_IMPORTANCE;
  const n = parseInt(m[0], 10);
  if (!Number.isFinite(n)) return DEFAULT_IMPORTANCE;
  return Math.max(MIN_IMPORTANCE, Math.min(MAX_IMPORTANCE, n));
}
