// scripts/test-interior-pack.mjs — ZERO-token, ZERO-browser self-test for the B3 interior art pack.
//   node scripts/test-interior-pack.mjs
// Imports the REAL renderer/phaser/assets.js behind a tiny Phaser/DOM stub and asserts the interior getters
// (interiorFloor / interiorWall / interiorObject / interiorNames) behave per the published contract:
//   - return a string texture key (floors/walls always; objects when art/aliased) or NULL (objects, unknown)
//   - NEVER throw on any input (incl. unknown names, null, B1 raw `kind`s, world.json object ids)
//   - aliases resolve (kind → crop; object-id → crop; rug → carpet floor)
//   - missing crops degrade per-key (floors/walls → a generated flat tile; objects → null)
// Independent of interior-scene.js (B2, scenewright) so my deliverable validates on its own.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };
const check = (c, m) => (c ? ok(m) : bad(m));

// ---- minimal Phaser + window stub (just what assets.js touches) ----
const made = new Set();
const gfx = {
  fillStyle: () => gfx, fillRect: () => gfx, fillRoundedRect: () => gfx, fillCircle: () => gfx,
  lineStyle: () => gfx, strokeRoundedRect: () => gfx, strokeCircle: () => gfx,
  generateTexture: (k) => { made.add(k); return gfx; }, destroy: () => gfx,
};
globalThis.Phaser = {
  Display: { Color: {
    HexStringToColor: (s) => ({ color: parseInt(String(s).replace("#", ""), 16) || 0 }),
  } },
};
class SceneStub {
  constructor() {
    this.TILE = 28;
    const present = new Set();
    this.textures = { exists: (k) => present.has(k), _present: present };
    this.load = { on: () => {}, image: (k) => present.add(k) }; // preload "loads" → mark present
  }
  add = { graphics: () => gfx };
}

const { resolveAssetPack } = await import(join(HERE, "..", "renderer", "phaser", "assets.js"));
const lz = resolveAssetPack("?art=limezu");

console.log("── interior pack: shape");
check(lz.key === "limezu", "?art=limezu resolves the LimeZu pack");
check(lz.tileSizeInterior === 48, "pack.tileSizeInterior === 48 (interior grid)");
check(typeof lz.interiorFloor === "function" && typeof lz.interiorWall === "function" && typeof lz.interiorObject === "function",
  "exposes interiorFloor / interiorWall / interiorObject");
const names = lz.interiorNames();
check(Array.isArray(names.floors) && names.floors.includes("wood") && names.floors.includes("tile"),
  `interiorNames().floors = [${names.floors.join(", ")}]`);
check(names.objects.includes("counter") && names.objects.includes("bed") && names.objects.includes("mic") && names.objects.includes("display-case"),
  `interiorNames().objects has counter/bed/mic/display-case (${names.objects.length} objects)`);

console.log("\n── interior pack: BEFORE preload (no crops present) → degrade cleanly, never throw");
const s0 = new SceneStub();
check(typeof lz.interiorFloor(s0, "wood") === "string", "interiorFloor(wood) → a key even with no crop (generated tile)");
check(typeof lz.interiorWall(s0, "brick") === "string", "interiorWall(brick) → a key even with no crop (generated tile)");
check(lz.interiorObject(s0, "counter") === null, "interiorObject(counter) → null when no crop present (caller draws rect)");
check(lz.interiorFloor(s0, "bogus-floor") === lz.interiorFloor(s0, "wood"), "unknown floor kind → aliases to wood");
check(lz.interiorWall(s0, "bogus-wall") === s0 && false || typeof lz.interiorWall(s0, "bogus-wall") === "string", "unknown wall variant → plaster (still a key)");

console.log("\n── interior pack: AFTER preload (crops 'loaded') → real keys");
const s = new SceneStub();
lz.preload(s); // marks every limezu:* key present in the stub loader
check(s.textures.exists("limezu:int:floor:wood"), "preload registers floor crops (limezu:int:floor:wood)");
check(s.textures.exists("limezu:int:wall:plaster"), "preload registers wall crops (limezu:int:wall:plaster)");
check(s.textures.exists("limezu:int:obj:stove") && s.textures.exists("limezu:int:obj:bed"), "preload registers object crops (stove, bed)");
check(lz.interiorFloor(s, "tile") === "limezu:int:floor:tile", "interiorFloor(tile) → the real crop key once loaded");
check(lz.interiorWall(s, "wood") === "limezu:int:wall:wood", "interiorWall(wood) → the real crop key once loaded");
check(lz.interiorObject(s, "bed") === "limezu:int:obj:bed", "interiorObject(bed) → the real crop key once loaded");

console.log("\n── interior pack: ALIASES (B1 kinds + world.json object ids → a crop)");
const aliasCases = [
  ["appliance", "limezu:int:obj:stove", "B1 kind 'appliance' → stove"],
  ["register", "limezu:int:obj:counter", "B1 kind 'register' → counter"],
  ["seat", "limezu:int:obj:chair", "B1 kind 'seat' → chair"],
  ["stage", "limezu:int:obj:mic", "B1 kind 'stage' → mic (busking focal)"],
  ["espresso-machine", "limezu:int:obj:espresso", "object id 'espresso-machine' → espresso"],
  ["oven", "limezu:int:obj:oven", "object id 'oven' → oven crop"],
  ["bar-counter", "limezu:int:obj:counter-3", "object id 'bar-counter' → counter-3"],
  ["bakery-display", "limezu:int:obj:display-case", "object id 'bakery-display' → display-case"],
  ["grocery-shelves", "limezu:int:obj:shelf", "object id 'grocery-shelves' → shelf"],
  ["produce-stand", "limezu:int:obj:produce", "object id 'produce-stand' → produce"],
  ["lectern", "limezu:int:obj:lectern", "object id 'lectern' → lectern"],
  ["dorm-beds", "limezu:int:obj:bunk-bed", "object id 'dorm-beds' → bunk-bed"],
  ["college-sofa", "limezu:int:obj:sofa", "object id 'college-sofa' → sofa"],
  ["table-2chairs", "limezu:int:obj:table-wide", "'table-2chairs' → table-wide"],
  ["pub-stage", "limezu:int:obj:mic", "B1 busking-spot id 'pub-stage' → mic (the busking focal)"],
  ["home-baker-fridge", "limezu:int:obj:fridge", "home furniture id 'home-baker-fridge' → fridge"],
  ["dorm-desks", "limezu:int:obj:desk", "'dorm-desks' → desk"],
  ["podium", "limezu:int:obj:lectern", "college 'podium' → lectern (reads as a podium, not a mic)"],
  ["whiteboard", "limezu:int:obj:chalkboard", "'whiteboard' → chalkboard (board synonym)"],
  // B1 INSTANCE ids = base + numeric suffix → the renderer strips -<n> and resolves the base.
  ["cafe-table-1", "limezu:int:obj:table-wide", "instance id 'cafe-table-1' → table-wide (suffix stripped)"],
  ["cafe-table-2", "limezu:int:obj:table-wide", "'cafe-table-2' → table-wide"],
  ["pub-table-1", "limezu:int:obj:table-wide", "'pub-table-1' → table-wide"],
  ["study-desk-1", "limezu:int:obj:desk", "'study-desk-1' → desk"],
  ["study-desk-99", "limezu:int:obj:desk", "'study-desk-99' → desk (suffix-strip is count-agnostic)"],
  ["coliving-bed", "limezu:int:obj:bed", "'coliving-bed' → bed"],
];
for (const [name, want, desc] of aliasCases) check(lz.interiorObject(s, name) === want, desc);
// rug aliases to the carpet FLOOR texture (bedroom rug crops are near-transparent)
check(lz.interiorObject(s, "rug") === lz.interiorFloor(s, "carpet"), "interiorObject('rug') → the carpet floor texture");

console.log("\n── furnitureTextureKey(scene, subLoc) — B2 convenience (id preferred, else kind)");
check(lz.furnitureTextureKey(s, { id: "espresso-machine", kind: "appliance" }) === "limezu:int:obj:espresso",
  "subLoc {id:espresso-machine, kind:appliance} → espresso (specific id wins over generic kind)");
check(lz.furnitureTextureKey(s, { kind: "counter" }) === "limezu:int:obj:counter", "subLoc {kind:counter} (no id) → counter");
check(lz.furnitureTextureKey(s, { id: "some-unknown-thing", kind: "bed" }) === "limezu:int:obj:bed", "unknown id falls through to kind (bed)");
check(lz.furnitureTextureKey(s, { id: "nope", kind: "nope" }) === null, "fully-unknown subLoc → null (B2 draws a rect)");
check(lz.furnitureTextureKey(s, null) === null, "furnitureTextureKey(null) → null (no throw)");

console.log("\n── interior pack: ROBUSTNESS (never throws)");
let threw = false;
for (const bogus of [null, undefined, "", "totally-unknown", 123, "drop table", "fireplace"]) {
  try { const r = lz.interiorObject(s, bogus); check(r === null || typeof r === "string", `interiorObject(${JSON.stringify(bogus)}) → ${r === null ? "null" : "key"} (no throw)`); }
  catch (e) { threw = true; bad(`interiorObject(${JSON.stringify(bogus)}) THREW: ${e.message}`); }
}
check(!threw, "no input made interiorObject throw");

console.log(failures === 0 ? "\n✅ interior pack self-test PASSED" : `\n❌ ${failures} assertion(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
