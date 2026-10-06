// sim/earshot.ts — EARSHOT: who can OVERHEAR a conversation/utterance. Every conversation reaches every citizen
// within earshot, so talk is overheard rather than staying a private two-party exchange.
//
// PURE + STATELESS by design (the seam pattern: like perception.ts/interiors.ts defs — no I/O, no LLM, no SDK).
// The SIM owns positions + interior presence (single world-authority); it calls these helpers with the geometry
// it already has. We only do the MATH: given a speaker, the candidate listeners, and where everyone is (world
// tiles + interior-local coords), return who is close enough to hear. The sim fans the gist out to that audience
// and surfaces it per-listener via /perceive `overheard`; behaviorist folds it into the listener's memory.
//
// TWO REGIMES (the load-bearing decision):
//   • INSIDE an interior: earshot is computed on INTERIOR-LOCAL coords (occupant.x,y), NOT world tiles. Every
//     occupant of a building shares ONE world tile, so world-distance is 0 between everyone inside — that would
//     make the whole pub a single earshot blob (bar-talk reaching a far corner). Interior-local Chebyshev with a
//     small radius keeps "the next table over hears you; across the room doesn't." Two agents must be in the
//     SAME building to overhear inside.
//   • OUTSIDE (out on a lane): earshot is world-Chebyshev with a slightly WIDER radius than the ≤1 talk-adjacency
//     gate — you overhear neighbours a couple tiles away, not only the person you're talking to.
//
// PARTICIPANT EXCLUSION (R1): the speaker AND the people they're conversing WITH are never "overhearers" — they
// are IN the conversation. earshotAudience() takes the participant set and removes it. Only the THIRD+ party
// overhears. (A 2-party dialogue at a table with no one else → empty audience, which is correct.)
//
// MIXED INSIDE/OUTSIDE: a listener inside a building and a speaker out on the street do NOT hear each other
// (walls). One inside + one inside a DIFFERENT building: no. Both outside: world regime. Both inside the SAME
// building: interior regime. This falls out of the rules below without a special case.

import type { Occupant } from "./interiors.js";

// ---- tunables (exported so the sim/tests can reference the exact radii) ----------------------------------
/** Interior-local Chebyshev radius for overhearing inside a building (tiles). 3 ≈ "your table + the adjacent
 *  table/station", not the whole room. Tables are a few tiles apart in the world.json interiors. */
export const EARSHOT_INSIDE_TILES = 3;
/** World Chebyshev radius for overhearing out on a lane (tiles). 3 is wider than the ≤1 talk-adjacency so you
 *  catch a nearby exchange, but still local (you don't hear across the map). */
export const EARSHOT_OUTSIDE_TILES = 3;

// ---- the geometry a listener/speaker presents (sim-supplied; no I/O here) ---------------------------------
/** Where an agent is, for earshot purposes. `world` is its exterior tile (always present). `inside` is its
 *  interior building id + interior-local coords IF it's currently inside a modelled interior (else undefined).
 *  This is exactly what the sim already has: world x,y from the agent record, inside from InteriorPresence
 *  (whereInside → {buildingId, occupant:{x,y}}). */
export type AgentLoc = {
  id: string;
  world: { x: number; y: number };
  inside?: { buildingId: string; x: number; y: number };
};

// ---- SHARED RECORD CONTRACTS (one source of truth for the sim ⊳ perception/world-tools ⊳ verify gate) -------
// The sim FILLS these (it has positions + presence + the dialogue/say payloads); behaviorist's perception.ts +
// world-tools.ts READ them off /perceive; the verify gate asserts their shape. Defining them here keeps the
// three consumers from drifting (the kind of drift that silently broke `consume` once — see roleToolNames).
// earshot.ts itself only computes the AUDIENCE (earshotAudience); the sim builds the record around each listener.

/** One overheard utterance/conversation, per listener. The sim pushes one of these per overhearer returned by
 *  earshotAudience(). `kind` separates an overheard one-way say from an overheard 2-party dialogue; `at` is the
 *  SPEAKER's sublocation/place id (so it renders "…at the window table"); `gist` is the line (say) or
 *  topic+excerpt (dialogue). `to` is the say's addressee when kind==="say" (absent for a dialogue). */
export type OverheardRecord = {
  listener: string;     // the agent that overhears (the /perceive filter key: o.listener === a.id)
  from: string;         // the speaker
  to?: string;          // the addressee (one-way say only)
  gist: string;         // what was overheard (say line, or dialogue topic + a short excerpt)
  atGameMin: number;    // absolute game-minutes when it happened
  kind: "say" | "dialogue";
  at?: string;          // the speaker's sublocation/place id, when inside (for "…at the <label>")
  // INFORMATION-DIFFUSION flag (behaviorist's Q2 refinement): true when the overheard content carries a
  // diffusable rumor — a sale/shortage/event (DialogueSummary.mentionedBelief, distilled FREE). behaviorist
  // bumps the resulting memory's importance 5→6 when set, so overheard rumor COMPETES in retrieval (the
  // paper-style info-diffusion mechanic, M4-adjacent). The sim passes summary.mentionedBelief straight through
  // on the dialogue fan; undefined/absent for a plain say or non-belief chatter. Only ever true on kind:"dialogue".
  mentionedBelief?: boolean;
};

/** A presence-DELTA the perceiver senses near them: someone entered/left/sat/stood/moved (operator extension,
 *  scenewright-confirmed: "X got up · X left · X entered · X moved to the workbench / sat at the counter"). The
 *  sim computes these by DIFFING the occupant set it already broadcasts on {type:"interior"} (+ town enter/leave)
 *  and scopes them to each perceiver with the SAME earshotAudience(). Ambient context, lower importance than
 *  overheard. Verb meanings (so the sim emits the right one off the presence diff):
 *    • "entered" — appeared inside a building (interior presence gained).
 *    • "left"    — left the building entirely (interior presence lost).
 *    • "sat"     — took a SEAT/table sub-location (go_inside to a table/seat).
 *    • "stood"   — got up FROM a seat but is still in the room (sublocationId cleared / moved off a seat) — the
 *                  operator's "X got up", distinct from "left" the whole place.
 *    • "moved"   — moved to a non-seat sub-location (station/desk/stage/shelf, i.e. go_inside elsewhere).
 *    • "approached" — STREET approach (town-alive A4): someone out on a lane just converged into earshot range
 *                  of the listener (crossed INTO EARSHOT_OUTSIDE_TILES this tick). The street analogue of the
 *                  interior presence-deltas — the "X is coming your way" cue Pillar III's street-notice needs.
 *                  Emitted per DIRECTION (A approached B ⇒ listener B; B approached A ⇒ listener A). */
export type NearbyEventVerb = "entered" | "left" | "sat" | "stood" | "moved" | "approached";
export type NearbyEventRecord = {
  listener: string;     // the agent that senses it (the /perceive filter key)
  actor: string;        // who moved
  verb: NearbyEventVerb;
  place: string;        // the building/sublocation/place id it happened at
  atGameMin: number;
};

// A presence delta BEFORE it's fanned to listeners (no `listener`/`atGameMin` yet — the sim stamps those when it
// fans via earshotAudience). What diffPresence() returns: one of these per agent whose presence/spot changed.
export type PresenceDelta = { actor: string; verb: NearbyEventVerb; place: string };

// A minimal occupant snapshot for the diff (structural — matches interiors.ts Occupant; we only need id + spot).
export type OccupantSnapshot = { id: string; sublocationId?: string };

/**
 * diffPresence — the PURE presence-delta computation scenewright asked for. Given a building's PRIOR and NEXT
 * occupant snapshots (the sim already broadcasts the occupant set on every {type:"interior"} event — enter/leave/
 * go_inside all re-broadcast it), return the human-meaningful deltas: who ENTERED, who LEFT, who SAT at a table,
 * who STOOD up from a seat, who MOVED to another spot. The sim diffs the broadcast vs the prior snapshot, then
 * fans each delta to the in-earshot audience (earshotAudience) and surfaces them per-listener on /perceive.
 *
 * `kindOf(subId)` resolves a sublocation id → its kind (table/seat/counter/station/…), so we can tell "sat at a
 * table" from "moved to the workbench". The sim has this from interiors.ts (sublocationOf(buildingId, id)?.kind).
 * Pass `() => undefined` if you don't care about sat-vs-moved granularity (everything seated→"moved").
 *
 * Verb rules (mirrors NearbyEventVerb docs):
 *   • in next, not prev          → "entered"  (place = buildingId)
 *   • in prev, not next          → "left"     (place = buildingId)
 *   • spot unchanged             → (no delta)
 *   • spot changed, new is seat  → "sat"      (place = new sublocationId)
 *   • spot changed, new cleared  → "stood"    (place = buildingId — they got up but are still inside)
 *   • spot changed, else         → "moved"    (place = new sublocationId, or buildingId if none)
 * Pure + deterministic: same inputs → same output, no I/O. Order: entered, then left, then changed (stable).
 */
export function diffPresence(
  prev: OccupantSnapshot[],
  next: OccupantSnapshot[],
  buildingId: string,
  kindOf: (sublocationId: string) => string | undefined = () => undefined,
): PresenceDelta[] {
  const prevById = new Map(prev.map((o) => [o.id, o]));
  const nextById = new Map(next.map((o) => [o.id, o]));
  const seated = (subId?: string) => {
    if (!subId) return false;
    const k = kindOf(subId);
    return k === "table" || k === "seat";
  };
  const out: PresenceDelta[] = [];
  // entered (in next, not prev)
  for (const o of next) if (!prevById.has(o.id)) out.push({ actor: o.id, verb: "entered", place: buildingId });
  // left (in prev, not next)
  for (const o of prev) if (!nextById.has(o.id)) out.push({ actor: o.id, verb: "left", place: buildingId });
  // changed spot (in both, sublocationId differs)
  for (const o of next) {
    const before = prevById.get(o.id);
    if (!before) continue; // already counted as entered
    if (before.sublocationId === o.sublocationId) continue; // no change
    if (o.sublocationId == null) {
      out.push({ actor: o.id, verb: "stood", place: buildingId }); // got up, still inside
    } else if (seated(o.sublocationId)) {
      out.push({ actor: o.id, verb: "sat", place: o.sublocationId });
    } else {
      out.push({ actor: o.id, verb: "moved", place: o.sublocationId });
    }
  }
  return out;
}

// Chebyshev (king-move) distance — the same metric the sim uses for adjacency/visual range.
function cheb(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Can `listener` overhear something said by `speaker`, given where they both are? Pure boolean.
 *   - both inside the SAME building → interior-local Chebyshev ≤ EARSHOT_INSIDE_TILES.
 *   - both outside (neither inside) → world Chebyshev ≤ EARSHOT_OUTSIDE_TILES.
 *   - one inside / one outside, or inside DIFFERENT buildings → false (walls).
 * A speaker never "overhears" itself (id equality → false).
 */
export function withinEarshot(speaker: AgentLoc, listener: AgentLoc, opts?: { insideTiles?: number; outsideTiles?: number }): boolean {
  if (speaker.id === listener.id) return false;
  const insideR = opts?.insideTiles ?? EARSHOT_INSIDE_TILES;
  const outsideR = opts?.outsideTiles ?? EARSHOT_OUTSIDE_TILES;
  const sIn = speaker.inside;
  const lIn = listener.inside;
  if (sIn && lIn) {
    // both inside: only the SAME building, on interior-local coords.
    if (sIn.buildingId !== lIn.buildingId) return false;
    return cheb(sIn.x, sIn.y, lIn.x, lIn.y) <= insideR;
  }
  if (!sIn && !lIn) {
    // both outside: world coords.
    return cheb(speaker.world.x, speaker.world.y, listener.world.x, listener.world.y) <= outsideR;
  }
  // one inside, one outside → walls block it.
  return false;
}

/**
 * The set of agent ids that OVERHEAR a conversation/utterance by `speakerId` — everyone within earshot, MINUS
 * the participants (who are in the conversation, not overhearing it). Pure: takes the speaker id, the
 * participant ids to exclude, and the locations of all candidate listeners. Returns ids in stable input order.
 *
 * `participants` should include the speaker and (for a dialogue) the other party/parties; for a one-way say it's
 * typically [speaker, addressee]. Anyone in `participants` is excluded from the audience even if within earshot.
 */
export function earshotAudience(
  speakerId: string,
  participants: string[],
  locs: AgentLoc[],
  opts?: { insideTiles?: number; outsideTiles?: number },
): string[] {
  const speaker = locs.find((l) => l.id === speakerId);
  if (!speaker) return []; // unknown speaker position → no audience (degrade)
  const exclude = new Set([speakerId, ...participants]);
  const out: string[] = [];
  for (const l of locs) {
    if (exclude.has(l.id)) continue;
    if (withinEarshot(speaker, l, opts)) out.push(l.id);
  }
  return out;
}

// ---- STREET APPROACH (town-alive A4: the street was presence-delta blind) --------------------------------

/** One street convergence: `a` and `b` (both out on a lane) came within earshot of each other this tick.
 *  `dist` is their new world-Chebyshev distance. Symmetric — the sim fans one "approached" nearbyEvent in
 *  EACH direction (listener a / actor b, and listener b / actor a). */
export type ApproachDelta = { a: string; b: string; dist: number };

/**
 * approachDeltas — PURE street-approach detection. Given the fleet's positions LAST tick (`prev`) and THIS
 * tick (`next`), return every pair that is (a) both OUTSIDE now, and (b) just CROSSED INTO street earshot:
 * world-Chebyshev was > radius last tick (or a member was inside a building) and is ≤ radius now. Firing only
 * on the crossing edge means one event per approach, not a per-tick spam while two agents walk together —
 * the same "delta, not state" principle as diffPresence. Pairs already within radius last tick don't re-fire.
 *
 * The sim calls this in its 500 ms tick loop with the locs it already builds for earshot (locsForEarshot),
 * keeping the previous snapshot; each returned pair fans one "approached" nearbyEvent per direction. Pure +
 * deterministic; an agent missing from `prev` (just spawned) counts as "was out of range" so a spawn beside
 * you still reads as an arrival.
 */
export function approachDeltas(
  prev: AgentLoc[],
  next: AgentLoc[],
  opts?: { radius?: number },
): ApproachDelta[] {
  const radius = opts?.radius ?? EARSHOT_OUTSIDE_TILES;
  const prevById = new Map(prev.map((l) => [l.id, l]));
  const outsideNow = next.filter((l) => !l.inside);
  const out: ApproachDelta[] = [];
  for (let i = 0; i < outsideNow.length; i++) {
    for (let j = i + 1; j < outsideNow.length; j++) {
      const A = outsideNow[i], B = outsideNow[j];
      const dist = cheb(A.world.x, A.world.y, B.world.x, B.world.y);
      if (dist > radius) continue; // not within earshot now
      const pa = prevById.get(A.id);
      const pb = prevById.get(B.id);
      // "was in range last tick" only when BOTH were outside and close — anything else (apart, one inside,
      // one unknown/new) means this tick is a genuine crossing.
      const wasInRange =
        !!pa && !!pb && !pa.inside && !pb.inside &&
        cheb(pa.world.x, pa.world.y, pb.world.x, pb.world.y) <= radius;
      if (!wasInRange) out.push({ a: A.id, b: B.id, dist });
    }
  }
  return out;
}

/**
 * Convenience for the sim: build an AgentLoc from the world record + an optional InteriorPresence occupant.
 * `occ` is presence.whereInside(id)?.occupant (interior-local x,y + buildingId), or undefined if outside.
 * Kept here so the sim has one obvious call-site and the inside/outside shape is constructed consistently.
 */
export function agentLoc(id: string, world: { x: number; y: number }, inside?: { buildingId: string; occupant: Pick<Occupant, "x" | "y"> }): AgentLoc {
  return inside
    ? { id, world: { x: world.x, y: world.y }, inside: { buildingId: inside.buildingId, x: inside.occupant.x, y: inside.occupant.y } }
    : { id, world: { x: world.x, y: world.y } };
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx sim/earshot.ts` checks both regimes, the wall rules, participant exclusion, and the radii boundaries.
// Pure math → fully deterministic, no sim, no model, no disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`); };

  // --- INSIDE regime: interior-local coords decide earshot, same building only ---
  // Layout in cafe interior: bar talkers at the counter (6,2)+(6,3); a near table at (8,2); a far table at (1,8).
  const cafeSpeaker = agentLoc("isabella", { x: 50, y: 50 }, { buildingId: "cafe", occupant: { x: 6, y: 2 } });
  const cafePartner = agentLoc("klaus",    { x: 50, y: 50 }, { buildingId: "cafe", occupant: { x: 6, y: 3 } });
  const cafeNear    = agentLoc("maria",    { x: 50, y: 50 }, { buildingId: "cafe", occupant: { x: 8, y: 2 } }); // 2 tiles from speaker → hears
  const cafeFar     = agentLoc("sam",      { x: 50, y: 50 }, { buildingId: "cafe", occupant: { x: 1, y: 8 } }); // far → doesn't
  const otherBldg   = agentLoc("yusuf",    { x: 50, y: 50 }, { buildingId: "pub",  occupant: { x: 6, y: 2 } }); // different building → never

  assert(withinEarshot(cafeSpeaker, cafeNear), "inside: a table 2 tiles away is within earshot");
  assert(!withinEarshot(cafeSpeaker, cafeFar), "inside: a far corner table is NOT within earshot");
  assert(!withinEarshot(cafeSpeaker, otherBldg), "inside: a different building is never within earshot (walls)");
  // world position is IDENTICAL for all (they share the café tile) — proves we use interior coords, not world.
  assert(cafeSpeaker.world.x === cafeFar.world.x && cafeSpeaker.world.y === cafeFar.world.y, "all café occupants share one world tile (the R2 trap)");

  // audience of isabella↔klaus's conversation: maria (near) overhears; klaus is a participant; sam too far; yusuf elsewhere.
  const insideAudience = earshotAudience("isabella", ["isabella", "klaus"], [cafeSpeaker, cafePartner, cafeNear, cafeFar, otherBldg]);
  assert(JSON.stringify(insideAudience) === JSON.stringify(["maria"]), `inside audience = the near non-participant only (got ${JSON.stringify(insideAudience)})`);
  // participant exclusion: klaus must NOT be in his own conversation's audience even though he's adjacent.
  assert(!insideAudience.includes("klaus"), "a participant never overhears their own conversation (R1)");

  // --- boundary: exactly EARSHOT_INSIDE_TILES away hears; one past does not ---
  const onEdge  = agentLoc("edge",  { x: 0, y: 0 }, { buildingId: "cafe", occupant: { x: 6 + EARSHOT_INSIDE_TILES, y: 2 } });
  const offEdge = agentLoc("offedge", { x: 0, y: 0 }, { buildingId: "cafe", occupant: { x: 6 + EARSHOT_INSIDE_TILES + 1, y: 2 } });
  assert(withinEarshot(cafeSpeaker, onEdge), "inside: exactly EARSHOT_INSIDE_TILES away is within earshot");
  assert(!withinEarshot(cafeSpeaker, offEdge), "inside: one tile past the radius is out of earshot");

  // --- OUTSIDE regime: world coords decide; wider-than-adjacency radius ---
  const streetSpeaker = agentLoc("a", { x: 10, y: 10 });
  const streetNear    = agentLoc("b", { x: 12, y: 11 }); // cheb 2 → hears
  const streetFar     = agentLoc("c", { x: 20, y: 20 }); // far → doesn't
  assert(withinEarshot(streetSpeaker, streetNear), "outside: 2 tiles away on the street is within earshot");
  assert(!withinEarshot(streetSpeaker, streetFar), "outside: across the map is not within earshot");

  // --- MIXED inside/outside → walls block it ---
  const insideOne  = agentLoc("in",  { x: 10, y: 10 }, { buildingId: "cafe", occupant: { x: 6, y: 2 } });
  const outsideOne = agentLoc("out", { x: 10, y: 10 }); // SAME world tile, but one is inside → no
  assert(!withinEarshot(insideOne, outsideOne), "mixed inside/outside does not carry, even on the same world tile (walls)");

  // --- degrade: unknown speaker id → empty audience ---
  assert(earshotAudience("ghost", ["ghost"], [streetSpeaker, streetNear]).length === 0, "unknown speaker → empty audience (degrade)");

  // --- self never overhears self ---
  assert(!withinEarshot(streetSpeaker, streetSpeaker), "an agent never overhears itself");

  // --- diffPresence: presence-deltas from prior→next occupant snapshots (the nearbyEvents source) ---
  // kind resolver for a pub-like interior: tables/bar seats are seated; stage/counter are not.
  const kindOf = (id: string): string | undefined =>
    ({ "pub-table-1": "table", "pub-table-2": "table", "bar-counter": "counter", "pub-stage": "stage" } as Record<string, string>)[id];

  // ENTERED: maria appears (was not in prev).
  let d = diffPresence([{ id: "klaus", sublocationId: "pub-table-1" }], [{ id: "klaus", sublocationId: "pub-table-1" }, { id: "maria" }], "pub", kindOf);
  assert(d.length === 1 && d[0].actor === "maria" && d[0].verb === "entered" && d[0].place === "pub", `entered: ${JSON.stringify(d)}`);

  // LEFT: klaus disappears (was in prev, not next).
  d = diffPresence([{ id: "klaus", sublocationId: "pub-table-1" }, { id: "maria" }], [{ id: "maria" }], "pub", kindOf);
  assert(d.length === 1 && d[0].actor === "klaus" && d[0].verb === "left" && d[0].place === "pub", `left: ${JSON.stringify(d)}`);

  // SAT: maria goes from the door (no spot) → a table seat. place = the sublocation id.
  d = diffPresence([{ id: "maria" }], [{ id: "maria", sublocationId: "pub-table-1" }], "pub", kindOf);
  assert(d.length === 1 && d[0].verb === "sat" && d[0].place === "pub-table-1", `sat: ${JSON.stringify(d)}`);

  // STOOD: maria gets up from a table seat → no spot, still inside. place = the building.
  d = diffPresence([{ id: "maria", sublocationId: "pub-table-1" }], [{ id: "maria" }], "pub", kindOf);
  assert(d.length === 1 && d[0].verb === "stood" && d[0].place === "pub", `stood: ${JSON.stringify(d)}`);

  // MOVED: maria goes from a table → the stage (a non-seat station). place = the new sublocation.
  d = diffPresence([{ id: "maria", sublocationId: "pub-table-1" }], [{ id: "maria", sublocationId: "pub-stage" }], "pub", kindOf);
  assert(d.length === 1 && d[0].verb === "moved" && d[0].place === "pub-stage", `moved: ${JSON.stringify(d)}`);

  // NO-OP: unchanged occupant set + spots → no deltas.
  const same = [{ id: "klaus", sublocationId: "pub-table-1" }, { id: "maria", sublocationId: "pub-stage" }];
  assert(diffPresence(same, same, "pub", kindOf).length === 0, "unchanged snapshot → no deltas");

  // COMBINED: one enters, one leaves, one sits — all in one diff, stable order (entered, left, then changed).
  d = diffPresence(
    [{ id: "klaus", sublocationId: "pub-table-1" }, { id: "sam" }],
    [{ id: "sam", sublocationId: "pub-table-2" }, { id: "yusuf" }],
    "pub", kindOf,
  );
  assert(d.some((x) => x.actor === "yusuf" && x.verb === "entered"), "combined: yusuf entered");
  assert(d.some((x) => x.actor === "klaus" && x.verb === "left"), "combined: klaus left");
  assert(d.some((x) => x.actor === "sam" && x.verb === "sat" && x.place === "pub-table-2"), "combined: sam sat at table-2");
  assert(d.length === 3, `combined: exactly 3 deltas (got ${d.length})`);

  // kindOf default (no resolver) → a seated move still classifies as "moved" (no sat granularity), never throws.
  const dDefault = diffPresence([{ id: "a" }], [{ id: "a", sublocationId: "pub-table-1" }], "pub");
  assert(dDefault[0].verb === "moved", "no kind resolver → seated change is 'moved' (degrade, no throw)");

  // --- approachDeltas: street convergence fires ONCE on crossing into range ---
  const at = (id: string, x: number, y: number, inside?: string): AgentLoc =>
    inside ? { id, world: { x, y }, inside: { buildingId: inside, x: 0, y: 0 } } : { id, world: { x, y } };
  // p walks toward q: far (cheb 5) → in range (cheb 3) → fires once; staying close → no re-fire.
  let ad = approachDeltas([at("p", 0, 0), at("q", 5, 0)], [at("p", 2, 0), at("q", 5, 0)]);
  assert(ad.length === 1 && ad[0].a === "p" && ad[0].b === "q" && ad[0].dist === 3, `approach fires on crossing (got ${JSON.stringify(ad)})`);
  ad = approachDeltas([at("p", 2, 0), at("q", 5, 0)], [at("p", 3, 0), at("q", 5, 0)]);
  assert(ad.length === 0, "already in range last tick → no re-fire (delta, not state)");
  // one steps OUT of a building beside the other → genuine crossing (prev had them inside).
  ad = approachDeltas([at("p", 5, 7, "cafe"), at("q", 6, 7)], [at("p", 5, 7), at("q", 6, 7)]);
  assert(ad.length === 1, "stepping out of a building into range counts as an approach");
  // both inside now → never (street-only signal).
  ad = approachDeltas([at("p", 0, 0), at("q", 9, 9)], [at("p", 5, 7, "cafe"), at("q", 5, 7, "cafe")]);
  assert(ad.length === 0, "inside agents produce no street approach");
  // a newly-spawned agent (absent from prev) beside you → fires (arrival is an approach).
  ad = approachDeltas([at("q", 5, 0)], [at("p", 4, 0), at("q", 5, 0)]);
  assert(ad.length === 1, "an agent new to the snapshot in range → approach fires");
  // out of range stays silent.
  ad = approachDeltas([at("p", 0, 0), at("q", 9, 9)], [at("p", 1, 0), at("q", 9, 9)]);
  assert(ad.length === 0, "far apart → no approach");

  console.log("earshot.ts self-test: ALL ASSERTIONS PASSED (inside interior-coords · outside world-coords · walls · participant-exclusion · radii boundaries · degrade · diffPresence entered/left/sat/stood/moved/combined · approachDeltas crossing/re-fire/walls/spawn)");
}
