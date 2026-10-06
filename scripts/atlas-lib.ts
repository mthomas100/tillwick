// scripts/atlas-lib.ts — shared ground-truth helpers for the WORLD ATLAS + the replayer (T0-tape).
//
// One job: answer "what IS this building/object, where IS it, and what will it LOOK like" from the real
// sources — sim/world.json (geometry), renderer/phaser/assets.js (the REAL alias table, driven through a
// mock Phaser scene so we execute the renderer's own resolution code instead of copying it), and the
// gitignored LimeZu crops on disk (PNG headers read directly for pixel truth). Pure reads; no LLM; no sim.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-ignore — browser-side ESM module without type declarations (allowJs off); we drive it with a mock scene
import { PACKS } from "../renderer/phaser/assets.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
export const ROOT = dirname(HERE); // repo root
export const LIMEZU_DIR = join(ROOT, "renderer", "phaser", "assets", "limezu");

// ---- world.json shapes (the atlas superset of telemetry's World) ----------------------------------------
export type Seat = { x: number; y: number };
export type Sublocation = {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  seats?: Seat[];
  station?: boolean;
};
export type Interior = {
  w: number;
  h: number;
  theme: string;
  floor?: string;
  wall?: string;
  tile?: number;
  spawnInside: { x: number; y: number };
  sublocations: Sublocation[];
};
export type AtlasBuilding = {
  id: string;
  type: string;
  label: string;
  area?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: { x: number; y: number };
  color?: string;
  goods?: Array<{ id: string; price: string }>;
  resident?: string;
  producer?: { produces: string };
  rooms?: Array<{ id: string; label: string; objects: Array<{ id: string; label: string; state?: string }> }>;
  interior?: Interior;
};
export type AtlasWorld = {
  width: number;
  height: number;
  street: { rows: number[] };
  sidewalks: { rows: number[] };
  areas?: Array<{ id: string; label?: string; buildings?: string[] }>;
  buildings: AtlasBuilding[];
  spawns?: Record<string, { x: number; y: number }>;
};

export function loadWorld(): AtlasWorld {
  return JSON.parse(readFileSync(join(ROOT, "sim", "world.json"), "utf8")) as AtlasWorld;
}

/** The single inside tile the sim routes goTo() to — MIRRORS sim-server.ts insideTile(). */
export function insideTile(b: AtlasBuilding, streetTop: number): [number, number] {
  const top = b.y < streetTop;
  return [b.door.x, top ? b.y + b.h - 1 : b.y];
}

// ---- PNG pixel truth (IHDR header: width/height as uint32BE at offsets 16/20) ---------------------------
export function pngDims(file: string): { w: number; h: number } | null {
  try {
    const buf = readFileSync(file);
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452 /* "IHDR" */) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// ---- drive the RENDERER'S OWN alias resolution through a mock scene -------------------------------------
// assets.js interiorObject() checks scene.textures.exists(key) for keys like "limezu:int:obj:table-dark".
// We answer that from the filesystem, so the resolution we report is exactly what the browser will do
// (crop present → that art; crop absent → placeholder rect), with zero copied tables.

function keyToFile(k: string): string | null {
  const m = /^limezu:int:(obj|floor|wall):(.+)$/.exec(k);
  if (!m) return null;
  const sub = m[1] === "obj" ? "objects" : m[1] === "floor" ? "floors" : "walls";
  return join(LIMEZU_DIR, "interiors", sub, `${m[2]}.png`);
}

const graphicsStub = {
  fillStyle: () => graphicsStub,
  fillRect: () => graphicsStub,
  generateTexture: () => graphicsStub,
  destroy: () => graphicsStub,
} as const;

const mockScene = {
  textures: { exists: (k: string) => { const f = keyToFile(k); return !!f && existsSync(f); } },
  add: { graphics: () => graphicsStub },
};

type LimezuPack = {
  interiorObject: (scene: unknown, name: string) => string | null;
  interiorFloor: (scene: unknown, kind: string) => string;
  interiorWall: (scene: unknown, variant: string) => string;
};
const limezu = (PACKS as Record<string, unknown>).limezu as LimezuPack;

/** The full asset chain for one sublocation, exactly as the interior scene will resolve it. */
export type AssetChain = {
  requestedId: string; // the sublocation id tried first (interior-scene.js drawFurniture order)
  requestedKind: string; // the kind fallback
  resolvedVia: "id" | "kind" | null; // which request hit
  textureKey: string | null; // e.g. limezu:int:obj:table-dark (null → placeholder rect)
  cropName: string | null; // table-dark
  file: string | null; // absolute crop path
  px: { w: number; h: number } | null; // real pixel dims from the PNG header
};

export function resolveAssetChain(sub: Pick<Sublocation, "id" | "kind">): AssetChain {
  const byId = limezu.interiorObject(mockScene, sub.id);
  const byKind = byId ? null : limezu.interiorObject(mockScene, sub.kind);
  const key = byId ?? byKind;
  const file = key ? keyToFile(key) : null;
  const crop = key ? key.split(":").pop()! : null;
  return {
    requestedId: sub.id,
    requestedKind: sub.kind,
    resolvedVia: byId ? "id" : byKind ? "kind" : null,
    textureKey: key,
    cropName: crop,
    file,
    px: file && existsSync(file) ? pngDims(file) : null,
  };
}

/** Floor/wall texture status for an interior (crop file, or the generated flat-tile fallback). */
export function resolveSurface(kind: "floor" | "wall", material: string): { material: string; file: string | null; generated: boolean } {
  const key = kind === "floor" ? limezu.interiorFloor(mockScene, material) : limezu.interiorWall(mockScene, material);
  const file = keyToFile(key);
  return { material, file: file && existsSync(file) ? file : null, generated: !file || !existsSync(file) };
}

// ---- render-fit math: MIRRORS interior-scene.js drawFurniture() (the sliver mechanism) ------------------
// The scene contain-fits every crop into a single-tile box: scale = min(1.2T/sw, 1.4T/sh), T=48 render px.
// LimeZu interior crops are on a 48px source grid, so a 96×48 (2×1-tile) table lands at 1.2×0.6 tiles — a
// sliver. squashedFrom reports the source tile-span whenever the art spans more than one source tile.
export const RENDER_T = 48;
export const SRC_TILE = 48;
export type RenderFit = {
  dispW: number; // rendered px
  dispH: number;
  dispTilesW: number; // rendered size in render tiles (1dp)
  dispTilesH: number;
  srcTilesW: number; // how many source tiles the art actually spans
  srcTilesH: number;
  squashed: boolean; // art spans >1 source tile but is crushed into the 1-tile box
};
export function renderFit(px: { w: number; h: number }): RenderFit {
  const scale = Math.min((RENDER_T * 1.2) / px.w, (RENDER_T * 1.4) / px.h);
  const dispW = px.w * scale;
  const dispH = px.h * scale;
  const srcTilesW = px.w / SRC_TILE;
  const srcTilesH = px.h / SRC_TILE;
  return {
    dispW: round1(dispW),
    dispH: round1(dispH),
    dispTilesW: round1(dispW / RENDER_T),
    dispTilesH: round1(dispH / RENDER_T),
    srcTilesW: round1(srcTilesW),
    srcTilesH: round1(srcTilesH),
    squashed: srcTilesW > 1.05 || srcTilesH > 1.05,
  };
}

// ---- ASCII floorplan ------------------------------------------------------------------------------------
const KIND_GLYPH: Record<string, string> = {
  counter: "C", appliance: "A", table: "T", register: "R", desk: "D",
  stage: "G", bed: "B", shelf: "S", seat: "s",
};

/**
 * Render an interior as ASCII: '#' border walls, '.' floor, furniture by kind glyph, 'ˢ' seats,
 * '+' the spawn/entry tile, digits 1-9 for occupants (occupant list order). Legend returned alongside.
 */
export function floorplanAscii(
  interior: Interior,
  occupants: Array<{ id: string; x: number; y: number }> = [],
): { lines: string[]; legend: string[] } {
  const W = interior.w, H = interior.h;
  const grid: string[][] = Array.from({ length: H + 2 }, (_, r) =>
    Array.from({ length: W + 2 }, (_, c) => (r === 0 || r === H + 1 || c === 0 || c === W + 1 ? "#" : "·")),
  );
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && y >= 0 && x < W && y < H) grid[y + 1][x + 1] = ch;
  };
  const legend: string[] = [];
  for (const s of interior.sublocations) {
    for (const seat of s.seats ?? []) put(seat.x, seat.y, "ˢ");
  }
  for (const s of interior.sublocations) {
    const g = KIND_GLYPH[s.kind] ?? "?";
    put(s.x, s.y, s.station ? g : g.toLowerCase() === g ? g : g); // stations keep uppercase; glyphs are already cased
    legend.push(`${g}(${s.x},${s.y}) ${s.label}${s.station ? " ★station" : ""}${s.seats?.length ? ` +${s.seats.length} seats` : ""}`);
  }
  if (interior.spawnInside) put(interior.spawnInside.x, interior.spawnInside.y, "+");
  occupants.forEach((o, i) => {
    put(o.x, o.y, String((i + 1) % 10));
    legend.push(`${(i + 1) % 10}=(${o.x},${o.y}) ${o.id}`);
  });
  return { lines: grid.map((r) => r.join("")), legend };
}

// ---- AFFORDANCES (operator addendum, ledger D28/D32): what can an agent DO at this object? ---------------
// The SHARED VERB VOCABULARY v0 — proposed by flightrecorder, to be confirmed/extended by lifegiver (prompt
// menus) + socialweaver (commerce/social) so the atlas, the tape's menu/choice beats, and the ACT prompt all
// use ONE naming. Each affordance: verb + who may take it + eligibility condition (the "cond" is prose-level
// ground truth; the sim/citizens enforce their own gates — this documents what SHOULD be offered).
export type Affordance = { verb: string; who: "staff" | "visitor" | "resident" | "anyone"; cond?: string };

export const AFFORDANCE_VOCAB: Record<string, string> = {
  work: "man a station (station:true) — produce/serve per role",
  sell: "sell the building's goods over the counter (staff at a counter/register)",
  order: "order/request a good at a counter (visitor; needs staff present)",
  buy: "buy a good — x402 settlement (visitor with funds; needs seller)",
  browse: "look over a shelf/display/produce stand",
  sit: "take a free seat",
  converse: "talk with co-seated agents (≥2 seats at the spot)",
  study: "study/read at a desk",
  busk: "perform for tips on a stage",
  rest: "sleep/rest in a bed",
  // v0.1 — lifegiver/socialweaver's addition (citizens/affordances.ts AtlasVerb), accepted: the
  // own→consume→rebuy demand loop needs its own verb. NOT spot-bound — it rides held inventory
  // (a table/seat is where it happens, but eligibility is "holds the item", not the furniture).
  consume: "consume a held good (eat/drink/use — the demand loop's recurring need)",
};

/** Mechanical affordance derivation from kind + station + seats + building goods/type. `staff` = the
 *  role(s) whose workplace this building is (pass from the role map); empty/undefined = unknown. */
export function affordancesOf(sub: Sublocation, b: AtlasBuilding, staff?: string[]): Affordance[] {
  const out: Affordance[] = [];
  const staffCond = staff?.length ? `role=${staff.join("|")}` : "workplace role";
  const hasGoods = (b.goods?.length ?? 0) > 0;
  if (sub.station) out.push({ verb: "work", who: "staff", cond: staffCond });
  if ((sub.kind === "counter" || sub.kind === "register") && hasGoods) {
    out.push({ verb: "sell", who: "staff", cond: staffCond });
    out.push({ verb: "order", who: "visitor", cond: "staff at a station" });
    out.push({ verb: "buy", who: "visitor", cond: `funds; goods: ${b.goods!.map((g) => g.id).join(",")}` });
  }
  if (sub.kind === "shelf") out.push({ verb: "browse", who: "anyone" });
  if (sub.seats?.length) {
    out.push({ verb: "sit", who: "anyone", cond: "a free seat" });
    if (sub.seats.length >= 2) out.push({ verb: "converse", who: "anyone", cond: "≥2 agents seated here" });
  }
  if (sub.kind === "desk") out.push({ verb: "study", who: "anyone" });
  if (sub.kind === "stage") out.push({ verb: "busk", who: "anyone", cond: "musician primary" });
  if (sub.kind === "bed") out.push({ verb: "rest", who: b.type === "home" ? "resident" : "anyone", cond: b.resident ? `resident=${b.resident}` : undefined });
  return out;
}

/** Compact one-cell rendering: `work[staff:baker] · order[visitor: staff at a station]`. */
export function affordancesCell(affs: Affordance[]): string {
  if (!affs.length) return "— NONE (unknown kind?)";
  return affs.map((a) => `${a.verb}[${a.who}${a.cond ? `: ${a.cond}` : ""}]`).join(" · ");
}

// ---- LAYOUT SMELLS (mechanical, brutal) -----------------------------------------------------------------
export type Smell = { code: string; severity: "high" | "med" | "low"; msg: string };

/** Kinds that read as furniture-against-a-wall in any plausible room. */
const WALL_KINDS = new Set(["counter", "register", "shelf", "appliance", "bed"]);

export function computeSmells(b: AtlasBuilding): Smell[] {
  const out: Smell[] = [];
  if (!b.interior) {
    out.push({
      code: "no-interior",
      severity: "high",
      msg: `no interior model — agents can enter only the single world tile; clicking it in the interior view shows a FABRICATED stub room (interior-scene.js stubInterior), i.e. the renderer lies about this building`,
    });
    return out;
  }
  const it = b.interior;
  const touchingWall = (x: number, y: number) => x === 0 || y === 0 || x === it.w - 1 || y === it.h - 1;
  const tiles = new Map<string, string>(); // occupied tile → sublocation id
  let furnitureTiles = 0;
  let totalSeats = 0;
  let tableCount = 0;

  for (const s of it.sublocations) {
    // bounds
    if (s.x < 0 || s.y < 0 || s.x >= it.w || s.y >= it.h) {
      out.push({ code: "out-of-bounds", severity: "high", msg: `${s.id} at (${s.x},${s.y}) is outside the ${it.w}×${it.h} grid` });
    }
    // overlap
    const k = `${s.x},${s.y}`;
    if (tiles.has(k)) out.push({ code: "spot-overlap", severity: "high", msg: `${s.id} and ${tiles.get(k)} share tile (${s.x},${s.y})` });
    tiles.set(k, s.id);
    furnitureTiles++;
    if (s.kind === "table") tableCount++;
    totalSeats += s.seats?.length ?? 0;
    // spawn collision
    if (it.spawnInside && s.x === it.spawnInside.x && s.y === it.spawnInside.y) {
      out.push({ code: "spawn-collision", severity: "med", msg: `${s.id} sits ON the entry tile (${s.x},${s.y}) — every entrant lands inside the furniture` });
    }
    // wall adjacency
    if (WALL_KINDS.has(s.kind) && !touchingWall(s.x, s.y)) {
      out.push({ code: "not-wall-adjacent", severity: "med", msg: `${s.kind} "${s.id}" floats at (${s.x},${s.y}) — a ${s.kind} should touch a wall (nearest edge ${Math.min(s.x, s.y, it.w - 1 - s.x, it.h - 1 - s.y)} tiles away)` });
    }
    // seats on furniture
    for (const seat of s.seats ?? []) {
      const sk = `${seat.x},${seat.y}`;
      if (tiles.has(sk) && tiles.get(sk) !== s.id) {
        out.push({ code: "seat-on-furniture", severity: "med", msg: `a seat of ${s.id} at (${seat.x},${seat.y}) lands on ${tiles.get(sk)}` });
      }
      if (seat.x < 0 || seat.y < 0 || seat.x >= it.w || seat.y >= it.h) {
        out.push({ code: "seat-out-of-bounds", severity: "high", msg: `a seat of ${s.id} at (${seat.x},${seat.y}) is outside the grid` });
      }
    }
    // dead furniture: a spot that affords NO action (operator addendum — an empty option set is the
    // stuck precursor; flag it here so the vocabulary gap is closed deliberately, not discovered live)
    if (affordancesOf(s, b).length === 0) {
      out.push({ code: "no-affordances", severity: "med", msg: `${s.id} (kind ${s.kind}${s.station ? "" : ", no station"}) affords NO action — dead furniture until a verb is agreed (use/play/warm?)` });
    }
    // asset truth
    const chain = resolveAssetChain(s);
    if (!chain.textureKey) {
      out.push({ code: "crop-missing", severity: "high", msg: `${s.id} (kind ${s.kind}) resolves to NO crop — renders as a bare colored rect with an 8px label` });
    } else if (chain.px) {
      const fit = renderFit(chain.px);
      if (fit.squashed) {
        out.push({
          code: "multi-tile-crop-squashed",
          severity: "high",
          msg: `${s.id} → ${chain.cropName} is ${chain.px.w}×${chain.px.h}px (${fit.srcTilesW}×${fit.srcTilesH} source tiles) crushed into a 1-tile box → renders ${fit.dispTilesW}×${fit.dispTilesH} tiles ("sliver"; interior-scene.js drawFurniture contain-fit)`,
        });
      }
    }
  }
  // label collisions (8px labels at cheb ≤1 overlap on screen)
  const subs = it.sublocations;
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const a = subs[i], c = subs[j];
      if (Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y)) <= 1) {
        out.push({ code: "label-collision", severity: "low", msg: `"${a.label}" (${a.x},${a.y}) and "${c.label}" (${c.x},${c.y}) are adjacent — their 8px ground labels overlap` });
      }
    }
  }
  // sparseness — the "huge empty beige room" number
  const coverage = furnitureTiles / (it.w * it.h);
  if (coverage < 0.08) {
    out.push({ code: "sparse-room", severity: "high", msg: `${furnitureTiles} furniture tiles in a ${it.w}×${it.h}=${it.w * it.h}-tile room = ${(coverage * 100).toFixed(1)}% coverage — reads as an empty hall with floating props` });
  }
  // seating for social venues
  const social = it.theme === "pub" || it.theme === "kitchen" || it.theme === "living";
  if (social && totalSeats < 4) {
    out.push({ code: "few-seats", severity: "med", msg: `a ${it.theme} venue with only ${totalSeats} seats (${tableCount} tables) — groups cannot sit together` });
  }
  // surface fallbacks
  const floor = resolveSurface("floor", themeToFloor(it));
  const wall = resolveSurface("wall", themeToWall(it));
  if (floor.generated) out.push({ code: "floor-fallback", severity: "low", msg: `floor "${themeToFloor(it)}" has no crop — flat generated fill` });
  if (wall.generated) out.push({ code: "wall-fallback", severity: "low", msg: `wall "${themeToWall(it)}" has no crop — flat band` });
  return out;
}

// theme → material maps, MIRRORING interior-scene.js THEME_TO_FLOOR/THEME_TO_WALL (world.json floor/wall
// hints win when present — same precedence the scene would want; the scene currently ignores the hints,
// which the atlas surfaces as ground truth either way).
export function themeToFloor(it: Interior): string {
  if (it.floor) return it.floor;
  return ({ kitchen: "tile", grocery: "tile", workshop: "stone", classroom: "wood", bedroom: "carpet", pub: "wood-dark", living: "carpet" } as Record<string, string>)[it.theme] ?? "wood";
}
export function themeToWall(it: Interior): string {
  if (it.wall) return it.wall;
  return ({ kitchen: "tile", grocery: "plaster", workshop: "brick", classroom: "plaster", bedroom: "plaster", pub: "wood", living: "plaster" } as Record<string, string>)[it.theme] ?? "plaster";
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---- ASCII town map -------------------------------------------------------------------------------------
/** Letter assigned to each building for map glyphs + legends (A.. in world.json order). */
export function buildingLetters(world: AtlasWorld): Map<string, string> {
  const m = new Map<string, string>();
  world.buildings.forEach((b, i) => m.set(b.id, String.fromCharCode(65 + i)));
  return m;
}

/**
 * Render the whole town grid: '═' street, '─' sidewalk, '¦' the optional cross-park columns, '·' grass,
 * building footprints as their letter (door 'D', inside tile '+'), agents as digits 1-9 (input order).
 */
export function townMapAscii(
  world: AtlasWorld,
  agents: Array<{ id: string; x: number; y: number }> = [],
): { lines: string[]; legend: string[] } {
  const W = world.width, H = world.height;
  const streetTop = world.street.rows[0];
  const grid: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => "·"));
  for (const r of world.street.rows) for (let x = 0; x < W; x++) grid[r][x] = "═";
  for (const r of world.sidewalks.rows) for (let x = 0; x < W; x++) grid[r][x] = "─";
  const lanes = (world as unknown as { lanes?: { cols?: Array<{ x: number; y0: number; y1: number }> } }).lanes;
  for (const c of lanes?.cols ?? []) for (let y = c.y0; y <= c.y1; y++) if (grid[y][c.x] === "·") grid[y][c.x] = "¦";
  const letters = buildingLetters(world);
  const legend: string[] = [];
  for (const b of world.buildings) {
    const L = letters.get(b.id)!;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (y >= 0 && y < H && x >= 0 && x < W) grid[y][x] = L;
    const [ix, iy] = insideTile(b, streetTop);
    if (iy >= 0 && iy < H) grid[iy][ix] = "+";
    if (b.door.y >= 0 && b.door.y < H) grid[b.door.y][b.door.x] = "D";
    legend.push(`${L}=${b.label} (${b.id})`);
  }
  agents.forEach((a, i) => {
    if (a.y >= 0 && a.y < H && a.x >= 0 && a.x < W) grid[a.y][a.x] = String((i + 1) % 10);
    legend.push(`${(i + 1) % 10}=${a.id} @(${a.x},${a.y})`);
  });
  return { lines: grid.map((r) => r.join("")), legend };
}

// ---- runnable self-test (ZERO tokens): `npx tsx scripts/atlas-lib.ts` -----------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`SELF-TEST FAILED: ${msg}`);
    console.log(`  ✅ ${msg}`);
  };
  const world = loadWorld();
  assert(world.buildings.length === 15, `world has 15 buildings (got ${world.buildings.length})`);
  const bakery = world.buildings.find((b) => b.id === "bakery")!;
  assert(!!bakery.interior, "bakery has an interior");

  // the dough-table sliver, proven through the RENDERER'S OWN alias code
  const chain = resolveAssetChain({ id: "dough-table", kind: "desk" });
  assert(chain.cropName === "table-dark", `dough-table resolves via the real alias table to table-dark (got ${chain.cropName})`);
  if (chain.px) {
    const fit = renderFit(chain.px);
    assert(fit.squashed && fit.dispTilesH <= 0.7, `table-dark ${chain.px.w}×${chain.px.h}px renders squashed to ${fit.dispTilesW}×${fit.dispTilesH} tiles (the sliver)`);
  } else {
    console.log("  ⚠ limezu crops not on this machine — px checks skipped (gitignored art)");
  }
  // a single-tile crop must NOT be flagged
  const counter = resolveAssetChain({ id: "cafe-counter", kind: "counter" });
  if (counter.px) assert(!renderFit(counter.px).squashed, "cafe-counter (48×48) is not squashed");

  // floorplan renders + occupant digits
  const fp = floorplanAscii(bakery.interior!, [{ id: "baker", x: 6, y: 2 }]);
  assert(fp.lines.length === bakery.interior!.h + 2 && fp.lines[0].length === bakery.interior!.w + 2, "floorplan has walls around the full grid");
  assert(fp.lines.some((l) => l.includes("1")), "occupant digit appears on the plan");

  // smells: bakery counter at (6,2) in 12×9 is not wall-adjacent → must be flagged
  const smells = computeSmells(bakery);
  assert(smells.some((s) => s.code === "not-wall-adjacent"), "bakery counter flagged not-wall-adjacent");
  assert(smells.some((s) => s.code === "sparse-room"), "bakery flagged sparse (5 props in 108 tiles)");
  const townhall = world.buildings.find((b) => b.id === "townhall")!;
  assert(computeSmells(townhall).some((s) => s.code === "no-interior"), "townhall flagged no-interior (stub-room lie)");
  console.log("\n✅ atlas-lib.ts self-test passed");
}
