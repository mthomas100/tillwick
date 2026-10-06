// sim/perception.ts — the world→memory bridge (Park et al. Generative Agents, UIST '23, §5.1 perception).
//
// ONE pure function the sim calls inside GET /perceive: given the rich world (WorldTree, the keystone), an
// agent's per-agent SeenSubgraph, and the geometric facts the sim already knows (position, the building it's
// standing in, nearby buildings/agents, adjacency), it
//   (1) UPDATES the SeenSubgraph for what is now visible — nearby building exteriors (observeBuilding), the
//       current building's interior (observeInside), and the current area's open-air objects (observeAreaObjects);
//   (2) ASSEMBLES the enriched perception: the interior NL `here` block (interior + rooms + object state, the
//       H4 logic), the agent's SEEN view vs. ground truth, nearby agents/objects, and a single
//       `observationText` — exactly what should flow into mind.observe() this tick.
//
// SEAM-INJECTED on purpose (the lead wires it into sim-server.ts): it imports ONLY world-tree.ts (types +
// WorldTree/SeenSubgraph). It takes the sim's already-computed geometry as plain input — it does NOT import
// sim-server.ts or any citizen module, does NOT re-derive Chebyshev/tile math (the sim owns that), and never
// calls an LLM or touches disk. That makes it unit-testable with a hand-built tree and trivially callable from
// /perceive. The sim owns each agent's SeenSubgraph (D-world-4: the sim has all positions).
//
// PINNED CONTRACT (do not break): /perceive ADDS fields, never removes — self / agents / buildings /
// currentShop / adjacentTo stay exactly as they are; this module only contributes ADDITIVE fields
// (`here`, `area`, `seen`, `seenText`, `observationText`, `nearbyObjects`). adjacentTo semantics are passed
// through untouched.

import {
  WorldTree,
  SeenSubgraph,
  type SeenSnapshot,
  type BuildingNode,
} from "./world-tree.js";
import { interiorOf, describeInterior, type Sublocation, type Occupant } from "./interiors.js";
import { enrichSpots, type EnrichedSpot } from "../cognition/interior-awareness.js";

// ---- input: the geometry the sim already computes in /perceive, handed to us as plain data ----
export type PerceivedAgent = { id: string; x: number; y: number; dist: number };
export type PerceivedBuilding = { id: string; label: string; type: string; dist?: number };
export type PerceptionInput = {
  self: { id: string; x: number; y: number; usdc?: number | null; moving?: boolean };
  /** building the agent is standing in (sim's tileBuilding lookup), or null if out on a lane. */
  hereBuildingId?: string | null;
  /** OPTIONAL specific room the agent is in. The current sim has no room-tile mapping (rooms are NL-only), so
   *  this is usually undefined → we reveal the whole building's interior. A future move/renderer wave that
   *  maps tiles→rooms can pass a roomId for room-level granularity (the SeenSubgraph already supports it). */
  hereRoomId?: string | null;
  /** buildings within visual range (the sim's nearB), already filtered + labelled. */
  nearBuildings: PerceivedBuilding[];
  /** other agents within visual range (the sim's near). */
  nearAgents: PerceivedAgent[];
  /** ids of agents the sim considers co-located/adjacent (Chebyshev ≤ 1). Passed through verbatim. */
  adjacentTo: string[];
  /** B1 INTERIOR presence (threaded in by the sim, which owns the presence map): the building this agent is
   *  INSIDE (its modelled interior, if any) + WHO else is inside & where. Undefined when the agent is not inside
   *  a modelled interior — perception then behaves exactly as before (degrade). The sim is the only thing that
   *  knows presence; perception.ts stays pure (defs come from interiors.ts; the live occupants come from here). */
  insideBuildingId?: string | null;
  insideOccupants?: Occupant[];
};

// ---- output: the enriched perception (everything ADDITIVE goes under these keys) ----
export type HereView = {
  buildingId: string;
  label: string;
  type: string;
  area: string | null;        // area id this building sits in
  areaLabel: string | null;
  path: string;               // "Tillwick > Main Square > Hobbs Cafe"
  rooms: string[];            // room ids of the building
  nl: string;                 // the rich interior NL (whatsInBuilding) — the H4 block
  isShop: boolean;
};
export type NearbyObject = { path: string; label: string; state: string | null; where: string };
// B1: the INTERIOR the agent is standing in (its local grid + sub-locations to render + who's in it & where).
// This is what scenewright's B2 interior scene + the occupancy badge read. Additive — present only when the
// agent is inside a modelled interior (else undefined; perception is unchanged).
export type InsideHere = {
  buildingId: string;
  interior: { w: number; h: number; theme: string; tile?: number };
  sublocations: Sublocation[];
  occupants: Occupant[];     // everyone inside (incl. self) with their interior coords + sub-location
  // B7: per-spot ENRICHED view (occupancy/empty-vs-occupied/purchasable/conversation) — ADDITIVE, never replaces
  // `sublocations`/`occupants` (scenewright's B2 scene consumes those raw). interiorist's enrichSpots() computes it.
  spots?: EnrichedSpot[];
};
export type AssembledPerception = {
  /** the interior NL block for where the agent stands (null when out on a lane). */
  here: HereView | null;
  /** B1: the modelled interior the agent is inside + live occupants (for the interior scene). Undefined when
   *  the agent isn't inside a modelled interior. ADDITIVE — never replaces `here`. */
  insideHere?: InsideHere;
  /** the area the agent is currently in (by its current building, else null). */
  area: { id: string; label: string; kind: string } | null;
  /** the agent's KNOWN world (its subgraph) — snapshot + NL. This is SEEN, not ground truth. */
  seen: SeenSnapshot;
  seenText: string;
  /** open-air objects visible right here (e.g. a park fountain), if the current area has any. */
  nearbyObjects: NearbyObject[];
  /** the single natural-language observation to feed mind.observe() THIS tick (perceived-now, not cumulative). */
  observationText: string;
};

// ---------------------------------------------------------------------------
// updateSeen — fold what's now visible into the agent's SeenSubgraph (the side effect).
// Returns nothing; mutates `seen`. Split out so it can be reasoned about / tested in isolation.
// ---------------------------------------------------------------------------
export function updateSeen(tree: WorldTree, seen: SeenSubgraph, input: PerceptionInput): void {
  // Nearby building exteriors → known to exist (+ their area), interiors still hidden until entered.
  for (const b of input.nearBuildings) seen.observeBuilding(b.id);
  // The building the agent is standing in → reveal its interior (a specific room if the sim knows one).
  if (input.hereBuildingId) {
    seen.observeInside(input.hereBuildingId, input.hereRoomId ?? undefined);
    // …and the open-air objects of the area that building belongs to (e.g. you're in the park).
    const areaId = tree.areaOf(input.hereBuildingId);
    if (areaId) seen.observeAreaObjects(areaId);
  }
}

// ---------------------------------------------------------------------------
// assemblePerception — the function the sim's /perceive calls. Updates `seen`, then returns the enriched view.
// ---------------------------------------------------------------------------
export function assemblePerception(
  tree: WorldTree,
  seen: SeenSubgraph,
  input: PerceptionInput,
): AssembledPerception {
  // 1) perceive → remember: grow the subgraph for what's visible now.
  updateSeen(tree, seen, input);

  // 2) the rich `here` block (the H4 logic): interior NL + rooms + area + path for the current building.
  let here: HereView | null = null;
  let area: AssembledPerception["area"] = null;
  const nearbyObjects: NearbyObject[] = [];

  const hereNode: BuildingNode | undefined = input.hereBuildingId ? tree.building(input.hereBuildingId) : undefined;
  if (input.hereBuildingId && hereNode) {
    const areaId = tree.areaOf(input.hereBuildingId) ?? null;
    const areaNode = areaId ? tree.area(areaId) : undefined;
    here = {
      buildingId: input.hereBuildingId,
      label: hereNode.label,
      type: hereNode.type,
      area: areaId,
      areaLabel: areaNode?.label ?? null,
      path: tree.pathToBuilding(input.hereBuildingId),
      rooms: hereNode.rooms.map((r) => r.id),
      nl: tree.whatsInBuilding(input.hereBuildingId),
      isShop: hereNode.type === "shop",
    };
    if (areaNode) {
      area = { id: areaNode.id, label: areaNode.label, kind: areaNode.areaKind };
      // open-air objects visible right here (the area's own objects, e.g. Johnson Park's fountain).
      for (const o of areaNode.objects) {
        nearbyObjects.push({ path: `area/${areaNode.id}/${o.id}`, label: o.label, state: o.state ?? null, where: areaNode.label });
      }
    }
  }

  // 3) the SEEN view (the agent's subgraph) — snapshot + NL. Deliberately the agent's *memory* of the world,
  //    not ground truth: a building it hasn't entered shows "seen from outside", object state is last-known.
  const seenSnap = seen.snapshot();
  const seenText = seen.toNL();

  // 3b) B1 INTERIOR: if the agent is inside a modelled interior, surface it (the local grid + sub-locations to
  //     render + live occupants) and a one-line NL describer to fold into the observation. interiorOf() is the
  //     pure def (interiors.ts); the live occupants are threaded in from the sim (which owns presence).
  let insideHere: InsideHere | undefined;
  let interiorNL = "";
  if (input.insideBuildingId) {
    const def = interiorOf(input.insideBuildingId);
    if (def) {
      const occupants = input.insideOccupants ?? [];
      // B7: enrich each spot with occupancy/empty-vs-occupied/purchasable (additive `spots`). The building's
      // goods + shop-ness come from the tree node; live conversations aren't a pure-perception input → omitted
      // here (the topic-aware "JOIN them" lights up where the caller passes conversations, e.g. world-tools).
      const bnode = tree.building(input.insideBuildingId);
      const isShop = bnode?.type === "shop";
      const spots = enrichSpots({
        buildingId: input.insideBuildingId,
        selfId: input.self.id,
        selfSpot: occupants.find((o) => o.id === input.self.id)?.sublocationId ?? null,
        sublocations: def.sublocations,
        occupants,
        ...(isShop && bnode?.goods ? { goods: bnode.goods, isShop: true } : {}),
      });
      insideHere = {
        buildingId: input.insideBuildingId,
        interior: { w: def.w, h: def.h, theme: def.theme, ...(def.tile != null ? { tile: def.tile } : {}) },
        sublocations: def.sublocations,
        occupants,
        spots,
      };
      interiorNL = describeInterior(input.insideBuildingId, occupants, input.self.id);
    }
  }

  // 4) the single observation string for mind.observe() — composed from what the agent perceives NOW. When
  //    inside a modelled interior, the interior describer (who's at which table/counter) is appended so the
  //    agent's memory grounds "I'm at the counter; klaus is at the window table".
  const observationText = [composeObservation(tree, input, here, nearbyObjects), interiorNL].filter(Boolean).join(" ");

  return { here, area, seen: seenSnap, seenText, nearbyObjects, observationText, ...(insideHere ? { insideHere } : {}) };
}

// ---------------------------------------------------------------------------
// composeObservation — the perceived-NOW natural-language line(s) for the memory stream. This is what the
// agent SENSES this tick (location + who/what is here + what's nearby), distinct from `seenText` (the whole
// remembered subgraph). Kept compact + decisive so it reads as one coherent observation.
// ---------------------------------------------------------------------------
function composeObservation(
  tree: WorldTree,
  input: PerceptionInput,
  here: HereView | null,
  nearbyObjects: NearbyObject[],
): string {
  const parts: string[] = [];

  // Where am I.
  if (here) {
    parts.push(`I am in ${here.label}${here.areaLabel ? ` (${here.areaLabel})` : ""}.`);
    parts.push(here.nl); // the interior: rooms + objects + (for shops) goods
  } else {
    parts.push(`I am out on the streets of ${tree.world.title}, not inside any building.`);
  }

  // Open-air objects right here (park fixtures, etc.).
  if (nearbyObjects.length) {
    parts.push(`Nearby: ${nearbyObjects.map((o) => (o.state ? `${o.label} (${o.state})` : o.label)).join(", ")}.`);
  }

  // Who is adjacent (can be talked to) vs. merely visible nearby.
  const adj = new Set(input.adjacentTo);
  if (adj.size) {
    parts.push(`Right next to me: ${[...adj].join(", ")}.`);
  }
  const visibleOnly = input.nearAgents.filter((a) => !adj.has(a.id));
  if (visibleOnly.length) {
    const who = visibleOnly
      .slice()
      .sort((a, b) => a.dist - b.dist)
      .map((a) => `${a.id} (${a.dist} away)`)
      .join(", ");
    parts.push(`I can see, further off: ${who}.`);
  }
  if (!adj.size && !visibleOnly.length) {
    parts.push(`No one else is around right now.`);
  }

  // Buildings I can see around me (by name) — anchors movement decisions.
  if (input.nearBuildings.length) {
    const bl = input.nearBuildings.map((b) => b.label).join(", ");
    parts.push(`Buildings I can see: ${bl}.`);
  }

  return parts.join(" ");
}
