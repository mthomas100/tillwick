import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The persistent MEMORY STREAM (Park et al., Generative Agents, UIST '23, §4.1) — the keystone of the
// cognitive core. A per-agent, append-only list of natural-language memory objects (observation |
// reflection | plan). Retrieval / reflection / planning all import these CANONICAL types from here.
//
// DELIBERATELY DUMB BY DESIGN:
//   • No LLM. Importance (the paper's 1–10 poignancy) is SCORED EXTERNALLY at runtime and INJECTED via
//     add({ importance }). This module never imports the SDK and never calls a model → zero token spend.
//   • Embeddings are STORED, not computed — retrieval fills/uses `embedding`; we just persist the vector.
//   • Time is GAME-minutes from the sim clock (run-state.ts `gameMinutes`), NOT wall time. The clock is
//     INJECTED (`opts.nowGameMin`) so this stays a pure data structure; a pure instance defaults to 0.
//
// DURABLE + RESUMABLE (the program's durability rule): each agent's stream is one JSONL file under
// sim/data/memory/<agentId>.jsonl (append-friendly, gitignored). Construction LOADS the existing file, so
// a sim restart resumes the agent's memories intact. Writes are BEST-EFFORT (like sim-server.ts / run-
// state.ts): a disk error is swallowed, never propagated — persistence must not crash the caller.

export type MemoryKind = "observation" | "reflection" | "plan";

export type MemoryObject = {
  id: string; // stable unique id
  kind: MemoryKind;
  text: string; // natural-language description
  createdAt: number; // GAME-minutes (from the sim clock), not wall time
  lastAccess: number; // GAME-minutes; updated on retrieval (touch)
  importance: number; // 1..10 (poignancy). SCORED EXTERNALLY — never computed here.
  embedding?: number[]; // optional cached vector (retrieval fills/uses it; we just store it)
  citations?: string[]; // reflections cite the memory ids that evidenced them
};

// On-disk / in-memory record = the public object + a stream-local sequence number. `_seq` gives recent()
// a deterministic tie-break for memories sharing a createdAt, and is stripped from every public return so
// MemoryObject stays exactly the pinned contract shape.
type Stored = MemoryObject & { _seq: number };

const HERE = dirname(fileURLToPath(import.meta.url)); // cognition/
const ROOT = dirname(HERE); // repo root
// sim/data/ is already gitignored (the sim runtime-data dir), so per-agent streams ride along untracked.
const DEFAULT_DIR = join(ROOT, "sim", "data", "memory");

export type MemoryStreamOpts = {
  dir?: string; // override the store directory (tests, harness); defaults to sim/data/memory
  nowGameMin?: () => number; // injected sim clock (game-minutes); defaults to () => 0 for a pure instance
};

export class MemoryStream {
  readonly agentId: string;
  private readonly file: string;
  private readonly nowGameMin: () => number;
  private readonly mems: Stored[] = [];
  private readonly byId = new Map<string, Stored>();
  private seq = 0; // monotonic per-stream counter → stable unique ids + stable tie-break ordering

  constructor(agentId: string, opts: MemoryStreamOpts = {}) {
    this.agentId = agentId;
    this.nowGameMin = opts.nowGameMin ?? (() => 0);
    // sanitize the id so it can't escape the dir / collide with a path separator
    const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "agent";
    this.file = join(opts.dir ?? DEFAULT_DIR, `${safe}.jsonl`);
    this.load();
  }

  // Append a memory. The caller supplies kind/text/createdAt/importance (+ optional embedding/citations);
  // id and lastAccess are filled if omitted (lastAccess defaults to createdAt — never accessed yet).
  add(m: Omit<MemoryObject, "id" | "lastAccess"> & { id?: string; lastAccess?: number }): MemoryObject {
    const createdAt = Number.isFinite(m.createdAt) ? m.createdAt : this.nowGameMin();
    const rec: Stored = {
      id: m.id ?? this.nextId(),
      kind: m.kind,
      text: m.text,
      createdAt,
      lastAccess: m.lastAccess ?? createdAt,
      importance: m.importance,
      ...(m.embedding ? { embedding: m.embedding } : {}),
      ...(m.citations ? { citations: m.citations } : {}),
      _seq: this.seq++,
    };
    this.mems.push(rec);
    this.byId.set(rec.id, rec);
    this.append(rec); // append-only on the happy path (no full rewrite)
    return strip(rec);
  }

  // Most-recent-first by createdAt; ties broken by insertion order (newest insertion first) so a burst of
  // memories at the same game-minute still returns deterministically newest-first.
  recent(n: number): MemoryObject[] {
    return this.mems
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt || b._seq - a._seq)
      .slice(0, Math.max(0, n))
      .map(strip);
  }

  all(): MemoryObject[] {
    return this.mems.map(strip);
  }

  get(id: string): MemoryObject | undefined {
    const m = this.byId.get(id);
    return m ? strip(m) : undefined;
  }

  // Bump lastAccess on retrieval (the paper's recency = decay since LAST access). Rewrites the file
  // best-effort (JSONL is append-only, so a mutation = a compacting rewrite).
  touch(ids: string[], atGameMin: number): void {
    let changed = false;
    for (const id of ids) {
      const m = this.byId.get(id);
      if (m && atGameMin > m.lastAccess) {
        m.lastAccess = atGameMin;
        changed = true;
      }
    }
    if (changed) this.rewrite();
  }

  // Cache a memory's embedding vector (retrieval computes it lazily and writes it back, so the stream
  // persists it and a restart doesn't re-embed the whole history). Additive: the `embedding` field was
  // always on MemoryObject for exactly this. Persists best-effort, like touch().
  setEmbedding(id: string, vec: number[]): void {
    const m = this.byId.get(id);
    if (!m) return;
    m.embedding = vec;
    this.rewrite();
  }

  size(): number {
    return this.mems.length;
  }

  // ---- internals ----

  private nextId(): string {
    // stream-local, stable, collision-free across a restart (seq is restored past the loaded max).
    return `${this.agentId}:m${this.seq}`;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = readFileSync(this.file, "utf8");
      if (!raw.trim()) return;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const o = JSON.parse(line) as Partial<Stored>;
          if (!o.id || !o.kind) continue; // skip a malformed/partial line
          const seq = typeof o._seq === "number" ? o._seq : this.seq;
          const rec: Stored = {
            id: o.id,
            kind: o.kind,
            text: o.text ?? "",
            createdAt: o.createdAt ?? 0,
            lastAccess: o.lastAccess ?? o.createdAt ?? 0,
            importance: o.importance ?? 0,
            ...(o.embedding ? { embedding: o.embedding } : {}),
            ...(o.citations ? { citations: o.citations } : {}),
            _seq: seq,
          };
          this.mems.push(rec);
          this.byId.set(rec.id, rec);
          this.seq = Math.max(this.seq, seq + 1);
        } catch {
          /* skip a malformed/partial line */
        }
      }
    } catch {
      /* corrupt/missing file → start empty (best-effort, never crash the caller) */
    }
  }

  private append(rec: Stored): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch {
      /* ignore disk errors — the in-memory stream is still correct for this process */
    }
  }

  private rewrite(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = this.mems.map((m) => JSON.stringify(m)).join("\n");
      writeFileSync(this.file, body ? body + "\n" : "", "utf8");
    } catch {
      /* ignore disk errors — never let persistence crash the world */
    }
  }
}

// Drop the internal _seq field → exactly the pinned MemoryObject contract shape.
function strip(rec: Stored): MemoryObject {
  const { _seq, ...pub } = rec;
  return pub;
}
