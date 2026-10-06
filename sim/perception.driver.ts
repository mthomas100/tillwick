// sim/perception.driver.ts — ZERO-TOKEN validation for W2b-perception (the world→memory bridge).
//   npx tsx sim/perception.driver.ts
// Drives assemblePerception() through an agent's trip across town and asserts:
//   - the SeenSubgraph GROWS correctly as the agent moves/enters (exterior on approach, interior on entry)
//   - the assembled perception reflects ONLY what's been seen (un-entered interiors stay hidden)
//   - the rich `here` block carries interior NL + rooms + area + path + object STATE (the H4 logic)
//   - `observationText` (the line for mind.observe()) is well-formed and perceived-NOW
//   - adjacency / nearby agents pass through into the observation
// Loads the real sim/world.json via loadTree(); builds NO sim, runs NO citizen, touches NO disk.

import { loadTree, SeenSubgraph } from "./world-tree.js";
import { assemblePerception, updateSeen, type PerceptionInput } from "./perception.js";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
function check(cond: boolean, m: string): void {
  if (cond) pass(m);
  else { console.error(`  ✗ ${m}`); failures++; }
}
const section = (t: string) => console.log(`\n── ${t}`);

const tree = loadTree();

// ---------------------------------------------------------------------------
section("approach: agent on the street sees building EXTERIORS, no interiors yet");
const seen = new SeenSubgraph(tree, "baker");
// baker out on the north lane, sees the cafe + grocer ahead, with grocer's owner walking nearby.
const onStreet: PerceptionInput = {
  self: { id: "baker", x: 10, y: 8, usdc: 5, moving: true },
  hereBuildingId: null,
  nearBuildings: [
    { id: "cafe", label: "Hobbs Cafe", type: "shop", dist: 5 },
    { id: "grocer", label: "Willows Market & Pharmacy", type: "shop", dist: 4 },
  ],
  nearAgents: [{ id: "grocer", x: 15, y: 8, dist: 5 }],
  adjacentTo: [],
};
let p = assemblePerception(tree, seen, onStreet);
check(p.here === null, `here is null when out on a lane`);
check(p.seen.buildings.includes("cafe") && p.seen.buildings.includes("grocer"), `nearby buildings entered the subgraph (exteriors)`);
check(Object.keys(p.seen.objects).length === 0, `NO interior objects known yet (not entered)`);
check(/seen from outside/.test(p.seenText) && /Hobbs Cafe/.test(p.seenText), `seenText shows cafe "seen from outside"`);
check(/out on the streets of Tillwick/.test(p.observationText), `observationText says you're on the street`);
check(/grocer \(5 away\)/.test(p.observationText), `observationText reports a visible (non-adjacent) agent + distance`);
check(/Buildings I can see:/.test(p.observationText) && /Hobbs Cafe/.test(p.observationText), `observationText names visible buildings`);

// ---------------------------------------------------------------------------
section("enter: agent steps into Hobbs Cafe → interior + object STATE revealed");
const inCafe: PerceptionInput = {
  self: { id: "baker", x: 5, y: 7, usdc: 5, moving: false },
  hereBuildingId: "cafe",
  nearBuildings: [{ id: "cafe", label: "Hobbs Cafe", type: "shop", dist: 0 }],
  nearAgents: [{ id: "barista", x: 5, y: 7, dist: 0 }],
  adjacentTo: ["barista"], // co-located with the barista
};
p = assemblePerception(tree, seen, inCafe);
check(p.here !== null, `here is populated inside a building`);
check(p.here!.buildingId === "cafe" && p.here!.isShop === true, `here identifies the cafe as a shop`);
check(p.here!.area === "main-square" && p.here!.areaLabel === "Main Square", `here carries the area (Main Square)`);
check(/Tillwick > Main Square > Hobbs Cafe/.test(p.here!.path), `here.path renders town→area→building`);
check(p.here!.rooms.includes("cafe-floor") && p.here!.rooms.includes("cafe-kitchen"), `here.rooms lists the building's rooms`);
check(/espresso machine \(idle\)/.test(p.here!.nl), `here.nl carries object STATE ("espresso machine (idle)")`);
check(/coffee \(\$0\.02\)/.test(p.here!.nl), `here.nl carries the shop's goods + price`);
// subgraph now knows the interior objects + their state
check(p.seen.objects["cafe/cafe-floor/espresso-machine"] === "idle", `subgraph now records the espresso machine state`);
check(p.seen.rooms.includes("cafe/cafe-floor") && p.seen.rooms.includes("cafe/cafe-kitchen"), `entering reveals ALL rooms of the building`);
// the observation for mind.observe()
check(/I am in Hobbs Cafe \(Main Square\)\./.test(p.observationText), `observationText states the current building + area`);
check(/Right next to me: barista\./.test(p.observationText), `observationText reports the ADJACENT agent (talkable)`);
check(p.area?.id === "main-square", `area block is populated from the current building`);

// ---------------------------------------------------------------------------
section("partial knowledge: a building the agent NEVER entered stays exterior-only");
// baker has seen cafe (inside) + grocer (outside) — assert grocer interior is still hidden.
check(seen.has("grocer") && !seen.hasRoom("grocer", "market-floor"), `grocer known to exist but interior hidden`);
check(!("grocer/market-floor/produce-stand" in p.seen.objects), `grocer's objects are NOT in the subgraph`);
const grocerLine = p.seenText.split("\n").find((l) => l.includes("Willows Market"));
check(!!grocerLine && /seen from outside/.test(grocerLine!), `seenText still shows grocer "seen from outside"`);

// ---------------------------------------------------------------------------
section("open-air objects: standing in the park surfaces its fixtures");
// Johnson Park has open-air objects but no buildings; the sim would set hereBuildingId only for a building.
// We model "in the park" via a building that sits in an area WITH objects — none here — so instead assert the
// area-object path directly through updateSeen against an area that has objects (johnson-park).
const parkSeen = new SeenSubgraph(tree, "courier");
parkSeen.observeAreaObjects("johnson-park");
const parkSnap = parkSeen.snapshot();
check(parkSnap.objects["area/johnson-park/fountain"] === "running", `park fountain observable as an open-air object (state running)`);
check(/Johnson Park/.test(parkSeen.toNL()), `park area renders in the subgraph NL`);

// ---------------------------------------------------------------------------
section("idempotence + independence");
// re-perceiving the same spot doesn't duplicate or lose anything
const before = JSON.stringify(seen.snapshot());
updateSeen(tree, seen, inCafe);
check(JSON.stringify(seen.snapshot()) === before, `re-perceiving the same place is idempotent (no dup growth)`);
// a different agent has an independent subgraph
const other = new SeenSubgraph(tree, "smith");
const op = assemblePerception(tree, other, { self: { id: "smith", x: 50, y: 8 }, hereBuildingId: "smithy", nearBuildings: [{ id: "smithy", label: "Harvey Oak Smithy", type: "shop" }], nearAgents: [], adjacentTo: [] });
check(!other.has("cafe") && op.here!.buildingId === "smithy", `smith's subgraph is independent (knows smithy, not baker's cafe)`);
check(/forge|anvil/i.test(op.here!.nl), `smith's here.nl renders the forge interior`);

// ---------------------------------------------------------------------------
section("lone agent: empty surroundings read cleanly");
const lone = assemblePerception(tree, new SeenSubgraph(tree, "x"), { self: { id: "x", x: 31, y: 20 }, hereBuildingId: null, nearBuildings: [], nearAgents: [], adjacentTo: [] });
check(/No one else is around right now\./.test(lone.observationText), `solo agent observation reads "No one else is around"`);
check(lone.here === null && lone.nearbyObjects.length === 0, `solo on an empty tile: no here, no objects`);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILURE(S)`} — W2b-perception driver`);
process.exit(failures === 0 ? 0 : 1);
