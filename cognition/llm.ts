// The LLM-completion seam for cognition modules.
//
// Reflection, planning, agent-summary, and importance-scoring all need to call a model — but they MUST be
// testable without spending tokens (INC-2026-06-18: zero spend at build/test). So they take an injected
// `Complete` function instead of importing the SDK directly. The real Claude-backed `Complete` is wired at
// INTEGRATION (W1-integrate) inside the citizen runtime (auth per citizens/auth.ts, per-agent
// model). At build/unit-test time, inject `stubComplete`.

export type CompleteOpts = { system?: string; maxTokens?: number; model?: string };

/** Single-shot text completion. Returns the model's text. Implementations must never throw into a tick —
 *  callers treat a thrown/empty result as "no output" and degrade (the world-tools degrade-don't-die rule). */
export type Complete = (prompt: string, opts?: CompleteOpts) => Promise<string>;

/** Deterministic stub for unit tests — ZERO tokens. `canned` is returned verbatim, or called per-prompt. */
export function stubComplete(canned: string | ((prompt: string, opts?: CompleteOpts) => string)): Complete {
  return async (prompt, opts) => (typeof canned === "function" ? canned(prompt, opts) : canned);
}
