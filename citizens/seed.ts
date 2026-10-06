import { type MemoryStream } from "../cognition/memory-stream.js";
import { type Persona } from "./personas.js";

// SEED LOADER (Park et al., Generative Agents §3.1 — the John Lin seed paragraph). On a citizen's FIRST boot,
// write each line of its persona's `seedMemories` into the agent's MemoryStream as a real observation, so the
// agent starts grounded: retrieval, the [Agent's Summary Description] (summary.ts), dialogue, and the
// relationship graph all have its occupation / dispositions / who-it-knows from tick 1 — instead of an empty
// stream that yields generic merchant-speak.
//
// ZERO TOKENS: importance is supplied EXPLICITLY (a seed fact's poignancy is known design-side), so this never
// calls scoreImportance / the model — exactly the token-free path Mind.observe takes when given an importance.
//
// IDEMPOTENT ON RESUME (the program's durability rule — don't re-seed every boot): each seed memory is written
// with a DETERMINISTIC id (`seed:<agentId>:<n>`). The MemoryStream LOADS its prior file on construction, so a
// restart already has the seeds; we check `stream.get(id)` and SKIP any that are present. This is also
// self-healing: a run interrupted mid-seed completes the remainder next boot (no duplicate, no gap). Writes
// are best-effort (MemoryStream.add swallows disk errors) — seeding must never crash a boot.

export type SeedResult = {
  seeded: number; // newly written this boot
  skipped: number; // already present (a resume) — left untouched
};

// Stable id for the n-th seed of an agent (0-based). Sanitized like the stream's own ids can't escape a path,
// but these are pure ids (never filenames), so the only requirement is determinism + uniqueness per agent.
export function seedId(agentId: string, n: number): string {
  return `seed:${agentId}:${n}`;
}

// Default poignancy for a seed fact: mid-high. These are core, identity-defining facts (occupation, key
// relationships, dispositions) — they SHOULD surface in the identity/occupation facet retrievals (summary.ts)
// — but they aren't dramatic events, so we don't pin them at the top of the 1..10 scale.
const DEFAULT_SEED_IMPORTANCE = 6;

/**
 * Seed `persona.seedMemories` into `stream` as observations, once. Idempotent: re-running (a resume) re-writes
 * nothing already present. Returns how many were newly seeded vs skipped. Best-effort + token-free (explicit
 * importance ⇒ no model call). `atGameMin` stamps the seeds (use the boot game-minute, typically 0 at day
 * start); `importance` overrides the per-seed poignancy if a caller wants to tune it.
 */
export function seedAgentMemories(
  stream: MemoryStream,
  persona: Persona,
  opts: { atGameMin: number; importance?: number },
): SeedResult {
  const importance = opts.importance ?? DEFAULT_SEED_IMPORTANCE;
  let seeded = 0;
  let skipped = 0;
  persona.seedMemories.forEach((raw, n) => {
    const text = (raw || "").trim();
    if (!text) return; // skip a blank line rather than seed an empty memory
    const id = seedId(stream.agentId, n);
    if (stream.get(id)) {
      skipped++;
      return; // already seeded (a resume) — leave it exactly as it was
    }
    try {
      stream.add({ id, kind: "observation", text, importance, createdAt: opts.atGameMin });
      seeded++;
    } catch {
      /* best-effort: a disk hiccup on one seed shouldn't abort the rest or crash the boot */
    }
  });
  return { seeded, skipped };
}
