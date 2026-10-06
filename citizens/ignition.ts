// CONVERSATION IGNITION (town-alive audit A1/B1) — the PURE per-tick decision "do I start a conversation
// right now, with whom, and why", extracted so it is zero-token testable and shared by the social step.
//
// WHY THIS EXISTS (2026-07-18 tape, a 2026-07-18 flight-tape audit):
// today's funnel was 45 acted ticks → 3 perception-time adjacency sightings → 1 conversation. TWO of the
// three sightings were killed by the old election in dialogue-driver.pickPartner: "the LOWER id always
// hosts" — the higher-id agent that actually SAW the partner deferred forever, waiting for a lower-id tick
// that never aligned (D17's pathology, live in the tape). With ~5 ticks/agent/run, every lost sighting is
// ~a lost third of the day's social budget. Ignition therefore must convert EVERY sighting it can:
//
//   • REPLY MODE (closes the #18 loop end-to-end): if someone ADJACENT said something TO me (heardRecently),
//     I host a dialogue with them NOW — no election, no engage gate (they addressed me; answering is the
//     human default). The say's target hosting can't double-drive: the speaker's own driver never treats its
//     outbound say as inbound. Each say id is answered at most once (processedSayIds).
//   • CO-LOCATION MODE: for a plain sighting, a WINDOWED election decides which side hosts: within a game-
//     hour window, host = lowerId or higherId by (pairHash + window) parity. Deterministic and identical in
//     both processes (both read the same sim game-clock), so exactly one side of a pair hosts per window —
//     the single-writer guarantee the old rule bought — but the monopoly ROTATES: a sighting that lands in
//     the "wrong" window is at most one window late, never starved forever. (Edge: the two agents' clocks
//     can straddle a window boundary by a few game-min → rarely BOTH or NEITHER host that boundary tick;
//     both-host just yields two short dialogues then cooldown, neither-host is the status quo ante. Accepted.)
//   • RATE LIMIT: a per-pair cooldown (default 30 game-min, the A3 rule) + a per-pair-per-day conversation
//     cap keep it likely-not-spammy. State lives in PairSocialState (in-process; runs are short and bounded,
//     so reset-per-run is acceptable — the cooldown also re-seeds from ingested dialogue records).
//
// PURE: no I/O, no LLM, no fetch — the caller (citizens/social-step.ts) supplies perception-derived inputs
// and applies the decision via the dialogue driver. Same seam discipline as sim/earshot.ts.

export type HeardSay = { id?: string; from?: string; text?: string };

export type IgnitionInput = {
  selfId: string;
  /** Sim game clock (absolute game-minutes) at this tick. */
  gameMin: number;
  /** Perception-time adjacency (the pinned /perceive signal). */
  adjacentTo: string[];
  /** Ids of everyone in my modelled interior right now (insideHere.occupants), if inside. Union'd with
   *  adjacency so a multi-tile interior (future) or a momentary exterior-tile mismatch can't hide a
   *  same-room partner from ignition. */
  sameRoomIds?: string[];
  /** Inbound one-way says directed at me (the /perceive heardRecently ring, oldest→newest). */
  heardRecently?: HeardSay[];
  /** Enabled roster ids (D17: never initiate with a disabled/dead partner). Empty/omitted ⇒ tolerate
   *  (degrade open — don't let a missing roster block all dialogue). */
  enabledIds?: string[];
  /** Per-pair social bookkeeping (cooldowns, daily counts, answered says). */
  state: PairSocialState;
  /** Cooldown between conversations with the SAME partner (game-min). Default 30 (the A3 rule). */
  cooldownGameMin?: number;
  /** Max conversations with the same partner per game-day. Default 3 — regulars chat morning and evening
   *  and once more, but nobody re-greets a colleague eight times a shift. */
  maxPerPairPerDay?: number;
  /** Host-election rotation window (game-min). Default 60 — a starved side waits at most one game-hour. */
  hostWindowGameMin?: number;
};

/** D32 (suppression reasons are first-class): the per-candidate verdict this evaluation reached. One entry
 *  per co-present other, ALWAYS returned — the tape beat names the suppressor for every pair every tick, so
 *  a silent day can never be a mystery again ("why didn't X and Y talk?" is answered by the tape). */
export type CandidateStatus = {
  id: string;
  status: "chosen" | "eligible" | "disabled" | "cooldown" | "capped" | "not-host-this-window";
};

export type IgnitionDecision =
  | {
      attempt: true;
      /** Why this fired — reply (someone spoke to me) vs co-location (we're sharing a spot). */
      mode: "reply" | "co-location";
      partner: string;
      /** reply mode: the line being answered + its ring id (marked answered by the caller on drive). */
      sayText?: string;
      sayId?: string;
      candidates: CandidateStatus[];
    }
  | { attempt: false; reason: "no-candidates" | "cooldown-or-capped" | "not-host-this-window"; candidates: CandidateStatus[] };

/**
 * The per-tick ignition decision. Priority: (1) answer a say from someone still beside me; (2) host a
 * co-location conversation if this window's election says it's my turn. Deterministic given its inputs.
 * Always carries the full per-candidate status ledger (D32 — the caller emits it as an `ignition` beat).
 */
export function decideIgnition(input: IgnitionInput): IgnitionDecision {
  const cooldown = input.cooldownGameMin ?? 30;
  const maxPerDay = input.maxPerPairPerDay ?? 3;
  const windowMin = Math.max(1, input.hostWindowGameMin ?? 60);
  const enabled = new Set(input.enabledIds ?? []);
  const okEnabled = (id: string) => enabled.size === 0 || enabled.has(id);

  // The candidate pool: distinct others adjacent OR sharing my interior. Statuses accumulate per candidate.
  const pool = new Set<string>();
  for (const id of [...(input.adjacentTo ?? []), ...(input.sameRoomIds ?? [])]) {
    if (id && id !== input.selfId) pool.add(id);
  }
  const statuses = new Map<string, CandidateStatus["status"]>();
  const window = Math.floor(input.gameMin / windowMin);
  for (const id of [...pool].sort()) {
    if (!okEnabled(id)) statuses.set(id, "disabled");
    else {
      const block = input.state.blockReason(id, input.gameMin, cooldown, maxPerDay);
      if (block) statuses.set(id, block);
      else statuses.set(id, electedHost(input.selfId, id, window) === input.selfId ? "eligible" : "not-host-this-window");
    }
  }
  const ledger = (): CandidateStatus[] => [...statuses.entries()].map(([id, status]) => ({ id, status }));
  const present = [...pool].filter(okEnabled).sort();
  if (present.length === 0) return { attempt: false, reason: "no-candidates", candidates: ledger() };

  const talkable = present.filter((p) => !input.state.blockReason(p, input.gameMin, cooldown, maxPerDay));

  // (1) REPLY MODE — newest unanswered say whose speaker is still here (talkable required: an answered-say
  // partner in cooldown means we JUST talked — don't restart). Bypasses the host election entirely.
  const heard = input.heardRecently ?? [];
  for (let i = heard.length - 1; i >= 0; i--) {
    const h = heard[i];
    const from = h?.from;
    if (!from || from === input.selfId) continue;
    if (!present.includes(from)) continue; // they've moved on — the volition/prompt path handles that
    const sayId = h.id ?? `${from}|${h.text ?? ""}`;
    if (input.state.isAnswered(sayId)) continue;
    if (!talkable.includes(from)) continue;
    statuses.set(from, "chosen");
    return { attempt: true, mode: "reply", partner: from, sayText: h.text ?? "", ...(h.id ? { sayId: h.id } : { sayId }), candidates: ledger() };
  }

  if (talkable.length === 0) return { attempt: false, reason: "cooldown-or-capped", candidates: ledger() };

  // (2) CO-LOCATION MODE — host election, rotating per window so no side is starved forever.
  const mine = talkable.filter((p) => electedHost(input.selfId, p, window) === input.selfId);
  if (mine.length === 0) return { attempt: false, reason: "not-host-this-window", candidates: ledger() };
  statuses.set(mine[0], "chosen");
  return { attempt: true, mode: "co-location", partner: mine[0], candidates: ledger() };
}

/**
 * Which side of the pair hosts (drives the dialogue) during this election window. Deterministic + symmetric:
 * both processes compute the same answer from the pair key and the shared sim clock. Parity of
 * (pairHash + window) alternates hosting between the sorted-lower and sorted-higher id across windows.
 */
export function electedHost(a: string, b: string, window: number): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (fnv1a(`${lo}|${hi}`) + window) % 2 === 0 ? lo : hi;
}

// FNV-1a 32-bit — tiny, dependency-free, stable across processes (the only properties we need).
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Per-pair social bookkeeping for ONE agent's process: when did I last converse with X, how many times
 * today, and which inbound says I've already answered. In-memory by design (runs are short + bounded); the
 * caller re-seeds cooldowns from dialogue records it ingests (both the ones I drove and the ones recorded
 * about me), so a partner-driven conversation also cools the pair down on my side.
 */
export class PairSocialState {
  private lastConversed = new Map<string, number>(); // partnerId -> gameMin of last conversation
  private dayCounts = new Map<string, number>(); // `${partnerId}|${gameDay}` -> conversations that day
  private answeredSays = new Set<string>(); // say ids I've already replied to (or drove a reply for)

  /** Can I start (or accept) a conversation with `partner` now, under the cooldown + daily cap? */
  mayConverse(partner: string, gameMin: number, cooldownGameMin: number, maxPerDay: number): boolean {
    return this.blockReason(partner, gameMin, cooldownGameMin, maxPerDay) === null;
  }

  /** WHY a conversation with `partner` is blocked right now — "cooldown" | "capped" — or null when clear.
   *  Split from mayConverse so the D32 ignition beat can name the exact suppressor per candidate. */
  blockReason(partner: string, gameMin: number, cooldownGameMin: number, maxPerDay: number): "cooldown" | "capped" | null {
    const last = this.lastConversed.get(partner);
    if (last !== undefined && gameMin - last < cooldownGameMin) return "cooldown";
    if (this.countToday(partner, gameMin) >= maxPerDay) return "capped";
    return null;
  }

  /** Record that a conversation with `partner` happened (drove OR ingested) at `gameMin`. Idempotent per
   *  distinct timestamp-ish call; a walk_by still stamps the cooldown (don't re-try the same neighbor every
   *  tick) but does NOT consume the daily cap (they didn't actually talk). */
  noteConversed(partner: string, gameMin: number, opts?: { walkBy?: boolean }): void {
    const prev = this.lastConversed.get(partner);
    this.lastConversed.set(partner, Math.max(prev ?? -Infinity, gameMin));
    if (!opts?.walkBy) {
      const key = this.dayKey(partner, gameMin);
      this.dayCounts.set(key, (this.dayCounts.get(key) ?? 0) + 1);
    }
  }

  /** How many real conversations with `partner` so far in `gameMin`'s game-day. */
  countToday(partner: string, gameMin: number): number {
    return this.dayCounts.get(this.dayKey(partner, gameMin)) ?? 0;
  }

  markAnswered(sayId: string): void {
    if (sayId) this.answeredSays.add(sayId);
  }

  isAnswered(sayId: string): boolean {
    return this.answeredSays.has(sayId);
  }

  private dayKey(partner: string, gameMin: number): string {
    return `${partner}|${Math.floor(gameMin / 1440)}`;
  }
}

// ---- runnable self-test (ZERO tokens) --------------------------------------------------------------------
// `tsx citizens/ignition.ts` proves the acceptance bullets that belong to ignition: a synthetic co-location
// ignites within ≤2 ticks (one side immediately; the other side's turn arrives with the window rotation),
// heardRecently produces a reply attempt (no election, once per say), and the cooldown/daily-cap rate-limit
// holds. Pure — no sim, no model, no disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
  };

  // --- co-location: EXACTLY ONE side hosts in a window; the sighting converts on the host's first tick ---
  const A = "barista", B = "grocer"; // real ids from today's tape (grocer deferred forever under the old rule)
  const w0 = 600; // both agents share the sim clock
  const sA = new PairSocialState(), sB = new PairSocialState();
  const dA = decideIgnition({ selfId: A, gameMin: w0, adjacentTo: [B], state: sA });
  const dB = decideIgnition({ selfId: B, gameMin: w0, adjacentTo: [A], state: sB });
  assert(dA.attempt !== dB.attempt, "exactly one side of the pair hosts in a given window");
  const host0 = dA.attempt ? A : B;
  assert((dA.attempt ? dA : dB).attempt && (dA.attempt ? dA : (dB as any)).partner === (host0 === A ? B : A), "host attempts with the co-located partner");
  assert((dA.attempt ? dB : dA) && ((dA.attempt ? dB : dA) as any).reason === "not-host-this-window", "the other side reports not-host-this-window");

  // --- the election ROTATES: the side that was blocked hosts within the NEXT window (≼ one window of wait) ---
  const w1 = w0 + 60; // next game-hour window
  const blocked0 = host0 === A ? B : A;
  const dBlockedNext = decideIgnition({ selfId: blocked0, gameMin: w1, adjacentTo: [host0], state: blocked0 === A ? sA : sB });
  assert(dBlockedNext.attempt === true, "the previously-blocked side hosts in the next window (no permanent starvation)");
  const dHostNext = decideIgnition({ selfId: host0, gameMin: w1, adjacentTo: [blocked0], state: host0 === A ? sA : sB });
  assert(dHostNext.attempt === false, "…and the other side yields that window (still exactly one host)");

  // --- ≤2 ticks acceptance shape: tick1 host converts immediately; if only the non-host ticks, tick in the
  //     following window converts — either way a sustained co-location ignites within two of ITS OWN ticks.
  //     (Proven by the two assertions above: w0 host attempt + w1 rotated attempt.)

  // --- REPLY MODE: a say from an adjacent speaker fires regardless of election, once per say id ---
  const sC = new PairSocialState();
  const say = { id: "say-1", from: "courier", text: "Lin's got everyone talking—what's the story?" };
  // courier > barista sorts higher; force the window where barista would NOT host, to prove reply ignores it.
  let win = 0;
  while (electedHost("barista", "courier", win) === "barista") win++;
  const replyTick = decideIgnition({ selfId: "barista", gameMin: win * 60, adjacentTo: ["courier"], heardRecently: [say], state: sC });
  assert(replyTick.attempt && replyTick.mode === "reply" && replyTick.partner === "courier", "an inbound say from an adjacent speaker → reply attempt, election bypassed");
  assert(replyTick.attempt && replyTick.sayText?.includes("story"), "the reply decision carries the line being answered");
  sC.markAnswered((replyTick as any).sayId);
  const replyAgain = decideIgnition({ selfId: "barista", gameMin: win * 60, adjacentTo: ["courier"], heardRecently: [say], state: sC });
  assert(!(replyAgain.attempt && replyAgain.mode === "reply"), "a say is answered at most once");

  // --- reply requires the speaker to still be PRESENT (else the prompt/volition path handles it) ---
  const gone = decideIgnition({ selfId: "barista", gameMin: 0, adjacentTo: [], heardRecently: [say], state: new PairSocialState() });
  assert(gone.attempt === false && gone.reason === "no-candidates", "speaker gone → no mechanical reply");

  // --- same-room union: an interior roommate counts even if exterior adjacency misses them ---
  const sRoom = new PairSocialState();
  const winHost = ((): number => { let w = 0; while (electedHost("baker", "barista", w) !== "baker") w++; return w; })();
  const room = decideIgnition({ selfId: "baker", gameMin: winHost * 60, adjacentTo: [], sameRoomIds: ["barista"], state: sRoom });
  assert(room.attempt === true && room.partner === "barista", "same-interior occupants are ignition candidates");

  // --- rate limit: cooldown blocks an immediate retry; the daily cap blocks the 4th conversation ---
  const sRate = new PairSocialState();
  const hostWin = ((): number => { let w = 0; while (electedHost("ada", "ben", w) !== "ada") w++; return w; })();
  const t0 = hostWin * 60;
  assert(decideIgnition({ selfId: "ada", gameMin: t0, adjacentTo: ["ben"], state: sRate }).attempt, "first conversation allowed");
  sRate.noteConversed("ben", t0);
  const tooSoon = decideIgnition({ selfId: "ada", gameMin: t0 + 10, adjacentTo: ["ben"], state: sRate });
  assert(tooSoon.attempt === false && tooSoon.reason === "cooldown-or-capped", "10 game-min later → cooldown blocks");
  // advance past cooldown twice more (stay in windows where ada hosts by jumping 2 windows = same parity)
  sRate.noteConversed("ben", t0 + 120);
  sRate.noteConversed("ben", t0 + 240);
  const capped = decideIgnition({ selfId: "ada", gameMin: t0 + 360, adjacentTo: ["ben"], state: sRate });
  assert(capped.attempt === false && capped.reason === "cooldown-or-capped", "3 conversations today → daily cap blocks the 4th");
  const nextDay = decideIgnition({ selfId: "ada", gameMin: t0 + 1440 + (electedHost("ada", "ben", Math.floor((t0 + 1440) / 60)) === "ada" ? 0 : 60), adjacentTo: ["ben"], state: sRate });
  assert(nextDay.attempt === true, "a new game-day resets the cap");

  // --- walk_by stamps cooldown but not the cap ---
  const sWalk = new PairSocialState();
  sWalk.noteConversed("zed", 100, { walkBy: true });
  assert(sWalk.countToday("zed", 100) === 0, "walk_by does not consume the daily cap");
  assert(!sWalk.mayConverse("zed", 110, 30, 3), "walk_by still cools the pair down");

  // --- disabled partners are never candidates (D17) ---
  const dis = decideIgnition({ selfId: "ada", gameMin: 0, adjacentTo: ["ben"], enabledIds: ["ada"], state: new PairSocialState() });
  assert(dis.attempt === false && dis.reason === "no-candidates", "a disabled partner is not a candidate");
  assert(dis.candidates.length === 1 && dis.candidates[0].id === "ben" && dis.candidates[0].status === "disabled", "D32: the disabled candidate is NAMED with its suppressor");

  // --- D32: the candidate ledger names every suppressor, every evaluation ---
  {
    const s = new PairSocialState();
    let wA = 0;
    while (electedHost("ada", "ben", wA) !== "ada") wA++;
    const gm = wA * 60;
    s.noteConversed("cara", gm - 5); // cara talked 5 game-min ago → cooldown
    const d = decideIgnition({ selfId: "ada", gameMin: gm, adjacentTo: ["ben", "cara", "dave"], enabledIds: ["ada", "ben", "cara"], state: s });
    const by = new Map(d.candidates.map((c) => [c.id, c.status]));
    assert(d.attempt === true && d.partner === "ben", "ledger case: ben chosen");
    assert(by.get("ben") === "chosen", "D32 ledger: chosen partner marked");
    assert(by.get("cara") === "cooldown", "D32 ledger: cooldown named");
    assert(by.get("dave") === "disabled", "D32 ledger: disabled named");
    // and when nothing fires, the ledger still explains each pair:
    const s2 = new PairSocialState();
    let wB = wA;
    while (electedHost("ada", "ben", wB) === "ada") wB++;
    const d2 = decideIgnition({ selfId: "ada", gameMin: wB * 60, adjacentTo: ["ben"], state: s2 });
    assert(d2.attempt === false && d2.candidates[0].status === "not-host-this-window", "D32 ledger: not-host named on a silent tick");
    const d3 = decideIgnition({ selfId: "ada", gameMin: 0, adjacentTo: [], state: s2 });
    assert(d3.attempt === false && d3.reason === "no-candidates" && d3.candidates.length === 0, "D32 ledger: empty pool is an explicit empty ledger");
  }

  console.log("ignition.ts self-test: ALL ASSERTIONS PASSED (windowed election single-host+rotation · reply-mode bypass+once-per-say · same-room union · cooldown/daily-cap · walk_by · disabled-partner · D32 per-candidate suppressor ledger)");
}
