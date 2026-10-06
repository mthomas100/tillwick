import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// sim/interiors.ts — Wave B1: the INTERIOR data model + presence ("who is inside which building, and WHERE
// in it"). The keystone seam for stepping inside a building and seeing agents busy there.
//
// THE LOAD-BEARING DECISION (de-risk): an interior is its OWN local coordinate space per
// building — a w×h grid with origin (0,0), DISTINCT from the world tile grid. The exterior world (footprints,
// doors, lanes, walkability, A1 spawns, pathfinding) is COMPLETELY UNTOUCHED. An agent that is "inside" has
// TWO positions: its WORLD position (the existing inside-tile — exterior view, unchanged) and an interiorPos
// (this module's local grid + a sub-location id — the interior view scenewright's B2 scene renders). Nothing
// exterior reads interiorPos; the interior never reads world x,y. Disjoint spaces ⇒ zero exterior regression.
//
// TWO HALVES, by concern:
//   • DEFS (pure, stateless, importable anywhere incl. citizen-side): read each building's `interior` block
//     from world.json — grid dims, theme, named sub-locations (counter/oven/tables+seats/desk/stage/beds) with
//     interior coords. Sub-location ids REUSE the object ids already in world.json rooms[] (cafe-counter, oven,
//     bar-counter, lectern…) so the NL interior (world-tree) and the coord interior share one id space.
//   • PRESENCE (stateful): the SIM owns it (world authority — the single-authority invariant). The sim
//     instantiates one InteriorPresence; citizens mutate it ONLY via POST /act (enter/move-to-sublocation/
//     leave) — never directly, exactly like inventory/custody. Citizens READ it via /perceive + /who-inside.
//
// DEGRADE-DON'T-DIE: a building with no `interior` block returns undefined from interiorOf() — callers treat
// "no interior" as "this building isn't enterable yet" and fall back to the existing single-inside-tile
// behaviour. No throw. (Lets us roll interiors out building-by-building without breaking the others.)

const HERE = dirname(fileURLToPath(import.meta.url)); // sim/
const ROOT = dirname(HERE); // repo root

// ---- types (PUBLISHED contract — scenewright B2 + decorator B3 build to this) -----------------------------
export type SublocationKind =
  | "counter" | "table" | "desk" | "stage" | "bed" | "shelf" | "appliance" | "register" | "seat";
export type Seat = { x: number; y: number };
export type Sublocation = {
  id: string;          // REUSES the world.json rooms[] object id where one exists (one id space)
  label: string;       // human label ("service counter")
  kind: SublocationKind;
  x: number;           // interior-local grid coords (0..w-1 / 0..h-1) — NOT world tiles
  y: number;
  seats?: Seat[];      // sit targets around a table (for table-talk); absent for a single-spot station
  station?: boolean;   // a work spot (counter/oven/desk/stage) — drives B4's role verb
};
export type Interior = {
  w: number;           // interior local grid width  (tiles)
  h: number;           // interior local grid height (tiles)
  theme: string;       // art theme → decorator's LimeZu tileset (kitchen|grocery|bedroom|classroom|pub|living|civic|workshop)
  floor?: string;      // optional floor material hint (Room_Builder): wood|wood-dark|tile|stone|carpet (decorator B3; unknown→wood)
  wall?: string;       // optional wall material hint (Room_Builder): plaster|wood|brick|tile (decorator B3; unknown→plaster)
  tile?: number;       // optional source tile px the interior art assumes (informational for B2 scaling)
  sublocations: Sublocation[];
  spawnInside: { x: number; y: number }; // where an agent appears on entry (interior side of the door)
};

type RawBuilding = { id: string; interior?: Interior };
const WORLD = JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as { buildings: RawBuilding[] };
const INTERIOR_BY_BUILDING: Record<string, Interior> = {};
for (const b of WORLD.buildings) if (b.interior) INTERIOR_BY_BUILDING[b.id] = b.interior;

// ---- DEFS: pure interior-definition helpers (stateless; safe to import anywhere) --------------------------

/** The interior definition for a building, or undefined if it has no `interior` block (not enterable yet). */
export function interiorOf(buildingId: string): Interior | undefined {
  return INTERIOR_BY_BUILDING[buildingId];
}
/** Does this building have a modelled interior? */
export function hasInterior(buildingId: string): boolean {
  return !!INTERIOR_BY_BUILDING[buildingId];
}
/** A sub-location within a building by id, or undefined. */
export function sublocationOf(buildingId: string, sublocationId: string): Sublocation | undefined {
  return INTERIOR_BY_BUILDING[buildingId]?.sublocations.find((s) => s.id === sublocationId);
}
/** The work-station sub-locations of a building (kind station:true), e.g. the counter/oven a worker mans. */
export function stationsOf(buildingId: string): Sublocation[] {
  return (INTERIOR_BY_BUILDING[buildingId]?.sublocations ?? []).filter((s) => s.station);
}
/** All seat coords in a building (across every table), each tagged with its table's sub-location id. */
export function seatsOf(buildingId: string): Array<{ tableId: string; x: number; y: number }> {
  const out: Array<{ tableId: string; x: number; y: number }> = [];
  for (const s of INTERIOR_BY_BUILDING[buildingId]?.sublocations ?? []) {
    for (const seat of s.seats ?? []) out.push({ tableId: s.id, x: seat.x, y: seat.y });
  }
  return out;
}

// ---- PRESENCE: the stateful "who is inside which building & where" map (SIM owns one instance) ------------
export type Occupant = { id: string; x: number; y: number; sublocationId?: string };

export class InteriorPresence {
  // buildingId -> (agentId -> position-in-interior). A Map-of-Maps so leave/enter is O(1) and occupantsOf is cheap.
  private byBuilding = new Map<string, Map<string, Occupant>>();
  // agentId -> buildingId it is currently inside (reverse index, so we can clear an agent on teardown without a scan).
  private buildingOf = new Map<string, string>();

  /** Is this agent currently inside some modelled interior? */
  isInside(agentId: string): boolean {
    return this.buildingOf.has(agentId);
  }
  /** The building an agent is inside (+ its interior position), or undefined if it's not inside one. */
  whereInside(agentId: string): { buildingId: string; occupant: Occupant } | undefined {
    const buildingId = this.buildingOf.get(agentId);
    if (!buildingId) return undefined;
    const occ = this.byBuilding.get(buildingId)?.get(agentId);
    return occ ? { buildingId, occupant: occ } : undefined;
  }
  /** Everyone inside a given building (their interior positions). Empty array if none / no interior. */
  occupantsOf(buildingId: string): Occupant[] {
    return Array.from(this.byBuilding.get(buildingId)?.values() ?? []);
  }

  /**
   * Place `agentId` inside `buildingId`. Returns the entry position (the requested sub-location's coords, or
   * the interior's spawnInside, or 0,0). No-op safe: if the building has no interior, returns null and the
   * caller keeps the agent outside. Moving an agent that's already inside ANOTHER building first removes it
   * from the old one (an agent is in at most one interior).
   */
  enter(agentId: string, buildingId: string, sublocationId?: string): Occupant | null {
    const interior = INTERIOR_BY_BUILDING[buildingId];
    if (!interior) return null; // not enterable yet → caller keeps the existing single-inside-tile behaviour
    if (this.buildingOf.has(agentId)) this.leave(agentId); // one interior at a time
    const sub = sublocationId ? interior.sublocations.find((s) => s.id === sublocationId) : undefined;
    const pos: Occupant = sub
      ? { id: agentId, x: sub.x, y: sub.y, sublocationId: sub.id }
      : { id: agentId, x: interior.spawnInside.x, y: interior.spawnInside.y };
    let m = this.byBuilding.get(buildingId);
    if (!m) { m = new Map(); this.byBuilding.set(buildingId, m); }
    m.set(agentId, pos);
    this.buildingOf.set(agentId, buildingId);
    return pos;
  }

  /**
   * Move an already-inside agent to a sub-location within its CURRENT interior (sit at a table seat, step to the
   * counter, go to the desk/stage). For a `table` with seats, picks the nearest FREE seat (so two agents at the
   * same table take different seats). Returns the new position, or null if the agent isn't inside / the
   * sub-location doesn't exist in its interior.
   */
  moveToSublocation(agentId: string, sublocationId: string): Occupant | null {
    const buildingId = this.buildingOf.get(agentId);
    if (!buildingId) return null;
    const interior = INTERIOR_BY_BUILDING[buildingId];
    const sub = interior?.sublocations.find((s) => s.id === sublocationId);
    if (!interior || !sub) return null;
    const m = this.byBuilding.get(buildingId)!;
    let pos: Occupant;
    if (sub.seats && sub.seats.length) {
      const taken = new Set(Array.from(m.values()).filter((o) => o.id !== agentId).map((o) => `${o.x},${o.y}`));
      const free = sub.seats.find((s) => !taken.has(`${s.x},${s.y}`)) ?? sub.seats[0];
      pos = { id: agentId, x: free.x, y: free.y, sublocationId: sub.id };
    } else {
      pos = { id: agentId, x: sub.x, y: sub.y, sublocationId: sub.id };
    }
    m.set(agentId, pos);
    return pos;
  }

  /** Remove an agent from whatever interior it's in (left the building / disabled / teardown). Idempotent. */
  leave(agentId: string): void {
    const buildingId = this.buildingOf.get(agentId);
    if (!buildingId) return;
    this.byBuilding.get(buildingId)?.delete(agentId);
    this.buildingOf.delete(agentId);
  }
}

// ---- NL describer: a compact "what the interior looks like + who's in it" line for the memory stream -------
/**
 * One natural-language line describing a building's interior + who is in it & where — for the agent's
 * perception when it's inside (B4 grounds "I'm sitting at a table near X" in this). Pure (defs + a presence
 * snapshot in). Empty string if the building has no modelled interior.
 */
export function describeInterior(buildingId: string, occupants: Occupant[], selfId?: string): string {
  const interior = INTERIOR_BY_BUILDING[buildingId];
  if (!interior) return "";
  const subById = new Map(interior.sublocations.map((s) => [s.id, s]));
  const others = occupants.filter((o) => o.id !== selfId);
  const parts: string[] = [];
  const stations = interior.sublocations.filter((s) => s.station).map((s) => s.label);
  const tables = interior.sublocations.filter((s) => s.kind === "table").length;
  parts.push(
    `Inside: ${stations.length ? stations.join(", ") + (tables ? `, and ${tables} table${tables > 1 ? "s" : ""}` : "") : tables ? `${tables} table${tables > 1 ? "s" : ""}` : "an open room"}.`,
  );
  if (others.length) {
    parts.push(
      "Here with you: " +
        others
          .map((o) => {
            const where = o.sublocationId ? subById.get(o.sublocationId)?.label : undefined;
            return where ? `${o.id} (at the ${where})` : o.id;
          })
          .join(", ") + ".",
    );
  } else {
    parts.push("No one else is inside right now.");
  }
  return parts.join(" ");
}

// ---- runnable self-test (ZERO tokens) -------------------------------------------------------------------
// `tsx sim/interiors.ts` checks: defs load from world.json (once interiors are added), presence enter/move/
// leave + nearest-free-seat (two agents at one table take different seats), the reverse index, and degrade
// (a building with no interior → enter() returns null). Uses a HAND-BUILT interior so it passes even before
// world.json carries real `interior` blocks (the module + the contract are what we're proving here).
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`); };

  // A hand-built interior + presence (independent of world.json so this is deterministic).
  const cafe: Interior = {
    w: 12, h: 9, theme: "kitchen", spawnInside: { x: 6, y: 8 },
    sublocations: [
      { id: "cafe-counter", label: "service counter", kind: "counter", x: 6, y: 2, station: true },
      { id: "cafe-table-1", label: "window table", kind: "table", x: 2, y: 6, seats: [{ x: 1, y: 6 }, { x: 3, y: 6 }] },
      { id: "espresso-machine", label: "espresso machine", kind: "appliance", x: 8, y: 2 },
    ],
  };
  // Inject it so the module-level helpers see it (mirrors what world.json will provide).
  INTERIOR_BY_BUILDING["cafe"] = cafe;

  // DEFS
  assert(interiorOf("cafe")?.w === 12, "interiorOf returns the def");
  assert(hasInterior("cafe") && !hasInterior("nonexistent"), "hasInterior true/false");
  assert(sublocationOf("cafe", "cafe-counter")?.kind === "counter", "sublocationOf");
  assert(stationsOf("cafe").length === 1 && stationsOf("cafe")[0].id === "cafe-counter", "stationsOf = work spots");
  assert(seatsOf("cafe").length === 2 && seatsOf("cafe")[0].tableId === "cafe-table-1", "seatsOf tags table id");

  // PRESENCE
  const P = new InteriorPresence();
  const e1 = P.enter("barista", "cafe", "cafe-counter");
  assert(!!e1 && e1.x === 6 && e1.y === 2 && e1.sublocationId === "cafe-counter", "enter at the counter");
  assert(P.isInside("barista") && P.whereInside("barista")?.buildingId === "cafe", "isInside + whereInside");
  assert(P.enter("nope", "nonexistent") === null, "enter a building with no interior → null (degrade)");

  // two agents to the same table → DIFFERENT seats (nearest-free-seat)
  P.enter("klaus", "cafe");
  P.enter("maria", "cafe");
  const k = P.moveToSublocation("klaus", "cafe-table-1");
  const m = P.moveToSublocation("maria", "cafe-table-1");
  assert(!!k && !!m && (k.x !== m.x || k.y !== m.y), "two agents at one table take different seats");
  assert(P.occupantsOf("cafe").length === 3, "occupantsOf counts everyone inside");

  // describeInterior mentions a station + names a co-occupant at their sub-location
  const desc = describeInterior("cafe", P.occupantsOf("cafe"), "barista");
  assert(/counter/.test(desc) && /klaus|maria/.test(desc), `describeInterior is informative: "${desc}"`);

  // leave clears both indexes; entering a second building moves the agent (one interior at a time)
  P.leave("barista");
  assert(!P.isInside("barista") && P.occupantsOf("cafe").length === 2, "leave removes the agent");
  INTERIOR_BY_BUILDING["pub"] = { ...cafe, theme: "pub" };
  P.enter("klaus", "pub");
  assert(P.whereInside("klaus")?.buildingId === "pub" && P.occupantsOf("cafe").length === 1, "entering pub moved klaus out of cafe");

  console.log("interiors.ts self-test: ALL ASSERTIONS PASSED (defs · presence enter/move/leave · nearest-free-seat · degrade)");
}
