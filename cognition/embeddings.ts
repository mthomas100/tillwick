// Local on-box text embeddings — the relevance signal for memory retrieval (docs/design/architecture.md §2,
// "relevance = cosine of local embeddings"; paper §4.1, Fig 6). Runs a small sentence model entirely
// on-box via transformers.js: NO API key, NO token cost, NO network at inference time.
//
// WHY LOCAL (INC-2026-06-18): retrieval runs for every memory on every tick, so its semantic relevance
// is computed here, for free, on the box, instead of through any hosted embedding API.
//
// Model: Xenova/all-MiniLM-L6-v2 — 384-dim, mean-pooled + L2-normalized sentence embeddings (~97MB
// one-time download, cached to disk). First call initializes (~15s cold / ~80ms warm); subsequent
// calls embed in a few ms and are fully offline.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The model this module is pinned to. 384-dim output (see EMBED_DIM).
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Dimensionality of the vectors returned by {@link embed} / {@link embedBatch}. */
export const EMBED_DIM = 384;

// Cache the downloaded model on-box, out of git. sim/data/ is already gitignored and is where the
// rest of the durable runtime state lives, so the model is shared across all citizen processes and
// downloaded at most once per machine.
const __dir = dirname(fileURLToPath(import.meta.url));
const MODEL_CACHE_DIR = join(__dir, "..", "sim", "data", "models");

// transformers.js types its feature-extraction pipeline as a broad union; we only need a callable
// that returns something with a Float32Array-ish `.data`. Keep the surface minimal and local.
type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

// Lazy singleton. The first embed() call triggers the (cached) model load; we memoize the in-flight
// promise so concurrent callers share one initialization rather than racing N downloads.
let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    let mod: typeof import("@huggingface/transformers");
    try {
      mod = await import("@huggingface/transformers");
    } catch (err) {
      // Degrade gracefully: a load failure here must surface a clear error to the caller, never
      // crash the process at import time (this module is imported eagerly by retrieval).
      extractorPromise = null; // allow a later retry
      throw new Error(
        `[embeddings] failed to load @huggingface/transformers — local embeddings unavailable. ` +
          `Is the dependency installed? Original error: ${(err as Error)?.message ?? err}`,
      );
    }

    // Keep the model on-box and offline. allowRemoteModels stays true so the very first run can
    // fetch the weights into MODEL_CACHE_DIR; every run after that is served from disk.
    mod.env.cacheDir = MODEL_CACHE_DIR;
    mod.env.allowLocalModels = true;

    try {
      const extractor = (await mod.pipeline("feature-extraction", MODEL_ID)) as unknown as FeatureExtractor;
      return extractor;
    } catch (err) {
      extractorPromise = null; // allow a later retry (e.g. transient first-run download failure)
      throw new Error(
        `[embeddings] failed to initialize model "${MODEL_ID}": ${(err as Error)?.message ?? err}`,
      );
    }
  })();
  return extractorPromise;
}

/**
 * Embed a single string into a 384-dim, L2-normalized vector. The first call lazily loads the model
 * (cold ~15s incl. one-time download; warm ~80ms); subsequent calls are a few ms and fully offline.
 * Throws a clear error if the model cannot be loaded — it never crashes the process at import.
 */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/**
 * Embed many strings in one model call. Returns one 384-dim vector per input, in order. More
 * efficient than mapping {@link embed} over an array (single tokenization + forward pass).
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // For a batch, transformers.js returns a flat [n * dim] tensor; slice it back into rows.
  const flat = Array.from(out.data);
  const dim = flat.length / texts.length;
  const rows: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return rows;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. For the normalized vectors this module
 * produces this is just the dot product, but we compute the full form so it stays correct for any
 * input (and returns 0 for a zero vector rather than NaN).
 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
