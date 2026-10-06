import { embed, embedBatch, cosine } from "./embeddings.js";
import type { MemoryObject, MemoryStream } from "./memory-stream.js";

// MEMORY RETRIEVAL (Park et al., Generative Agents, UIST '23, §4.1, Fig 6) — the function that, given a
// query, returns the top-k memories to feed a prompt. Reflection / planning / dialogue all call this.
//
// The paper's score is a weighted sum of three signals, each min-max normalized to [0,1] across the
// candidate set, then combined (all weights 1 in the paper):
//     score = α_recency·recency + α_importance·importance + α_relevance·relevance
//   • recency    = decay^(game-hours since last access), decay = 0.995 → older, untouched memories fade.
//   • importance = the 1..10 poignancy stored on the memory (scored externally), divided by 10.
//   • relevance  = cosine(query embedding, memory embedding) — semantic closeness via LOCAL embeddings.
//
// COST DISCIPLINE: relevance uses cognition/embeddings.ts (on-box, no API key, no token spend). Embeddings
// are computed lazily and CACHED back into the stream (setEmbedding) so a restart doesn't re-embed history.
// If the local model can't load, retrieval DEGRADES to recency+importance (relevance=0) rather than crash a
// tick — the repo's "degrade, don't die" rule (world-tools.ts getJson, run-state.ts best-effort).
//
// Retrieval is the one place that bumps lastAccess: calling retrieve() touches the returned memories so
// their recency refreshes (the paper's "last accessed" timestamp).

export const RECENCY_DECAY = 0.995; // per game-hour, per the design (exp decay over game-hours)
export const IMPORTANCE_MAX = 10; // poignancy scale is 1..10

// Equal weights = the paper's default. Exposed so callers (e.g. a "what's relevant to X" vs. a "what's on
// my mind" query) can retune without forking the scorer.
export type RetrievalWeights = { recency: number; importance: number; relevance: number };
export const DEFAULT_WEIGHTS: RetrievalWeights = { recency: 1, importance: 1, relevance: 1 };

// A candidate memory with its retrieval breakdown — components are the NORMALIZED [0,1] values that went
// into `score`, so callers can inspect/debug why something ranked where it did.
export type ScoredMemory = {
  memory: MemoryObject;
  score: number;
  recency: number; // normalized [0,1]
  importance: number; // normalized [0,1]
  relevance: number; // normalized [0,1]
};

export type RetrieveOpts = {
  k?: number; // how many to return (default 10)
  nowGameMin: number; // current sim time (game-minutes) — recency is measured from here
  weights?: RetrievalWeights;
  touch?: boolean; // bump lastAccess on the returned memories (default true; the paper does)
  candidates?: MemoryObject[]; // restrict the pool (e.g. only observations); default = the whole stream
};

// recency = decay^(game-hours since last access). atGameMin >= lastAccess in normal use; a tiny negative
// gap (clock skew) is clamped to 0 so recency never exceeds 1.
export function recencyScore(lastAccessGameMin: number, nowGameMin: number, decay = RECENCY_DECAY): number {
  const gameHours = Math.max(0, (nowGameMin - lastAccessGameMin) / 60);
  return Math.pow(decay, gameHours);
}

// Min-max scale a list to [0,1]. A flat list (all equal, incl. a single element) maps to all-1 — every
// candidate is equally (un)distinguished on that axis, so it contributes a constant and doesn't skew the
// ranking. (The paper min-max scales each component; this is that scaler.)
export function minMax(xs: number[]): number[] {
  if (xs.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const span = hi - lo;
  if (span <= 0) return xs.map(() => 1);
  return xs.map((x) => (x - lo) / span);
}

// Ensure every candidate has a cached embedding: embed the ones that don't (one batched model call) and
// write them back into the stream so they persist. Returns id -> vector for the whole candidate set.
// Throws only if the local model can't load at all; retrieve() catches that and degrades.
async function ensureEmbeddings(stream: MemoryStream, candidates: MemoryObject[]): Promise<Map<string, number[]>> {
  const vecById = new Map<string, number[]>();
  const missing: MemoryObject[] = [];
  for (const m of candidates) {
    if (m.embedding && m.embedding.length) vecById.set(m.id, m.embedding);
    else missing.push(m);
  }
  if (missing.length) {
    const vecs = await embedBatch(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++) {
      const v = vecs[i];
      vecById.set(missing[i].id, v);
      stream.setEmbedding(missing[i].id, v); // cache for next time (persisted, best-effort)
    }
  }
  return vecById;
}

/**
 * Retrieve the top-k memories for `query` from a MemoryStream, by the paper's recency·importance·relevance
 * score. Bumps lastAccess on the returned memories (unless opts.touch === false). Async because relevance
 * embeds the query + any un-embedded candidates locally. Never throws on an embedding failure — it falls
 * back to recency+importance (relevance contributes 0).
 */
export async function retrieve(stream: MemoryStream, query: string, opts: RetrieveOpts): Promise<ScoredMemory[]> {
  const k = Math.max(0, opts.k ?? 10);
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const now = opts.nowGameMin;
  const candidates = opts.candidates ?? stream.all();
  if (candidates.length === 0 || k === 0) return [];

  // --- relevance (best-effort; degrade to 0 if local embeddings are unavailable) ---
  let rawRelevance: number[];
  try {
    const qVec = await embed(query);
    const vecById = await ensureEmbeddings(stream, candidates);
    rawRelevance = candidates.map((m) => {
      const v = vecById.get(m.id);
      return v ? cosine(qVec, v) : 0;
    });
  } catch {
    // local model couldn't load → relevance is uniform 0; ranking falls back to recency + importance.
    rawRelevance = candidates.map(() => 0);
  }

  // --- recency + importance ---
  const rawRecency = candidates.map((m) => recencyScore(m.lastAccess, now));
  const rawImportance = candidates.map((m) => m.importance / IMPORTANCE_MAX);

  // --- min-max normalize each component, then weighted sum (the paper, Fig 6) ---
  const nRec = minMax(rawRecency);
  const nImp = minMax(rawImportance);
  const nRel = minMax(rawRelevance);

  const scored: ScoredMemory[] = candidates.map((m, i) => ({
    memory: m,
    recency: nRec[i],
    importance: nImp[i],
    relevance: nRel[i],
    score: w.recency * nRec[i] + w.importance * nImp[i] + w.relevance * nRel[i],
  }));

  // top-k by score; tie-break newer-first (createdAt) so a tie surfaces the fresher memory.
  scored.sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt);
  const top = scored.slice(0, k);

  if (opts.touch !== false && top.length) {
    stream.touch(
      top.map((s) => s.memory.id),
      now,
    );
  }
  return top;
}
