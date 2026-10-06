// GOSSIP — the paper's information diffusion (Park et al. §4/Fig 9, "information diffusion, relationship
// formation, coordination") made MECHANICAL and traceable. A GossipStore per agent holds the spreadable
// items this agent knows — each with a PROVENANCE CHAIN (who told whom, in order) — decides what to pass to
// a given partner, and ingests what a partner passed on. The dialogue layer only CARRIES gossip (an item is
// seeded into a conversation's situation and rides the closed DialogueSummary); the LLM flavors how it's
// said; this module owns what exists, who has heard it, and where it came from — so a rumor's A→B→C path is
// a hard record in the tape (the `gossip-passed` beat), not an inference from transcripts.
//
// SEAM DISCIPLINE: no SDK, no fetch, no LLM. Persistence mirrors relationships.ts exactly: one JSONL file
// per agent under sim/data/gossip/, ATOMIC compacting rewrite (tmp + rename), best-effort (a disk error
// never crashes a tick), load-on-construct so a restart resumes what this agent has heard.
//
// CHAIN SEMANTICS (the acceptance contract): chain = the ordered tellers BEFORE me. The originator's own
// item has chain [] (nobody told them). When A tells B, B stores chain ["A"]. When B re-tells C, the wire
// carries chain ["A","B"] and C stores it. So an item's full path is chain + [holder], and the emitted
// gossip-passed beat {from, to, chain} lets the harness reconstruct diffusion trees exactly.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // cognition/
const ROOT = dirname(HERE); // repo root
const DEFAULT_DIR = join(ROOT, "sim", "data", "gossip");

/** A spreadable item as THIS agent holds it. */
export type GossipItem = {
  id: string; // stable across the town: g:<origin>:<slug-of-topic>:<originAtGameMin>
  topic: string; // short phrase ("the bakery sale")
  gist: string; // one attributable sentence ("the bakery is selling bread half-price until noon")
  origin: string; // the agent the item started with
  chain: string[]; // tellers BEFORE me, in order (origin first); [] if I am the origin
  heardAtGameMin: number; // when I heard/created it
  sharedWith: string[]; // who I have already passed it to (dedup; don't re-tell the same person)
};

/** The wire shape a dialogue carries (structurally mirrored in cognition/dialogue.ts DialogueGossip so the
 *  two modules stay decoupled). `chain` already INCLUDES the teller as its last element. */
export type GossipWire = {
  id: string;
  topic: string;
  gist: string;
  origin: string;
  chain: string[]; // [... prior tellers, teller]
};

export type GossipStoreOpts = {
  dir?: string; // override for tests
  nowGameMin?: () => number;
};

const MAX_ITEMS = 40; // recency-bounded — an agent doesn't carry the town's whole rumor history forever

export class GossipStore {
  readonly agentId: string;
  private readonly file: string;
  private readonly now: () => number;
  private items = new Map<string, GossipItem>(); // id -> item

  constructor(agentId: string, opts: GossipStoreOpts = {}) {
    this.agentId = agentId;
    this.now = opts.nowGameMin ?? (() => 0);
    const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "agent";
    this.file = join(opts.dir ?? DEFAULT_DIR, `${safe}.jsonl`);
    this.load();
  }

  /** Something spreadable I originated (I witnessed/decided it): becomes an item with me as origin. */
  addLocal(topic: string, gist: string): GossipItem {
    const at = this.now();
    const id = `g:${this.agentId}:${slug(topic)}:${at}`;
    const existing = this.items.get(id);
    if (existing) return existing;
    const item: GossipItem = { id, topic: clip(topic, 60), gist: clip(gist, 200), origin: this.agentId, chain: [], heardAtGameMin: at, sharedWith: [] };
    this.put(item);
    return item;
  }

  /**
   * A conversation I took part in surfaced a spreadable belief that ISN'T yet a tracked item (the partner
   * said something newsworthy — DialogueSummary.mentionedBelief with no seeded gossip). Track it with the
   * PARTNER as origin so a re-tell is attributed ("<partner> told me…"). Skips topics I already hold an
   * item for (fuzzy: same slug) so a re-hearing doesn't fork a duplicate chain.
   */
  addHeardBelief(topic: string, gist: string, fromPartner: string): GossipItem | null {
    if (!topic.trim()) return null;
    const s = slug(topic);
    for (const it of this.items.values()) if (slug(it.topic) === s) return null; // already tracked
    const at = this.now();
    const item: GossipItem = {
      id: `g:${fromPartner}:${s}:${at}`,
      topic: clip(topic, 60),
      gist: clip(gist, 200),
      origin: fromPartner,
      chain: [fromPartner],
      heardAtGameMin: at,
      sharedWith: [],
    };
    this.put(item);
    return item;
  }

  /** A partner PASSED me an item inside a dialogue (the wire's chain ends with the teller). Idempotent on id. */
  ingest(wire: GossipWire): GossipItem {
    const existing = this.items.get(wire.id);
    if (existing) return existing;
    const item: GossipItem = {
      id: wire.id,
      topic: clip(wire.topic, 60),
      gist: clip(wire.gist, 200),
      origin: wire.origin,
      chain: [...wire.chain],
      heardAtGameMin: this.now(),
      sharedWith: [],
    };
    this.put(item);
    return item;
  }

  /**
   * What would I tell `partner` right now? The newest item they haven't heard FROM ME and aren't already in
   * the provenance of (never tell someone their own rumor back). Returns the item + the WIRE (chain with me
   * appended) + a natural seed line for the dialogue situation. Null when I have nothing fresh for them.
   */
  pickToShare(partner: string): { item: GossipItem; wire: GossipWire; seedLine: string } | null {
    const fresh = [...this.items.values()]
      .filter((it) => it.origin !== partner && !it.chain.includes(partner) && !it.sharedWith.includes(partner))
      .sort((a, b) => b.heardAtGameMin - a.heardAtGameMin);
    const item = fresh[0];
    if (!item) return null;
    const wire: GossipWire = { id: item.id, topic: item.topic, gist: item.gist, origin: item.origin, chain: [...item.chain, this.agentId] };
    const src = item.chain.length ? item.chain[item.chain.length - 1] : null;
    const seedLine = src
      ? `You've been meaning to tell ${partner} what ${src} told you: ${item.gist}`
      : `You've been meaning to tell ${partner} your news: ${item.gist}`;
    return { item, wire, seedLine };
  }

  /** Record that I told `partner` about `itemId` (a conversed dialogue carried it). */
  markShared(itemId: string, partner: string): void {
    const it = this.items.get(itemId);
    if (!it) return;
    if (!it.sharedWith.includes(partner)) {
      it.sharedWith.push(partner);
      this.persist();
    }
  }

  /** The newest item I haven't told ANYONE yet — upstream of volition ("I want to tell X about Y"); the
   *  caller pairs it with the relationship graph to pick a concrete X. */
  freshestUnshared(): GossipItem | null {
    const fresh = [...this.items.values()].sort((a, b) => b.heardAtGameMin - a.heardAtGameMin);
    return fresh.find((it) => it.sharedWith.length === 0) ?? null;
  }

  get(id: string): GossipItem | undefined {
    const it = this.items.get(id);
    return it ? { ...it, chain: [...it.chain], sharedWith: [...it.sharedWith] } : undefined;
  }

  size(): number {
    return this.items.size;
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private put(item: GossipItem): void {
    this.items.set(item.id, item);
    // recency-bound the store (drop the oldest-heard beyond MAX_ITEMS)
    if (this.items.size > MAX_ITEMS) {
      const ordered = [...this.items.values()].sort((a, b) => a.heardAtGameMin - b.heardAtGameMin);
      for (const drop of ordered.slice(0, this.items.size - MAX_ITEMS)) this.items.delete(drop.id);
    }
    this.persist();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Partial<GossipItem>;
          if (!o.id || !o.topic) continue;
          this.items.set(o.id, {
            id: o.id,
            topic: String(o.topic),
            gist: String(o.gist ?? ""),
            origin: String(o.origin ?? ""),
            chain: Array.isArray(o.chain) ? o.chain.filter((c) => typeof c === "string") : [],
            heardAtGameMin: typeof o.heardAtGameMin === "number" ? o.heardAtGameMin : 0,
            sharedWith: Array.isArray(o.sharedWith) ? o.sharedWith.filter((c) => typeof c === "string") : [],
          });
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      /* corrupt/missing → start empty */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = [...this.items.values()].map((it) => JSON.stringify(it)).join("\n");
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, body ? body + "\n" : "", "utf8");
      renameSync(tmp, this.file); // atomic — a crash never truncates the store
    } catch {
      /* best-effort */
    }
  }
}

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}

function clip(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

// ---- runnable self-test (ZERO tokens) --------------------------------------------------------------------
// `tsx cognition/gossip.ts` proves the acceptance bullet "gossip provenance chain records A→B→C": A
// originates an item, passes it to B (B stores chain [A]), B re-tells C (wire chain [A,B]; C stores it),
// nobody re-tells a person their own rumor, share-dedup holds, and the store persists + reloads.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
  };

  const dir = mkdtempSync(join(tmpdir(), "gossip-selftest-"));
  let gm = 900;
  const now = () => gm;

  // A originates: "the smith raised prices".
  const A = new GossipStore("ada", { dir, nowGameMin: now });
  const item = A.addLocal("smith price rise", "the smith raised nail prices this morning");
  assert(item.origin === "ada" && item.chain.length === 0, "originator holds chain []");

  // A → B: pick, wire carries chain [ada]; B ingests.
  const pickAB = A.pickToShare("ben");
  assert(!!pickAB && pickAB.item.id === item.id, "A has something to tell B");
  assert(JSON.stringify(pickAB!.wire.chain) === JSON.stringify(["ada"]), `wire A→B chain is [ada] (got ${JSON.stringify(pickAB!.wire.chain)})`);
  assert(/meaning to tell ben your news/i.test(pickAB!.seedLine), "originator seed line reads as own news");
  const B = new GossipStore("ben", { dir, nowGameMin: now });
  gm = 910;
  const inB = B.ingest(pickAB!.wire);
  A.markShared(item.id, "ben");
  assert(JSON.stringify(inB.chain) === JSON.stringify(["ada"]), "B stores chain [ada] — 'Ada told me'");

  // B → C: the wire appends ben; C stores [ada, ben] — the A→B→C acceptance chain.
  const pickBC = B.pickToShare("cara");
  assert(!!pickBC, "B has the item fresh for C");
  assert(JSON.stringify(pickBC!.wire.chain) === JSON.stringify(["ada", "ben"]), `wire B→C chain is [ada,ben] (got ${JSON.stringify(pickBC!.wire.chain)})`);
  assert(/what ada told you/i.test(pickBC!.seedLine), "re-teller seed line attributes the source ('what ada told you')");
  const C = new GossipStore("cara", { dir, nowGameMin: now });
  gm = 920;
  const inC = C.ingest(pickBC!.wire);
  B.markShared(inB.id, "cara");
  assert(JSON.stringify(inC.chain) === JSON.stringify(["ada", "ben"]), "PROVENANCE A→B→C: cara's chain is [ada, ben]");
  assert(inC.origin === "ada", "origin survives the whole path");

  // never tell someone their own rumor back; never re-tell the same person.
  assert(B.pickToShare("ada") === null, "B does not tell ada her own rumor back");
  assert(B.pickToShare("cara") === null, "B does not re-tell cara (sharedWith dedup)");

  // ingest is idempotent on id (hearing the same rumor twice doesn't fork).
  const again = C.ingest(pickBC!.wire);
  assert(again === undefined || again.id === inC.id, "re-ingest is idempotent");
  assert(C.size() === 1, "no duplicate items on re-ingest");

  // addHeardBelief: an untracked belief from a dialogue becomes an item attributed to the partner.
  gm = 930;
  const D = new GossipStore("dan", { dir, nowGameMin: now });
  const heard = D.addHeardBelief("the harvest party", "there's a harvest party at the pub tonight", "erin");
  assert(!!heard && heard.origin === "erin" && JSON.stringify(heard.chain) === JSON.stringify(["erin"]), "heard belief is attributed to the teller");
  assert(D.addHeardBelief("the harvest party", "same news again", "frank") === null, "same-topic re-hearing doesn't fork a second chain");

  // persistence: a reload sees the same chain.
  const C2 = new GossipStore("cara", { dir, nowGameMin: now });
  assert(C2.size() === 1 && JSON.stringify(C2.get(inC.id)?.chain) === JSON.stringify(["ada", "ben"]), "store persists + reloads chains");

  console.log("gossip.ts self-test: ALL ASSERTIONS PASSED (A→B→C provenance · attribution lines · own-rumor/dedup guards · idempotent ingest · heard-belief tracking · persistence)");
}
