import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Mind } from "../cognition/mind.js";
import { holdDialogue, type DialogueSummary, type DialogueGossip } from "../cognition/dialogue.js";
import type { Complete } from "../cognition/llm.js";
import { personaFor as rosterPersonaFor } from "./personas.js";

// THE CITIZEN-SIDE CONVERSATION ORCHESTRATOR (Wave 2b, DECIDED D6: the SIM never calls an LLM, so a
// conversation runs CITIZEN-side, in the initiator's process). On adjacency the initiator:
//   1. constructs the partner's Mind from the partner's PERSISTED memory stream (sim/data/memory/<partner>.jsonl)
//      — but READ-ONLY (see CROSS-PROCESS SAFETY below),
//   2. runs cognition/dialogue.ts holdDialogue(myMind, partnerMind, complete) — turn-taking, conditioned on
//      both agents' memories,
//   3. POSTs the resulting DialogueSummary to the sim's /dialogue record endpoint (the sim persists it to
//      sim/data/dialogue.jsonl + WS-broadcasts it; NO LLM, NO turn-gate there),
//   4. returns the summary so the citizen loop can feed BOTH participants' relationship graphs.
//
// SINGLE-INITIATOR GUARD: two adjacent agents must not BOTH start a conversation about the same pair. The
// LOWER-id agent of a pair initiates; the higher-id one waits and learns of the conversation via the sim's
// dialogue record on its next tick. One conversation per tick max (the lowest-id eligible partner).
//
// ⚠ CROSS-PROCESS SAFETY (the load-bearing constraint): in the live fleet each citizen runs in its OWN
// process and OWNS its own sim/data/memory/<id>.jsonl. The partner's file is therefore being written by the
// PARTNER's process; if THIS process also writes it, the two appends/rewrites RACE and corrupt the stream.
// Two distinct write paths would touch the partner's file if we used its Mind naively:
//   (a) holdDialogue folds the dialogue back into both streams → guarded by persistMemoryFor:"initiator"
//       (we write ONLY our own stream; the partner learns via the sim record).
//   (b) SUBTLER: retrieve()/buildSummary() (which Mind.contextFor + Mind.summary call) MUTATE the stream on
//       READ — touch() bumps lastAccess and setEmbedding() caches vectors, both REWRITE the .jsonl. So even
//       just conditioning the partner's utterances on its memories would write the partner's real file.
// FIX for (b): we point the partner Mind at a private COPY of the partner's stream in a throwaway temp dir.
// It loads the partner's REAL memories (so utterances/summary are believably in-character) but every write —
// the read-time touch/embed AND any fold-back — lands in the temp copy, never the partner's live file. The
// temp copy is discarded when the process exits. Net: the partner's real stream is strictly READ, never
// written, from this process.
//
// SEAM DISCIPLINE: the model call goes through the injected `Complete` (real Claude-backed one in the citizen
// runtime; stubComplete in tests → ZERO tokens). The sim POST is injectable (`postRecord`) so the unit test
// validates without a running sim. DEGRADE-DON'T-DIE: a missing partner stream, a model hiccup, or a failed
// POST never throws into the tick — the driver returns a coherent result and the citizen loop proceeds.

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root
const DEFAULT_MEMORY_DIR = join(ROOT, "sim", "data", "memory");
const SIM = process.env.SIM_URL ?? "http://localhost:4042";

export type DriveDialogueResult = {
  initiated: boolean; // did THIS agent start a conversation this tick?
  reason?: string; // why not (when initiated=false): "no-neighbors" | "not-initiator" | "partner-stream-missing" | "walk_by"
  summary?: DialogueSummary; // present iff a conversation OR a walk_by actually ran (the record to persist/ingest)
  partner?: string; // the partner id, when one was selected
};

export type MaybeDriveDialogueOpts = {
  /** The live citizen's Mind. Its REAL stream is the only one we persist the dialogue into. */
  selfMind: Mind;
  /** The ids this agent is adjacent to right now (the PINNED /perceive adjacentTo signal). */
  adjacentTo: string[];
  /** LLM seam: real Complete in prod, stubComplete in tests. */
  complete: Complete;
  /** Sim game clock (game-minutes) — stamps the conversation + the initiator's fold-back memory. */
  nowGameMin: () => number;
  /** Optional NL describing where/why they're co-located (seeds engage-decision + retrieval). */
  situation?: string;
  /** How the conversation should end / how long it can run (passed through to holdDialogue). */
  maxTurns?: number;
  retrieveK?: number;
  forceEngage?: boolean;
  /** Persist the closed summary. Injectable for tests; defaults to POST {SIM}/dialogue {op:"record", summary}. */
  postRecord?: (summary: DialogueSummary) => Promise<void>;
  /** Directory holding per-agent memory streams. Defaults to sim/data/memory; override in tests. */
  memoryDir?: string;
  /** Resolve a partner's persona/system text for in-character conditioning. Defaults to citizens/personas.ts
   *  (falling back to a minimal persona for a non-roster id). Injectable so tests don't need a real persona. */
  personaFor?: (id: string) => string;
  /** town-alive B1: the partner IGNITION already elected (citizens/ignition.ts decideIgnition — windowed
   *  election / reply-mode). When set, pickPartner's legacy lower-id-only rule is BYPASSED: the caller has
   *  done the single-host election (and reply-mode legitimately hosts as the say's target). Must be present
   *  in adjacentTo (defensive: a stale override for someone who left is ignored → no-neighbors). */
  partnerOverride?: string;
  /** town-alive B2: what I know of the partner (RelationshipGraph.describeRelationship) — folded into the
   *  situation so BOTH the engage decision and every utterance are conditioned on the relationship (paper
   *  §4.3.2: dialogue conditioned on summarized memory ABOUT the partner). */
  relationshipLine?: string;
  /** town-alive B2: gossip I intend to pass (GossipStore.pickToShare().wire + seedLine). The seedLine is
   *  folded into the situation (primes the model to actually say it); the wire rides the closed summary. */
  gossipSeed?: { wire: DialogueGossip; seedLine: string };
};

/**
 * If this agent is the designated initiator for some adjacent partner, run a turn-taking dialogue with that
 * partner and record it. Returns whether it initiated, the partner, and (if a conversation/walk_by ran) the
 * DialogueSummary. Never throws — every failure path degrades to a coherent {initiated:false,...} or a
 * walk_by summary. Persists ONLY the initiator's memory stream (cross-process safety).
 */
export async function maybeDriveDialogue(opts: MaybeDriveDialogueOpts): Promise<DriveDialogueResult> {
  const selfId = opts.selfMind.stream.agentId;
  const memoryDir = opts.memoryDir ?? DEFAULT_MEMORY_DIR;
  const resolvePersona = opts.personaFor ?? defaultPersonaFor;

  // --- host election. PREFERRED (town-alive B1): the caller's ignition decision (partnerOverride) — the
  // windowed election / reply-mode already picked exactly one host for the pair, so the legacy rule below
  // must not second-guess it (it was the D17 pathology: lower-id-only starved every sighting the higher-id
  // side made — 2 of today's 3). LEGACY (no override): lower-id-only, kept for back-compat callers/tests. ---
  let partner: string | null;
  if (opts.partnerOverride) {
    partner = dedupeOthers(selfId, opts.adjacentTo).includes(opts.partnerOverride) ? opts.partnerOverride : null;
    if (!partner) return { initiated: false, reason: "no-neighbors" }; // stale override — partner already gone
  } else {
    partner = pickPartner(selfId, opts.adjacentTo);
    if (!partner) {
      const hasNeighbors = dedupeOthers(selfId, opts.adjacentTo).length > 0;
      return { initiated: false, reason: hasNeighbors ? "not-initiator" : "no-neighbors" };
    }
  }

  // --- construct the partner's Mind READ-ONLY: load a private COPY of its persisted stream into a temp dir
  //     so read-time touch/embed and any fold-back never touch the partner's live file (see header (b)). ---
  const partnerStreamDir = isolatePartnerStream(partner, memoryDir);
  const partnerMind = new Mind({
    agentId: partner,
    persona: safePersona(resolvePersona, partner),
    complete: opts.complete,
    nowGameMin: opts.nowGameMin,
    dir: partnerStreamDir, // the temp copy — NEVER the partner's real sim/data/memory dir
  });

  // --- situation: where/why + what I know of them (relationship conditioning, paper §4.3.2) + what I mean
  //     to tell them (gossip seed). All ride ONE string so dialogue.ts needs no prompt surgery. ---
  const situationParts = [opts.situation, opts.relationshipLine, opts.gossipSeed?.seedLine]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  const situation = situationParts.join(" ");

  // --- run the turn-taking dialogue; persist ONLY the initiator's (self's) memory ---
  const summary = await holdDialogue(opts.selfMind, partnerMind, opts.complete, {
    nowGameMin: opts.nowGameMin,
    ...(situation ? { situation } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.retrieveK !== undefined ? { retrieveK: opts.retrieveK } : {}),
    ...(opts.forceEngage !== undefined ? { forceEngage: opts.forceEngage } : {}),
    ...(opts.gossipSeed ? { gossipSeed: opts.gossipSeed.wire } : {}),
    persistMemoryFor: "initiator", // ← cross-process safety: write self only, never the partner's real stream
  });

  // A walk-by (chose not to / produced no lines) still gets recorded so the relationship graph can register a
  // co-presence — but we surface reason:"walk_by" so the caller knows no conversation happened.
  await recordSummary(summary, opts.postRecord);
  return {
    initiated: true,
    partner,
    summary,
    ...(summary.outcome === "walk_by" ? { reason: "walk_by" } : {}),
  };
}

// ---- internals ------------------------------------------------------------------------------------------

// The set of distinct OTHER agent ids adjacent to self (dedupe + drop self defensively).
function dedupeOthers(selfId: string, adjacentTo: string[]): string[] {
  return Array.from(new Set((adjacentTo ?? []).filter((x) => x && x !== selfId)));
}

// Single-initiator rule: self initiates a conversation with a neighbor `p` ONLY when `selfId < p` (self is
// the lower id of the pair) — so exactly one side of any adjacent pair initiates. Among all such eligible
// neighbors, pick the lexicographically lowest for determinism (one conversation per tick). Returns null if
// self is not the initiator for any neighbor (or has none).
function pickPartner(selfId: string, adjacentTo: string[]): string | null {
  const eligible = dedupeOthers(selfId, adjacentTo)
    .filter((p) => selfId < p) // self is the lower id ⇒ self initiates this pair
    .sort();
  return eligible[0] ?? null;
}

// Copy the partner's persisted stream into a fresh temp dir under the SAME basename (<partner>.jsonl), so a
// Mind constructed with dir=tempDir loads exactly those memories but writes only into the temp copy. If the
// partner has no stream yet, returns an empty temp dir (the partner Mind just has no memories — fine; the
// dialogue still runs, conditioned on the situation + the initiator's side). Best-effort: a copy failure
// falls back to an empty temp dir rather than throwing.
function isolatePartnerStream(partnerId: string, memoryDir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), `dlg-partner-${sanitize(partnerId)}-`));
  try {
    const safe = sanitize(partnerId);
    const src = join(memoryDir, `${safe}.jsonl`);
    if (existsSync(src)) copyFileSync(src, join(tmp, `${safe}.jsonl`));
  } catch {
    /* degrade: an empty temp dir → partner Mind with no loaded memories (still safe + runnable) */
  }
  return tmp;
}

// Mirror MemoryStream's id sanitizer so the copied file lands at the exact basename the partner Mind will
// look for (agentId.replace(/[^A-Za-z0-9._-]/g,"_")). Keeps the copy <-> load mapping correct.
function sanitize(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "agent";
}

// Persist the closed summary via the injected recorder, or the default sim POST. Best-effort — never throws.
async function recordSummary(
  summary: DialogueSummary,
  postRecord?: (s: DialogueSummary) => Promise<void>,
): Promise<void> {
  try {
    if (postRecord) {
      await postRecord(summary);
    } else {
      await defaultPostRecord(summary);
    }
  } catch (e) {
    // the conversation already happened in memory; a failed record must not crash the tick — but
    // SURFACE it (D17: a silently-swallowed POST would hide why dialogue.jsonl stays empty).
    console.warn(`[dialogue] record POST failed for ${summary.id} (${summary.outcome}): ${(e as Error).message}`);
  }
}

// Default recorder: POST the summary to the sim's dialogue endpoint. The sim is the single writer of
// sim/data/dialogue.jsonl + the WS broadcaster (the lead builds this endpoint). Best-effort fetch.
async function defaultPostRecord(summary: DialogueSummary): Promise<void> {
  await fetch(`${SIM}/dialogue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "record", summary }),
  });
}

// Resolve a partner's persona/system text from citizens/personas.ts (the live roster), degrading to a minimal
// persona for an id not on the roster (e.g. a synthetic test agent) so construction never throws.
function defaultPersonaFor(id: string): string {
  try {
    return rosterPersonaFor(id).system;
  } catch {
    return minimalPersona(id);
  }
}

// Resolve via the caller-supplied resolver (or the default), guarding against a throw / empty so the partner
// Mind always gets a usable persona header.
function safePersona(resolve: (id: string) => string, id: string): string {
  try {
    const p = resolve(id);
    return p && p.trim() ? p : minimalPersona(id);
  } catch {
    return minimalPersona(id);
  }
}

function minimalPersona(id: string): string {
  return `${id}, a resident of the town.`;
}

// ---- runnable stub self-test (ZERO tokens) --------------------------------------------------------------
// `tsx citizens/dialogue-driver.ts` exercises the driver end-to-end with stubComplete + two synthetic agents
// whose memory streams are persisted to a temp dir. Asserts: the single-initiator guard (lower id initiates;
// higher id defers), the partner's REAL stream is NOT written (cross-process safety), the summary is POSTed
// (captured via an injected recorder), and the returned summary is coherent. No SDK, no sim, no real model.
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { mkdtempSync: mkdtemp, readdirSync, readFileSync } = await import("node:fs");
    const { stubComplete } = await import("../cognition/llm.js");
    const { MemoryStream } = await import("../cognition/memory-stream.js");

    const assert = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    };

    // A shared memory dir holding two synthetic agents' persisted streams ("ada" < "ben" lexicographically).
    const memoryDir = mkdtemp(join(tmpdir(), "dlg-driver-mem-"));
    let gameMin = 900;
    const now = () => gameMin;

    const anaStream = new MemoryStream("ada", { dir: memoryDir, nowGameMin: now });
    const benStream = new MemoryStream("ben", { dir: memoryDir, nowGameMin: now });
    anaStream.add({ kind: "observation", text: "Ada runs the bakery and knows Ben buys bread each morning.", createdAt: 850, importance: 5 });
    benStream.add({ kind: "observation", text: "Ben is a regular at the bakery and likes a chat.", createdAt: 850, importance: 5 });
    const benFileBefore = readFileSync(join(memoryDir, "ben.jsonl"), "utf8");

    // Scripted, deterministic, ZERO-token stub: engage, a 2-line exchange that closes, a topic.
    let turn = 0;
    const lines = ["Morning Ben! Fresh bread is out.", `Thanks Ada, I'll take a loaf! ${"[END]"}`];
    const complete = stubComplete((prompt: string) => {
      if (/TALK or PASS/.test(prompt)) return "TALK";
      if (/ONE short noun phrase/.test(prompt)) return "fresh bread\nBELIEF: yes";
      if (/Say your next line/.test(prompt)) return lines[Math.min(turn++, lines.length - 1)];
      if (/rate the likely poignancy/.test(prompt)) return "4";
      return "A friendly Main Street regular.";
    });

    // self = ada (the LOWER id) → ada initiates the ada/ben pair.
    const anaMind = new Mind({ agentId: "ada", persona: "Ada, the baker.", complete, nowGameMin: now, dir: memoryDir });
    const recorded: DialogueSummary[] = [];
    const res = await maybeDriveDialogue({
      selfMind: anaMind,
      adjacentTo: ["ben"],
      complete,
      nowGameMin: now,
      situation: "You are both at the bakery counter.",
      memoryDir,
      personaFor: (id) => `${id}, a resident.`,
      postRecord: async (s) => void recorded.push(s),
    });

    assert(res.initiated === true, "ada (lower id) initiates with ben");
    assert(res.partner === "ben", "partner is ben");
    assert(!!res.summary && res.summary.outcome === "conversed", "a conversation ran");
    assert(res.summary!.participants[0] === "ada" && res.summary!.participants[1] === "ben", "participants sorted");
    assert(res.summary!.turns === 2, `two lines spoken (got ${res.summary?.turns})`);
    assert(recorded.length === 1 && recorded[0].id === res.summary!.id, "the summary was recorded once via the injected recorder");

    // CROSS-PROCESS SAFETY: ben's REAL persisted stream must be byte-for-byte unchanged (we only read a copy).
    const benFileAfter = readFileSync(join(memoryDir, "ben.jsonl"), "utf8");
    assert(benFileAfter === benFileBefore, "ben's real memory stream was NOT written (read-only partner)");
    // And ada's real stream DID gain the dialogue memory (the initiator persists).
    const anaReload = new MemoryStream("ada", { dir: memoryDir, nowGameMin: now });
    assert(anaReload.recent(1)[0] && /ben/i.test(anaReload.recent(1)[0].text), "ada's real stream gained the dialogue memory");

    // SINGLE-INITIATOR GUARD from the OTHER side: self = ben (higher id) must NOT initiate the ben/ada pair.
    gameMin = 905;
    turn = 0;
    const benMind = new Mind({ agentId: "ben", persona: "Ben, a regular.", complete, nowGameMin: now, dir: memoryDir });
    const benRecorded: DialogueSummary[] = [];
    const res2 = await maybeDriveDialogue({
      selfMind: benMind,
      adjacentTo: ["ada"],
      complete,
      nowGameMin: now,
      memoryDir,
      postRecord: async (s) => void benRecorded.push(s),
    });
    assert(res2.initiated === false && res2.reason === "not-initiator", "ben (higher id) defers — does not initiate");
    assert(benRecorded.length === 0, "the non-initiator records nothing");

    // NO NEIGHBORS → not initiated, reason no-neighbors.
    const res3 = await maybeDriveDialogue({ selfMind: anaMind, adjacentTo: [], complete, nowGameMin: now, memoryDir, postRecord: async () => {} });
    assert(res3.initiated === false && res3.reason === "no-neighbors", "no neighbors → not initiated");

    // MISSING partner stream still runs (partner Mind just has no memories); cross-process safety holds.
    gameMin = 910;
    turn = 0;
    const res4 = await maybeDriveDialogue({
      selfMind: anaMind,
      adjacentTo: ["zed"], // "zed" has no persisted stream and sorts above "ada" → ada initiates
      complete,
      nowGameMin: now,
      memoryDir,
      personaFor: (id) => `${id}, a stranger.`,
      postRecord: async () => {},
    });
    assert(res4.initiated === true && res4.partner === "zed", "ada initiates with zed despite no partner stream");
    assert(!existsSync(join(memoryDir, "zed.jsonl")), "a missing partner stream is NOT created in the real memory dir");

    // confirm no stray files were written into the real memory dir (only ada.jsonl + ben.jsonl exist).
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".jsonl")).sort();
    assert(JSON.stringify(files) === JSON.stringify(["ada.jsonl", "ben.jsonl"]), `only ada+ben streams in the real dir (got ${files.join(",")})`);

    console.log("dialogue-driver.ts self-test: ALL ASSERTIONS PASSED");
    console.log(`--- sample result: initiated=${res.initiated} partner=${res.partner} turns=${res.summary?.turns} topic="${res.summary?.topic}" mentionedBelief=${res.summary?.mentionedBelief}`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
