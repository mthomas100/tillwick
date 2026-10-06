// sim/world-tree.ts — the town as an area→building→room→object TREE (Park et al. Generative Agents,
// UIST '23, §5.1 + Fig 2). The sim/world.json is the data; this module turns it into:
//   (1) a navigable TREE  (town → areas → buildings → rooms → objects)
//   (2) env→NL rendering  (any subtree renders to natural language: "In the kitchen: a stove (off), a fridge…")
//   (3) a per-agent SEEN-SUBGRAPH (each agent only "knows" the parts of the tree it has observed — the
//       paper's key idea that agents act on a *remembered* subgraph of the full environment).
//
// The full world tree is the ground truth the SIM holds; an agent's seen-subgraph is what its COGNITION
// should condition on. This module is pure + sim-owned (it never calls an LLM and never mutates world.json).
//
// LOAD-BEARING SHAPE this preserves (so the existing sim/renderer/shops keep working unchanged):
//   - the flat `buildings[]` with {id,type,label,x,y,w,h,door,color,goods?} is untouched — renderer/main.js,
//     renderer/inspector.js and shops/shop-server.ts all read those flat fields directly.
//   - `spawns:{[id]:{x,y}}` and `buildings[].goods:[{id,price}]` are the PINNED contracts; this module only
//     READS them. The tree (areas[], rooms[], objects[]) and `lanes.cols` are ADDITIVE enrichment.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // sim/

// ---------- world.json shape (additive over the original flat shape) ----------
export type Price = string; // pre-formatted, e.g. "$0.01" (unchanged contract — shops parse it)
export type Good = { id: string; price: Price };
export type WorldObject = { id: string; label: string; state?: string };
export type Room = { id: string; label: string; objects?: WorldObject[] };
export type Building = {
  id: string;
  type: string; // "shop" | "home" | "civic" | …
  label: string;
  area?: string; // id of the owning area (added)
  resident?: string; // citizen id whose home this is (added; homes only)
  x: number; y: number; w: number; h: number;
  door: { x: number; y: number };
  color?: string;
  goods?: Good[]; // shops only (pinned contract)
  producer?: { produces: string; ratePerGameHour?: number; note?: string }; // Harvey Oak (added)
  rooms?: Room[]; // interiors (added)
};
export type Area = {
  id: string;
  label: string;
  kind: string; // "town" | "district" | "campus" | "park" | …
  parent?: string | null;
  buildings?: string[]; // building ids in this area
  objects?: WorldObject[]; // open-air objects (e.g. a park fountain) (added)
};
export type LaneCol = { x: number; y0: number; y1: number };
export type World = {
  title: string;
  width: number; height: number; tile: number;
  street: { rows: number[] };
  sidewalks: { rows: number[] };
  lanes?: { cols?: LaneCol[]; _note?: string }; // additive 2D enrichment (W2-move hook); sim ignores today
  areas?: Area[];
  buildings: Building[];
  spawns: Record<string, { x: number; y: number }>;
};

// ---------- tree node types (the navigable structure) ----------
export type ObjectNode = { kind: "object"; id: string; label: string; state?: string };
export type RoomNode = { kind: "room"; id: string; label: string; objects: ObjectNode[] };
export type BuildingNode = {
  kind: "building"; id: string; type: string; label: string;
  resident?: string; goods?: Good[]; producer?: Building["producer"]; rooms: RoomNode[];
};
export type AreaNode = {
  kind: "area"; id: string; label: string; areaKind: string;
  areas: AreaNode[]; buildings: BuildingNode[]; objects: ObjectNode[];
};
export type TreeNode = AreaNode | BuildingNode | RoomNode | ObjectNode;

// ============================================================================
// WorldTree — builds + serves the area→building→room→object tree from a World.
// ============================================================================
export class WorldTree {
  readonly world: World;
  readonly root: AreaNode;
  private readonly buildingById = new Map<string, BuildingNode>();
  private readonly areaById = new Map<string, AreaNode>();
  private readonly buildingRaw = new Map<string, Building>();
  private readonly areaOfBuilding = new Map<string, string>(); // buildingId -> areaId

  constructor(world: World) {
    this.world = world;
    for (const b of world.buildings) this.buildingRaw.set(b.id, b);
    this.root = this.build();
  }

  // ---- construction: assemble the tree from areas[] + buildings[] (+ open-air objects). ----
  private buildBuildingNode(b: Building): BuildingNode {
    const rooms: RoomNode[] = (b.rooms ?? []).map((r) => ({
      kind: "room" as const,
      id: r.id,
      label: r.label,
      objects: (r.objects ?? []).map((o) => ({ kind: "object" as const, id: o.id, label: o.label, state: o.state })),
    }));
    const node: BuildingNode = {
      kind: "building", id: b.id, type: b.type, label: b.label,
      resident: b.resident, goods: b.goods, producer: b.producer, rooms,
    };
    return node;
  }

  private build(): AreaNode {
    const areas = this.world.areas ?? [];
    // Fallback: no areas[] declared → synthesize a single "town" area holding every building (keeps this
    // module working even against an un-migrated flat world.json).
    if (areas.length === 0) {
      const buildings = this.world.buildings.map((b) => this.regBuilding(b, "town"));
      const root: AreaNode = { kind: "area", id: "town", label: this.world.title, areaKind: "town", areas: [], buildings, objects: [] };
      this.areaById.set("town", root);
      return root;
    }
    // Build every area node (flat), then wire parent/child by `parent`.
    const nodes = new Map<string, AreaNode>();
    for (const a of areas) {
      const node: AreaNode = {
        kind: "area", id: a.id, label: a.label, areaKind: a.kind,
        areas: [], buildings: [],
        objects: (a.objects ?? []).map((o) => ({ kind: "object" as const, id: o.id, label: o.label, state: o.state })),
      };
      nodes.set(a.id, node);
      this.areaById.set(a.id, node);
    }
    // Attach buildings declared on each area.
    for (const a of areas) {
      const node = nodes.get(a.id)!;
      for (const bid of a.buildings ?? []) {
        const raw = this.buildingRaw.get(bid);
        if (!raw) continue; // declared-but-missing building id — skip defensively
        node.buildings.push(this.regBuilding(raw, a.id));
      }
    }
    // Any building NOT claimed by an area (e.g. only `area` field set) → attach via its `area`, else to root.
    const rootId = areas.find((a) => a.parent == null)?.id ?? areas[0].id;
    for (const b of this.world.buildings) {
      if (this.areaOfBuilding.has(b.id)) continue;
      const target = (b.area && nodes.get(b.area)) || nodes.get(rootId)!;
      target.buildings.push(this.regBuilding(b, target.id));
    }
    // Wire area parent/child.
    for (const a of areas) {
      if (a.parent && nodes.has(a.parent)) nodes.get(a.parent)!.areas.push(nodes.get(a.id)!);
    }
    return nodes.get(rootId)!;
  }

  private regBuilding(b: Building, areaId: string): BuildingNode {
    const node = this.buildBuildingNode(b);
    this.buildingById.set(b.id, node);
    this.areaOfBuilding.set(b.id, areaId);
    return node;
  }

  // ---------- lookups ----------
  building(id: string): BuildingNode | undefined { return this.buildingById.get(id); }
  area(id: string): AreaNode | undefined { return this.areaById.get(id); }
  areaOf(buildingId: string): string | undefined { return this.areaOfBuilding.get(buildingId); }
  buildings(): BuildingNode[] { return [...this.buildingById.values()]; }
  room(buildingId: string, roomId: string): RoomNode | undefined {
    return this.building(buildingId)?.rooms.find((r) => r.id === roomId);
  }

  // The full path of NL labels from the town down to a building, e.g. "Tillwick > Main Square > Hobbs Cafe".
  pathToBuilding(buildingId: string): string {
    const areaId = this.areaOf(buildingId);
    const labels: string[] = [];
    let cur = areaId;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const a = this.areaById.get(cur);
      if (!a) break;
      labels.unshift(a.label);
      const raw = (this.world.areas ?? []).find((x) => x.id === cur);
      cur = raw?.parent ?? undefined;
    }
    const b = this.building(buildingId);
    if (b) labels.push(b.label);
    return labels.join(" > ");
  }

  // ============================================================================
  // env→NL — render any subtree to natural language (the paper's Fig 2 idea).
  // ============================================================================
  objectToNL(o: ObjectNode): string {
    return o.state ? `${o.label} (${o.state})` : o.label;
  }

  roomToNL(r: RoomNode): string {
    if (!r.objects.length) return `The ${r.label} is empty.`;
    return `In the ${r.label}: ${r.objects.map((o) => this.objectToNL(o)).join(", ")}.`;
  }

  // One building → NL. `deep` includes each room's objects; otherwise just the room list + goods.
  buildingToNL(b: BuildingNode, deep = true): string {
    const lines: string[] = [];
    const kind = b.type === "shop" ? "shop" : b.type === "home" ? "home" : b.type === "civic" ? "civic building" : b.type;
    lines.push(`${b.label} is a ${kind}.`);
    if (b.goods?.length) lines.push(`It sells: ${b.goods.map((g) => `${g.id} (${g.price})`).join(", ")}.`);
    if (b.producer) lines.push(`It produces ${b.producer.produces} over time.`);
    if (b.resident) lines.push(`${b.resident} lives here.`);
    if (b.rooms.length) {
      if (deep) for (const r of b.rooms) lines.push(this.roomToNL(r));
      else lines.push(`Rooms: ${b.rooms.map((r) => r.label).join(", ")}.`);
    }
    return lines.join(" ");
  }

  // One area → NL. `deep` recurses into buildings (their rooms) and sub-areas.
  areaToNL(a: AreaNode, deep = false): string {
    const lines: string[] = [`${a.label} is a ${a.areaKind}.`];
    if (a.objects.length) lines.push(`Around it: ${a.objects.map((o) => this.objectToNL(o)).join(", ")}.`);
    if (a.buildings.length) {
      lines.push(`Buildings here: ${a.buildings.map((b) => b.label).join(", ")}.`);
      if (deep) for (const b of a.buildings) lines.push(this.buildingToNL(b, true));
    }
    if (a.areas.length) {
      lines.push(`Within it: ${a.areas.map((s) => s.label).join(", ")}.`);
      if (deep) for (const s of a.areas) lines.push(this.areaToNL(s, true));
    }
    return lines.join(" ");
  }

  // Render ANY tree node to NL (dispatch).
  nodeToNL(node: TreeNode, deep = false): string {
    switch (node.kind) {
      case "object": return this.objectToNL(node);
      case "room": return this.roomToNL(node);
      case "building": return this.buildingToNL(node, deep);
      case "area": return this.areaToNL(node, deep);
    }
  }

  // The whole town as NL (the full Fig-2 environment description).
  townToNL(): string { return this.areaToNL(this.root, true); }

  // ---------- "what's here" convenience (for perception / cognition) ----------
  // Everything inside a building, as NL (deep). Falls back to a stub if the id is unknown.
  whatsInBuilding(buildingId: string): string {
    const b = this.building(buildingId);
    return b ? this.buildingToNL(b, true) : `(there is no building "${buildingId}")`;
  }
  whatsInRoom(buildingId: string, roomId: string): string {
    const r = this.room(buildingId, roomId);
    return r ? this.roomToNL(r) : `(there is no room "${roomId}" in "${buildingId}")`;
  }

  // ============================================================================
  // Walkability helpers (door-adjacent inside tile + 2D lane support).
  // ----------------------------------------------------------------------------
  // The CURRENT sim/sim-server.ts computes the inside tile with a single global `streetTop` — correct for a
  // one-corridor map, but for a multi-corridor town it mis-picks the inside tile of buildings on the far side
  // (their door+inside become non-adjacent → A* can't enter them). `doorInsideTile` below is corridor-count-
  // AGNOSTIC: it returns the in-building tile orthogonally adjacent to the door. This is the proposed
  // sim-server HOOK (see the module's HOOKS SPEC). It is exported so the validation driver checks the world
  // against the CORRECT logic, and so W2-move can adopt it verbatim.
  // ============================================================================
  doorInsideTile(b: Pick<Building, "x" | "y" | "w" | "h" | "door">): [number, number] {
    const { x, y, w, h, door } = b;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const nx = door.x + dx, ny = door.y + dy;
      if (nx >= x && nx < x + w && ny >= y && ny < y + h) return [nx, ny];
    }
    return [door.x, door.y]; // degenerate (door not on a building edge) — fall back to the door itself
  }

  // Rows-only lane set (matches the current sim) PLUS optional 2D columns (lanes.cols) when present.
  // `walkable` here is the canonical walkability the driver asserts against; the sim's own walkable() is the
  // committed authority (rows-only today) — these agree for intra-corridor moves; cols only ADD connectivity.
  private laneRows(): Set<number> {
    return new Set<number>([...this.world.street.rows, ...this.world.sidewalks.rows]);
  }
  private buildingTiles(): Set<string> {
    // door + door-adjacent inside tile for every building (what the sim opens up so agents can enter).
    const s = new Set<string>();
    for (const b of this.world.buildings) {
      const [ix, iy] = this.doorInsideTile(b);
      s.add(`${ix},${iy}`);
      s.add(`${b.door.x},${b.door.y}`);
    }
    return s;
  }
  private laneCols(): Array<{ x: number; y0: number; y1: number }> {
    return this.world.lanes?.cols ?? [];
  }
  walkable(x: number, y: number, opts: { use2DLanes?: boolean } = {}): boolean {
    if (x < 0 || y < 0 || x >= this.world.width || y >= this.world.height) return false;
    if (this.laneRows().has(y)) return true;
    if (this.buildingTiles().has(`${x},${y}`)) return true;
    if (opts.use2DLanes) {
      for (const c of this.laneCols()) if (c.x === x && y >= c.y0 && y <= c.y1) return true;
    }
    return false;
  }

  // 4-connected BFS over `walkable` — returns the path length (0 = unreachable). Used by the driver to
  // assert intra-corridor connectivity without depending on the sim's A* implementation.
  pathLen(sx: number, sy: number, tx: number, ty: number, opts: { use2DLanes?: boolean } = {}): number {
    if (!this.walkable(tx, ty, opts) || (sx === tx && sy === ty)) return 0;
    const start = `${sx},${sy}`;
    const q: Array<[number, number, number]> = [[sx, sy, 0]];
    const seen = new Set<string>([start]);
    while (q.length) {
      const [cx, cy, d] = q.shift()!;
      if (cx === tx && cy === ty) return d;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
        if (seen.has(k) || !this.walkable(nx, ny, opts)) continue;
        seen.add(k);
        q.push([nx, ny, d + 1]);
      }
    }
    return 0;
  }
}

// ============================================================================
// SeenSubgraph — what ONE agent has observed of the world (the paper's per-agent
// subgraph). Agents only "know" areas/buildings/rooms/objects they have seen; the
// cognition should render *this* to NL, not the full town.
// ============================================================================
export type SeenSnapshot = {
  agent: string;
  areas: string[];
  buildings: string[];
  rooms: string[]; // "buildingId/roomId"
  objects: Record<string, string | null>; // "buildingId/roomId/objectId" or "area/areaId/objectId" -> last-known state
};

export class SeenSubgraph {
  readonly agent: string;
  private readonly tree: WorldTree;
  private readonly areas = new Set<string>();
  private readonly buildings = new Set<string>();
  private readonly rooms = new Set<string>(); // "buildingId/roomId"
  private readonly objectState = new Map<string, string | null>(); // path -> last-known state (null = stateless)

  constructor(tree: WorldTree, agent: string) {
    this.tree = tree;
    this.agent = agent;
  }

  // Record that the agent saw an AREA (and, lightly, that it exists in the world).
  observeArea(areaId: string): void {
    if (this.tree.area(areaId)) this.areas.add(areaId);
  }

  // Record that the agent saw a BUILDING from outside (its existence + which area it's in). Does NOT reveal
  // interiors — that needs observeInside (you have to go in to see the rooms/objects).
  observeBuilding(buildingId: string): void {
    if (!this.tree.building(buildingId)) return;
    this.buildings.add(buildingId);
    const areaId = this.tree.areaOf(buildingId);
    if (areaId) this.areas.add(areaId);
  }

  // Record that the agent is INSIDE a building (optionally a specific room): reveal that room's objects +
  // their current state into the seen-subgraph. With no roomId, reveals every room of the building.
  observeInside(buildingId: string, roomId?: string): void {
    const b = this.tree.building(buildingId);
    if (!b) return;
    this.observeBuilding(buildingId);
    const rooms = roomId ? b.rooms.filter((r) => r.id === roomId) : b.rooms;
    for (const r of rooms) {
      this.rooms.add(`${buildingId}/${r.id}`);
      for (const o of r.objects) this.objectState.set(`${buildingId}/${r.id}/${o.id}`, o.state ?? null);
    }
  }

  // Record open-air objects of an area the agent is standing in (e.g. the park fountain).
  observeAreaObjects(areaId: string): void {
    const a = this.tree.area(areaId);
    if (!a) return;
    this.observeArea(areaId);
    for (const o of a.objects) this.objectState.set(`area/${areaId}/${o.id}`, o.state ?? null);
  }

  has(buildingId: string): boolean { return this.buildings.has(buildingId); }
  hasRoom(buildingId: string, roomId: string): boolean { return this.rooms.has(`${buildingId}/${roomId}`); }
  knownObjectState(path: string): string | null | undefined { return this.objectState.get(path); }

  snapshot(): SeenSnapshot {
    const objects: Record<string, string | null> = {};
    for (const [k, v] of this.objectState) objects[k] = v;
    return {
      agent: this.agent,
      areas: [...this.areas],
      buildings: [...this.buildings],
      rooms: [...this.rooms],
      objects,
    };
  }

  // Render the agent's KNOWN world to NL — the subgraph it should reason over (not the whole town).
  toNL(): string {
    if (!this.buildings.size && !this.areas.size) return "You have not yet observed anything of the town.";
    const lines: string[] = [];
    for (const areaId of this.areas) {
      const a = this.tree.area(areaId);
      if (a) lines.push(`${a.label} (${a.areaKind}).`);
    }
    for (const buildingId of this.buildings) {
      const b = this.tree.building(buildingId);
      if (!b) continue;
      const knownRooms = b.rooms.filter((r) => this.rooms.has(`${buildingId}/${r.id}`));
      if (knownRooms.length) {
        const roomNL = knownRooms.map((r) => {
          const objs = r.objects.map((o) => {
            const st = this.objectState.get(`${buildingId}/${r.id}/${o.id}`);
            return st ? `${o.label} (${st})` : o.label;
          });
          return objs.length ? `${r.label}: ${objs.join(", ")}` : `${r.label} (empty)`;
        });
        lines.push(`${b.label} — you've been inside: ${roomNL.join("; ")}.`);
      } else {
        lines.push(`${b.label} (${b.type}) — seen from outside.`);
      }
    }
    return lines.join("\n");
  }
}

// ---------- module-level convenience: load the world.json next to this file ----------
export function loadWorld(path = join(HERE, "world.json")): World {
  return JSON.parse(readFileSync(path, "utf8")) as World;
}
export function loadTree(path = join(HERE, "world.json")): WorldTree {
  return new WorldTree(loadWorld(path));
}
