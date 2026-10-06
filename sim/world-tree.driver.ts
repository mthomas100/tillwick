// sim/world-tree.driver.ts — ZERO-TOKEN validation for the W2-world keystone.
//   npx tsx sim/world-tree.driver.ts
// Loads sim/world.json, builds the tree, renders subtrees to NL, exercises the per-agent seen-subgraph,
// and asserts the invariants the rest of Wave 2 depends on:
//   - every live citizen has a HOME (home/<id> with resident=id) and a per-citizen SPAWN on a walkable tile
//   - the world is walkability-COHERENT: every building's door + door-adjacent inside tile are walkable and
//     adjacent; intra-corridor A*/BFS paths are NON-EMPTY (the map is traversable)
//   - the pinned contracts survive: spawns{}, buildings[].goods, the 5 shop ids the registry depends on
// Does NOT boot the sim or run any citizen (INC-2026-06-18 discipline — fleet runs are separately gated).
//
// Exit 0 = all green. Exit 1 = a failed assertion (printed).

import { loadWorld, WorldTree, SeenSubgraph } from "./world-tree.js";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
function check(cond: boolean, m: string): void {
  if (cond) pass(m);
  else { console.error(`  ✗ ${m}`); failures++; }
}
function section(t: string) { console.log(`\n── ${t}`); }

// The live roster (sim/sim-server.ts default ids; the registry/personas are keyed to these). Kept here so
// the driver fails loudly if a future world.json reshape drops a citizen's home or spawn.
const CITIZENS = ["baker", "barista", "grocer", "courier", "smith"];
// The 5 shop building ids the shop registry (shops/registry.ts) + shop-server.ts hardcode — must survive.
const PINNED_SHOP_IDS = ["bakery", "cafe", "grocer", "depot", "smithy"];

const world = loadWorld();
const tree = new WorldTree(world);

// ---------------------------------------------------------------------------
section("world.json loads + tree builds");
check(!!world.title, `title present: "${world.title}"`);
check(world.width > 0 && world.height > 0 && world.tile > 0, `grid ${world.width}×${world.height} @ ${world.tile}px`);
check(tree.root.kind === "area", `root is an area: "${tree.root.label}"`);
const allBuildings = tree.buildings();
check(allBuildings.length === world.buildings.length, `tree holds all ${world.buildings.length} buildings`);

// ---------------------------------------------------------------------------
section("pinned contracts survive (registry / shops / renderer)");
for (const sid of PINNED_SHOP_IDS) {
  const b = tree.building(sid);
  check(!!b && b.type === "shop", `shop "${sid}" present with type=shop`);
  check(!!b?.goods && b.goods.length > 0, `shop "${sid}" keeps goods[] (${b?.goods?.map((g) => g.id).join(",")})`);
}
// goods price strings keep the "$x.xx" shape shop-server.ts parses
const allGoods = world.buildings.flatMap((b) => b.goods ?? []);
check(allGoods.length > 0 && allGoods.every((g) => /^\$\d/.test(g.price)), `all ${allGoods.length} goods keep "$x.xx" price strings`);
// spawns{} is per-citizen
check(!!world.spawns && CITIZENS.every((c) => !!world.spawns[c]), `spawns{} present for every citizen`);

// ---------------------------------------------------------------------------
section("every citizen has a HOME + a SPAWN");
for (const c of CITIZENS) {
  const home = allBuildings.find((b) => b.type === "home" && b.resident === c);
  check(!!home, `${c} has a home (${home?.label ?? "—"})`);
  const s = world.spawns[c];
  check(!!s, `${c} has a spawn (${s ? `${s.x},${s.y}` : "—"})`);
  if (s) check(tree.walkable(s.x, s.y), `${c}'s spawn (${s.x},${s.y}) is walkable`);
}

// ---------------------------------------------------------------------------
section("walkability is coherent (door + inside tile, per building)");
let coherent = 0;
for (const b of world.buildings) {
  const [ix, iy] = tree.doorInsideTile(b);
  const doorW = tree.walkable(b.door.x, b.door.y);
  const insideW = tree.walkable(ix, iy);
  const adj = Math.abs(b.door.x - ix) + Math.abs(b.door.y - iy) === 1;
  const insideInBuilding = ix >= b.x && ix < b.x + b.w && iy >= b.y && iy < b.y + b.h;
  const ok = doorW && insideW && adj && insideInBuilding;
  if (ok) coherent++;
  else console.error(`    ✗ ${b.id}: door(${b.door.x},${b.door.y}) inside(${ix},${iy}) doorW=${doorW} insideW=${insideW} adj=${adj} inBldg=${insideInBuilding}`);
}
check(coherent === world.buildings.length, `all ${world.buildings.length} buildings have a walkable, door-adjacent inside tile`);

// ---------------------------------------------------------------------------
section("walkability is NON-EMPTY + traversable (intra-corridor BFS)");
// Group buildings by their lane corridor (the sidewalk row their door sits on / next to). Within a corridor,
// every building must be reachable from every other (the committed guarantee; cross-corridor needs the
// W2-move 2D-lane hook). We test, per corridor, a path from the first building's inside tile to each other's.
const laneRows = new Set<number>([...world.street.rows, ...world.sidewalks.rows]);
const corridorOf = (b: typeof world.buildings[number]): number => {
  // the lane row adjacent to (or equal to) the door
  for (const dy of [0, -1, 1]) if (laneRows.has(b.door.y + dy)) return b.door.y + dy;
  return -1;
};
const corridors = new Map<number, typeof world.buildings>();
for (const b of world.buildings) {
  const c = corridorOf(b);
  check(c !== -1, `${b.id} docks onto a lane row (door y=${b.door.y})`);
  if (!corridors.has(c)) corridors.set(c, []);
  corridors.get(c)!.push(b);
}
let intraOK = 0, intraTotal = 0;
for (const [row, group] of corridors) {
  if (group.length < 2) continue;
  const [hx, hy] = tree.doorInsideTile(group[0]);
  for (let i = 1; i < group.length; i++) {
    const [tx, ty] = tree.doorInsideTile(group[i]);
    const len = tree.pathLen(hx, hy, tx, ty);
    intraTotal++;
    if (len > 0) intraOK++;
    else console.error(`    ✗ no path ${group[0].id}->${group[i].id} within corridor @row ${row}`);
  }
}
check(intraTotal > 0 && intraOK === intraTotal, `intra-corridor BFS: ${intraOK}/${intraTotal} building pairs reachable`);

// the economically-critical set (5 shops + 5 homes) all live on the North corridor and are reachable under
// the CURRENT sim's rows-only model too — assert the shops are pairwise reachable.
const shopNodes = PINNED_SHOP_IDS.map((id) => world.buildings.find((b) => b.id === id)!).filter(Boolean);
let shopPairOK = true;
const [s0x, s0y] = tree.doorInsideTile(shopNodes[0]);
for (let i = 1; i < shopNodes.length; i++) {
  const [sx, sy] = tree.doorInsideTile(shopNodes[i]);
  if (tree.pathLen(s0x, s0y, sx, sy) === 0) { shopPairOK = false; console.error(`    ✗ shop ${shopNodes[0].id}->${shopNodes[i].id} unreachable`); }
}
check(shopPairOK, `all 5 shops are pairwise reachable (the economy still works pre-move-upgrade)`);

// cross-corridor connectivity is OFF without the 2D lane hook, ON with it (documents the W2-move hook).
const north = world.buildings.find((b) => b.id === "cafe")!;
const south = world.buildings.find((b) => b.id === "college")!;
const [nx, ny] = tree.doorInsideTile(north);
const [cx, cy] = tree.doorInsideTile(south);
check(tree.pathLen(nx, ny, cx, cy, { use2DLanes: false }) === 0, `cross-corridor is closed without 2D lanes (rows-only sim)`);
check(tree.pathLen(nx, ny, cx, cy, { use2DLanes: true }) > 0, `cross-corridor OPENS with lanes.cols (the W2-move hook)`);

// ---------------------------------------------------------------------------
section("env→NL rendering (Fig 2)");
const cafe = tree.building("cafe")!;
const cafeNL = tree.buildingToNL(cafe, true);
console.log(`  cafe → ${cafeNL}`);
check(/Hobbs Cafe/.test(cafeNL) && /coffee/.test(cafeNL) && /espresso machine/.test(cafeNL), `building NL names the place, its goods, and an object`);
check(/\(idle\)/.test(cafeNL), `object STATE renders ("espresso machine (idle)")`);
const home = tree.building("home-baker")!;
const homeNL = tree.buildingToNL(home, true);
console.log(`  home-baker → ${homeNL}`);
check(/baker lives here/.test(homeNL) && /stove/.test(homeNL), `home NL names the resident + a room object`);
const path = tree.pathToBuilding("cafe");
console.log(`  path → ${path}`);
check(path.split(" > ").length >= 2 && /Hobbs Cafe$/.test(path), `pathToBuilding renders town→area→building`);
// producer surfaces
const depotNL = tree.buildingToNL(tree.building("depot")!, false);
check(/produces delivery/.test(depotNL), `producer (Harvey Oak) renders "produces delivery"`);
// whole town renders without throwing
const townNL = tree.townToNL();
check(townNL.length > 200 && /Johnson Park/.test(townNL), `townToNL() renders the full environment (${townNL.length} chars)`);

// ---------------------------------------------------------------------------
section("per-agent seen-subgraph");
const seen = new SeenSubgraph(tree, "baker");
check(seen.toNL().startsWith("You have not yet observed"), `fresh subgraph is empty`);
seen.observeBuilding("cafe"); // saw it from outside
check(seen.has("cafe") && !seen.hasRoom("cafe", "cafe-floor"), `observeBuilding reveals existence, not interior`);
let snap = seen.snapshot();
check(snap.buildings.includes("cafe") && Object.keys(snap.objects).length === 0, `outside-only: no objects known yet`);
seen.observeInside("cafe", "cafe-floor"); // went in
check(seen.hasRoom("cafe", "cafe-floor"), `observeInside reveals the room`);
snap = seen.snapshot();
check(snap.objects["cafe/cafe-floor/espresso-machine"] === "idle", `inside reveals object + last-known state`);
check(!("cafe/cafe-kitchen/cafe-roaster" in snap.objects), `un-entered room stays hidden (subgraph is partial)`);
const seenNL = seen.toNL();
console.log(`  baker's seen-world → ${seenNL.replace(/\n/g, " | ")}`);
check(/Hobbs Cafe/.test(seenNL) && /espresso machine/.test(seenNL), `seen-subgraph NL reflects only what baker observed`);
// two agents have INDEPENDENT subgraphs
const seen2 = new SeenSubgraph(tree, "smith");
check(seen2.snapshot().buildings.length === 0, `a second agent's subgraph is independent (empty)`);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILURE(S)`} — W2-world driver`);
process.exit(failures === 0 ? 0 : 1);
