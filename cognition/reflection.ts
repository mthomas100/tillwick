import { MemoryStream, type MemoryObject } from "./memory-stream.js";
import { retrieve, type ScoredMemory } from "./retrieval.js";
import { type Complete } from "./llm.js";

// REFLECTION TREES (Park et al., Generative Agents, UIST '23, §4.2, Fig 7) — periodically the agent pauses
// to synthesize higher-level INSIGHTS from its raw memories, and stores them back as `reflection` memories
// that future retrieval can surface (and that later reflections can cite — the "tree").
//
// THE LOOP (the paper):
//   1. shouldReflect → fire when the summed importance of memories since the last reflection crosses a
//      threshold (~150; the paper reflects ~2–3×/day).
//   2. ask the model for the 3 most salient high-level QUESTIONS about the recent memories.
//   3. retrieve evidence per question (recency·importance·relevance top-k).
//   4. ask the model to extract ~5 INSIGHTS, each citing the evidence it rests on ("insight (because of
//      1, 5, 3)").
//   5. store each insight as a reflection memory with its citation ids.
//
// COST DISCIPLINE (INC-2026-06-18): the model is the INJECTED `Complete` seam (llm.ts) — NO SDK import, NO
// model call at build/test (unit-tested with stubComplete → zero tokens). Importance of a reflection is a
// fixed default here (REFLECTION_IMPORTANCE); the LLM poignancy scorer is wired separately at integration.
// Everything degrades rather than throws into a tick: a blank/garbled completion yields no reflections.

export const DEFAULT_REFLECT_THRESHOLD = 150; // summed-importance trigger (the paper's ~150)
export const DEFAULT_RECENT_N = 100; // how many recent memories seed the salient-questions prompt
export const DEFAULT_PER_QUESTION_K = 15; // evidence retrieved per question
export const DEFAULT_QUESTION_COUNT = 3; // salient questions to ask for
export const DEFAULT_INSIGHT_COUNT = 5; // insights to extract
export const REFLECTION_IMPORTANCE = 6; // v1: fixed poignancy for a reflection (LLM scorer wired later)

// ---- the trigger ---------------------------------------------------------------------------------------

// Sum the importance of memories created since the last reflection (or since opts.sinceGameMin, if given).
// > threshold ⇒ time to reflect. "Since the last reflection" = createdAt strictly after the newest existing
// reflection's createdAt; with no prior reflection, the whole stream counts (the first reflection).
export function shouldReflect(
  stream: MemoryStream,
  opts: { threshold?: number; sinceGameMin?: number } = {},
): boolean {
  const threshold = opts.threshold ?? DEFAULT_REFLECT_THRESHOLD;
  const since = opts.sinceGameMin ?? lastReflectionAt(stream);
  let sum = 0;
  for (const m of stream.all()) {
    if (m.createdAt > since) sum += m.importance;
  }
  return sum > threshold;
}

// createdAt of the most recent reflection, or -Infinity if the agent has never reflected (so everything
// counts toward the first reflection).
function lastReflectionAt(stream: MemoryStream): number {
  let at = -Infinity;
  for (const m of stream.all()) {
    if (m.kind === "reflection" && m.createdAt > at) at = m.createdAt;
  }
  return at;
}

// ---- the reflection step -------------------------------------------------------------------------------

export type ReflectOpts = {
  nowGameMin: number; // game-time stamped on the created reflections + used for retrieval recency
  recentN?: number; // recent memories to consider for the salient questions (default 100)
  perQuestionK?: number; // evidence retrieved per question (default 15)
  questionCount?: number; // salient questions to request (default 3)
  insightCount?: number; // insights to request (default 5)
  importance?: number; // poignancy to stamp on each reflection (default REFLECTION_IMPORTANCE)
};

/**
 * Run one reflection pass: salient questions → retrieved evidence → cited insights → stored as reflection
 * memories. Returns the reflection MemoryObjects created (possibly empty if the model produced nothing
 * usable). Never throws into a tick — a thrown/blank completion degrades to "no reflections this pass".
 */
export async function reflect(stream: MemoryStream, complete: Complete, opts: ReflectOpts): Promise<MemoryObject[]> {
  const now = opts.nowGameMin;
  const recentN = opts.recentN ?? DEFAULT_RECENT_N;
  const perQuestionK = opts.perQuestionK ?? DEFAULT_PER_QUESTION_K;
  const questionCount = opts.questionCount ?? DEFAULT_QUESTION_COUNT;
  const insightCount = opts.insightCount ?? DEFAULT_INSIGHT_COUNT;
  const importance = opts.importance ?? REFLECTION_IMPORTANCE;

  const recent = stream.recent(recentN);
  if (recent.length === 0) return [];

  // (2) salient high-level questions about the recent memories
  let questions: string[];
  try {
    const qText = await complete(questionsPrompt(recent, questionCount), {
      system: "You are the reflective faculty of a simulated person. Output only the questions, one per line.",
    });
    questions = parseLines(qText).slice(0, questionCount);
  } catch {
    return []; // model unavailable → no reflection this pass (degrade, don't die)
  }
  if (questions.length === 0) return [];

  // (3) retrieve evidence per question; collect a single de-duplicated, ORDERED evidence list so insight
  // citations can reference a stable 1-based index (the paper's "(because of 1, 5, 3)").
  const evidence: MemoryObject[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    let scored: ScoredMemory[] = [];
    try {
      scored = await retrieve(stream, q, { k: perQuestionK, nowGameMin: now });
    } catch {
      scored = []; // a retrieval hiccup on one question shouldn't sink the pass
    }
    for (const s of scored) {
      if (!seen.has(s.memory.id)) {
        seen.add(s.memory.id);
        evidence.push(s.memory);
      }
    }
  }
  if (evidence.length === 0) return [];

  // (4) extract insights, each citing evidence by its 1-based index
  let insights: { text: string; citeIdx: number[] }[];
  try {
    const iText = await complete(insightsPrompt(evidence, insightCount), {
      system:
        "You are the reflective faculty of a simulated person. For each insight cite the statements it is " +
        'based on as "(because of 1, 4, 9)" using the numbers above. Output one insight per line.',
    });
    insights = parseInsights(iText).slice(0, insightCount);
  } catch {
    return [];
  }
  if (insights.length === 0) return [];

  // (5) store each insight as a reflection memory, resolving citation indices → memory ids
  const created: MemoryObject[] = [];
  for (const ins of insights) {
    if (!ins.text) continue;
    const citations = ins.citeIdx
      .filter((n) => n >= 1 && n <= evidence.length)
      .map((n) => evidence[n - 1].id);
    const ref = stream.add({
      kind: "reflection",
      text: ins.text,
      importance,
      createdAt: now,
      ...(citations.length ? { citations: dedupe(citations) } : {}),
    });
    created.push(ref);
  }
  return created;
}

// ---- prompts -------------------------------------------------------------------------------------------

function questionsPrompt(recent: MemoryObject[], n: number): string {
  const statements = recent.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
  return [
    `Given only the following statements about a person, what are the ${n} most salient high-level`,
    `questions we can answer about the subject's life, relationships, work, and circumstances?`,
    ``,
    `Statements:`,
    statements,
    ``,
    `List exactly ${n} questions, one per line, no numbering.`,
  ].join("\n");
}

function insightsPrompt(evidence: MemoryObject[], n: number): string {
  const numbered = evidence.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
  return [
    `Statements about the subject (numbered):`,
    numbered,
    ``,
    `What are the ${n} most important high-level insights you can infer from the statements above?`,
    `Each insight must cite the statement numbers it is based on, in the form:`,
    `  <insight> (because of 1, 5, 9)`,
    `Output exactly ${n} insights, one per line.`,
  ].join("\n");
}

// ---- parsing -------------------------------------------------------------------------------------------

// Split a completion into clean lines: drop blanks, strip leading list markers ("1.", "- ", "* ", "Q: ").
function parseLines(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s*/, "").replace(/^Q:\s*/i, "").trim();
    if (line) out.push(line);
  }
  return out;
}

// Parse insight lines, splitting off a trailing "(because of 1, 5, 3)" citation clause into indices. The
// insight text has the clause removed; missing/garbled clauses just yield no citations.
function parseInsights(text: string): { text: string; citeIdx: number[] }[] {
  const out: { text: string; citeIdx: number[] }[] = [];
  for (const line of parseLines(text)) {
    const m = line.match(/\(\s*because of\s*([0-9,\s]+)\)\s*$/i);
    let body = line;
    let citeIdx: number[] = [];
    if (m) {
      body = line.slice(0, m.index).trim().replace(/[—,:;-]\s*$/, "").trim();
      citeIdx = m[1]
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    if (body) out.push({ text: body, citeIdx });
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
