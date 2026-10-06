// renderer/phaser/engine-test.mjs — ZERO-BROWSER engine validation (the lead's "mock-world static check").
//   node renderer/phaser/engine-test.mjs
// Provides a minimal Phaser test double + window/document shims, then drives the REAL TownScene + asset packs
// against the REAL sim/world.json and asserts the engine's behavior:
//   - town builds: ground + every building, with depth ordered by bottom edge
//   - agents spawn and DEPTH-SORT by y (occlusion correctness — the whole point of a top-down renderer)
//   - co-located agents FAN OUT (crowded shop tiles don't stack)
//   - the inspector contract is published every frame: window.__townRenderPos / __townDrawPos / __townWorld
//   - 💬 bubbles appear from {type:"event"} say AND {type:"dialogue"} records, and expire
//   - the asset pack generates distinct building/agent texture keys (art-agnostic interface works)
// No Phaser runtime, no canvas, no sim, no LLM. Pure logic.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const check = (c, m) => { if (c) ok(m); else { console.error(`  ✗ ${m}`); failures++; } };
const section = (t) => console.log(`\n── ${t}`);
// Read the text inside an agent's current bubble (the container's text child) — for the A3 replay asserts.
const bubbleText = (scene, id) => {
  const b = scene.bubbles.get(id);
  if (!b || !b.container || !Array.isArray(b.container.children)) return "";
  const txt = b.container.children.find((c) => c && typeof c.text === "string");
  return txt ? txt.text : "";
};
// the text shown in an occupancy badge's count label ("👥 N") — for the A3-4 asserts.
const bubbleBadgeText = (badge) => (badge && badge.countText && typeof badge.countText.text === "string" ? badge.countText.text : "");

// ---------- Phaser test double (records what the scene creates) ----------
let texCounter = 0;
const madeTextures = new Set();
function mkGameObject(kind, extra = {}) {
  const o = {
    kind, depth: 0, x: 0, y: 0, alpha: 1, visible: true, _calls: [],
    scrollFactorX: 1, scrollFactorY: 1,
    setOrigin() { return o; }, setDepth(d) { o.depth = d; return o; }, setPosition(x, y) { o.x = x; o.y = y; return o; },
    setDisplaySize() { return o; }, setAlpha(a) { o.alpha = a; return o; }, setInteractive() { o._interactive = true; return o; },
    setScrollFactor(x, y) { o.scrollFactorX = x; o.scrollFactorY = (y == null ? x : y); return o; },
    setScrollFactor() { return o; }, on() { return o; }, clear() { o._calls.push("clear"); return o; },
    fillStyle() { return o; }, fillRect() { return o; }, fillRoundedRect() { return o; }, fillCircle() { return o; },
    lineStyle() { return o; }, strokeRect() { return o; }, strokeRoundedRect() { return o; }, strokeCircle() { return o; }, strokeEllipse() { return o; },
    beginPath() { return o; }, moveTo() { return o; }, lineTo() { return o; }, strokePath() { return o; },
    setTileScale() { return o; },
    setSize(w, h) { o.width = w; o.height = h; return o; }, setFillStyle(c, a) { o.fillColor = c; if (a != null) o.alpha = a; return o; },
    setStrokeStyle() { return o; }, disableInteractive() { o._interactive = false; return o; },
    setPadding() { return o; }, setColor(c) { o.color = c; return o; }, // text chrome (interior-scene header/exit/labels)
    generateTexture(key) { madeTextures.add(key); return o; }, destroy() { o._destroyed = true; return o; },
    add() { return o; }, removeAll() { return o; }, setText(t) { if (o.children) { const c = o.children.find((x) => x && typeof x.text === "string"); if (c) c.text = t; } o.text = t; return o; }, width: 40, height: 12,
    ...extra,
  };
  return o;
}
class SceneBase {
  constructor() {
    this.add = {
      graphics: () => mkGameObject("graphics"),
      image: (x, y, key) => mkGameObject("image", { x, y, texKey: key, texture: { key } }),
      text: (x, y, t) => mkGameObject("text", { x, y, text: t, width: String(t).length * 6, height: 12 }),
      layer: () => { const items = []; const l = mkGameObject("layer"); l.add = (n) => { items.push(n); return l; }; l.removeAll = () => { items.length = 0; return l; }; l.items = items; return l; },
      container: (x, y, children) => { const c = mkGameObject("container", { x, y, children: (children || []).slice() }); c.add = (n) => { c.children.push(n); return c; }; return c; },
      tileSprite: (x, y, w, h, key) => mkGameObject("tileSprite", { x, y, w, h, texKey: key }),
      rectangle: (x, y, w, h, color, alpha) => mkGameObject("rectangle", { x, y, width: w, height: h, fillColor: color, alpha: alpha == null ? 1 : alpha }),
      zone: (x, y, w, h) => mkGameObject("zone", { x, y, width: w, height: h }),
    };
    const mkCam = () => ({ _bounds: { x: 0, y: 0, width: 0, height: 0 }, setBackgroundColor() { return this; }, setBounds(x, y, w, h) { this._bounds = { x, y, width: w, height: h }; return this; }, getBounds() { return this._bounds; }, getWorldPoint(x, y) { return { x: x + (this.scrollX || 0), y: y + (this.scrollY || 0) }; }, setZoom(z) { this.zoom = z ?? this.zoom; return this; }, setScroll(x, y) { this.scrollX = x; this.scrollY = y; return this; }, ignore() { return this; }, centerOn() { return this; }, startFollow() {}, stopFollow() {}, scrollX: 0, scrollY: 0, zoom: 1, width: 1792, height: 1064 });
    this.cameras = { main: mkCam(), add: () => mkCam() };
    this.scale = { gameSize: { width: 1792, height: 1064 }, on() {} };
    this.input = { on() {}, setTopOnly() {}, keyboard: { on() {} } };
    this.textures = { exists: (k) => madeTextures.has(k), get: (k) => ({ getSourceImage: () => ({ width: 16, height: madeTextures.has(k) && /char|home|shop|civic/.test(k) ? 32 : 16 }) }) };
    // time.now drives bubble expiry; delayedCall queues a callback (A3-1 staggered dialogue replay). The test
    // collects scheduled calls so it can fire them deterministically (no real clock). remove() cancels one.
    this._scheduled = [];
    this.time = {
      now: 0,
      delayedCall: (delay, cb) => { const c = { delay, cb, _cancelled: false, remove() { this._cancelled = true; } }; this._scheduled.push(c); return c; },
      _fireAll: () => { for (const c of this._scheduled) if (!c._cancelled) c.cb(); this._scheduled = []; },
    };
    this.load = { image(k) { madeTextures.add(k); }, atlas(k) { madeTextures.add(k); }, on() {} };
    this.scene = { settings: { active: true } };
  }
}
globalThis.Phaser = {
  Scene: SceneBase, AUTO: 0,
  Display: { Color: { HexStringToColor: (s) => ({ color: parseInt(String(s).replace("#", ""), 16) || 0 }) } },
  Math: { Clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) },
  Scale: { FIT: 0, CENTER_BOTH: 0 },
};
globalThis.window = {};
globalThis.location = { search: "" };

// ---------- import the REAL modules (after the stub is in place) ----------
const { resolveAssetPack, genBuildingTexture, genAgentTexture } = await import("./assets.js");
const { TownScene } = await import("./town-scene.js");
const { InteriorScene, stubInterior } = await import("./interior-scene.js");

const world = JSON.parse(readFileSync(join(HERE, "..", "..", "sim", "world.json"), "utf8"));

// ---------------------------------------------------------------------------
section("asset pack — art-agnostic texture generation");
const pack = resolveAssetPack("");
check(pack.key === "placeholder", `default pack is placeholder (?art= unset)`);
const fakeScene = new SceneBase(); fakeScene.TILE = world.tile;
const bKey1 = pack.buildingTextureKey(fakeScene, world.buildings[0]);
const bKey2 = pack.buildingTextureKey(fakeScene, world.buildings.find((b) => b.color !== world.buildings[0].color) || world.buildings[1]);
check(typeof bKey1 === "string" && madeTextures.has(bKey1), `building texture generated (${bKey1})`);
check(bKey1 !== bKey2, `different buildings → different texture keys (color/size keyed)`);
const aKey = pack.agentTextureKey(fakeScene, { id: "baker", color: "#ff9100" });
check(typeof aKey === "string" && madeTextures.has(aKey), `agent texture generated (${aKey})`);
check(pack.groundFill("street") !== pack.groundFill("grass"), `ground fills differ by kind`);
check(resolveAssetPack("?art=limezu").key === "limezu" && resolveAssetPack("?art=bogus").key === "placeholder", `?art= switches packs; unknown → placeholder`);

// ---------------------------------------------------------------------------
section("scene builds the town from world.json");
const scene = new TownScene();
// mirror the real Phaser lifecycle: world handed up front, then create() builds (after preload's assets load)
scene.world = world; scene.TILE = world.tile; scene.preload(); scene.create();
check(scene.world === world && scene.TILE === world.tile, `world + tile adopted`);
check(scene._buildingNodes.length >= world.buildings.length, `buildings populated (${scene._buildingNodes.length} loose nodes for ${world.buildings.length} buildings + doors/labels)`);
check(globalThis.window.__townWorld === world, `window.__townWorld published for inspector/control`);

// ---------------------------------------------------------------------------
section("agents spawn + DEPTH-SORT by y (occlusion)");
const agents = [
  { id: "baker", x: 5, y: 7, color: "#ff9100", moving: true, adjacentTo: [] },
  { id: "smith", x: 5, y: 20, color: "#00d4ff", moving: false, adjacentTo: [] },
];
scene.applyTick(agents, true);
scene.update(); // ease + place + depth + publish
const vBaker = scene.agentSprites.get("baker");
const vSmith = scene.agentSprites.get("smith");
check(!!vBaker && !!vSmith, `both agents spawned sprites`);
check(vSmith.sprite.depth > vBaker.sprite.depth, `agent lower on screen (smith y=20) draws IN FRONT of higher (baker y=7) — depth-sorted`);
// a building whose bottom edge is above an agent must have LOWER depth than that agent (agent occludes it)
const cafe = world.buildings.find((b) => b.id === "cafe"); // y=2..8
const cafeDepthApprox = (cafe.y + cafe.h) * world.tile; // ~ door row
check(vSmith.sprite.depth > cafeDepthApprox, `an agent far below the cafe occludes it (agent depth > cafe depth)`);

// ---------------------------------------------------------------------------
section("inspector contract — positions published every frame (tile units)");
check(!!globalThis.window.__townRenderPos && !!globalThis.window.__townRenderPos.baker, `__townRenderPos has per-agent {x,y}`);
check(!!globalThis.window.__townDrawPos && !!globalThis.window.__townDrawPos.baker, `__townDrawPos has per-agent {x,y}`);
const rp = globalThis.window.__townRenderPos.smith;
check(Math.abs(rp.x - 5) < 0.001 && Math.abs(rp.y - 20) < 0.001, `published positions are in TILE units (smith at 5,20)`);

// ---------------------------------------------------------------------------
section("co-located agents FAN OUT (crowded tiles don't stack)");
const piled = [
  { id: "a1", x: 5, y: 8, color: "#fff", moving: false, adjacentTo: [] },
  { id: "a2", x: 5, y: 8, color: "#fff", moving: false, adjacentTo: [] },
  { id: "a3", x: 5, y: 8, color: "#fff", moving: false, adjacentTo: [] },
];
scene.applyTick(piled, true);
scene.update();
const d1 = globalThis.window.__townDrawPos.a1, d2 = globalThis.window.__townDrawPos.a2, d3 = globalThis.window.__townDrawPos.a3;
const spread = Math.hypot(d1.x - d2.x, d1.y - d2.y) + Math.hypot(d2.x - d3.x, d2.y - d3.y);
check(spread > 0.1, `3 agents on one tile get distinct fanned draw positions (spread=${spread.toFixed(2)})`);
// and render positions remain the true (un-fanned) tile for hit-testing of the underlying tile
check(Math.abs(globalThis.window.__townRenderPos.a1.x - 5) < 0.001, `render position stays on the true tile (un-fanned)`);

// ---------------------------------------------------------------------------
section("💬 bubbles from say events AND dialogue records");
scene.time.now = 1000;
scene.onEvent({ kind: "say", actor: "baker", payload: { to: "smith", text: "morning!" } });
check(scene.bubbles.has("baker"), `say event → bubble on speaker`);
scene.onDialogue({ type: "dialogue", op: "record", participants: ["a1", "a2"], outcome: "conversed", topic: "bread prices", turns: 4 });
check(scene.bubbles.has("a1") && scene.bubbles.has("a2"), `dialogue 'conversed' → 💬 bubble on BOTH participants`);
scene.onDialogue({ type: "dialogue", op: "record", participants: ["a3", "smith"], outcome: "walk_by", topic: "" });
check(!scene.bubbles.has("a3"), `dialogue 'walk_by' → NO bubble (they didn't talk)`);
// bubbles expire
scene.time.now = 1000 + 7000; // past BUBBLE_MS
scene.update();
check(!scene.bubbles.has("baker"), `bubble expires after its lifetime`);

// ---------------------------------------------------------------------------
section("💬 A3-1 — a real transcript REPLAYS as staggered on-map bubbles");
scene.time.now = 2000;
scene._scheduled = [];
const convo = {
  type: "dialogue", op: "record", id: "dlg:a1:a2:42", participants: ["a1", "a2"], outcome: "conversed",
  topic: "bread", turns: 4,
  transcript: [
    { speaker: "a1", text: "Morning—after the fresh bread?" },
    { speaker: "a2", text: "Just the affordable stuff, as usual." },
    { speaker: "a1", text: "I've got a few coins say otherwise." },
    { speaker: "a2", text: "That's genuinely kind." },
  ],
};
scene.onDialogue(convo);
check(scene.bubbles.has("a1") && scene.bubbles.has("a2"), `opening turn + first reply show SYNCHRONOUSLY (both speakers)`);
check(/fresh bread/.test(bubbleText(scene, "a1")), `a1's bubble shows the actual line, not just the topic`);
check(/affordable/.test(bubbleText(scene, "a2")), `a2's bubble shows their actual reply`);
check(scene._scheduled.length === 2, `the remaining 2 turns are SCHEDULED (staggered), not shown at once`);
scene.time._fireAll(); // play out turns 2 & 3
check(/coins/.test(bubbleText(scene, "a1")) && /kind/.test(bubbleText(scene, "a2")), `staggered turns land on the right speakers`);
// overlap/supersede: a re-broadcast of the SAME id cancels stale pending turns (no bubble fights)
scene._scheduled = [];
scene.onDialogue(convo); // schedules 2 again
const stale = scene._scheduled.slice();
scene.onDialogue(convo); // supersede → the prior 2 must be cancelled
check(stale.every((c) => c._cancelled), `an overlapping replay of the same dialogue CANCELS the stale turns`);
// a short/empty transcript falls back to the single 💬 topic bubble (older sims)
scene.onDialogue({ type: "dialogue", op: "record", id: "dlg:x", participants: ["a1", "a2"], outcome: "conversed", topic: "weather", transcript: [] });
check(/💬|weather/.test(bubbleText(scene, "a1")), `empty transcript → falls back to the 💬 topic bubble`);

// ---------------------------------------------------------------------------
section("🛠 A3-2 — role-action status events render as an emoji bubble");
scene.onEvent({ type: "event", kind: "status", actor: "a1", payload: { text: "baking…", emoji: "🥖", verb: "bake" } });
check(/🥖.*baking/.test(bubbleText(scene, "a1")), `status with explicit emoji+text → "🥖 baking…" bubble`);
scene.onEvent({ type: "event", kind: "status", actor: "a2", payload: { text: "busking…", verb: "busk" } });
check(/🎸.*busking/.test(bubbleText(scene, "a2")), `status without emoji → verb→emoji fallback (busk→🎸)`);
scene.onEvent({ type: "event", kind: "status", actor: "a1", payload: { verb: "tinker" } });
check(/🛠/.test(bubbleText(scene, "a1")), `unknown verb → 🛠 fallback emoji`);
// behaviorist's CONTRACT shape: emoji BAKED INTO text ({text:"🥖 baking…", verb:"bake", at:<bldg>}) — must NOT
// double-prepend (would render "🥖 🥖 baking…"). The bubble shows exactly one leading emoji.
scene.onEvent({ type: "event", kind: "status", actor: "a2", payload: { text: "🥖 baking…", verb: "bake", at: "bakery" } });
check(bubbleText(scene, "a2") === "🥖 baking…", `emoji-in-text payload renders ONCE (no double emoji): "${bubbleText(scene, "a2")}"`);

// ---------------------------------------------------------------------------
section("🌗 A3-3 — day/night tint ramps off the game clock");
check(!!scene._dayNight, `a day/night overlay rectangle exists`);
check(scene._dayNight.depth >= 99000 && scene._dayNight._interactive === false, `overlay is high-depth + NON-interactive (can't eat clicks)`);
// REGRESSION (operator-flagged "translucent square"): the tint must cover the FULL WORLD at scrollFactor 1, NOT
// the camera viewport (a scrollFactor-0 canvas-sized rect shrinks by the fit-zoom → covered only the top-left).
{
  const T = scene.TILE, worldW = scene.world.width * T, worldH = scene.world.height * T;
  check(scene._dayNight.scrollFactorX === 1, `tint moves WITH the world (scrollFactor 1), not screen-fixed`);
  check(scene._dayNight.width >= worldW && scene._dayNight.height >= worldH, `tint covers the WHOLE world (${Math.round(scene._dayNight.width)}x${Math.round(scene._dayNight.height)} ≥ ${worldW}x${worldH}) — no un-tinted square`);
  // The tint is sized to the CAMERA BOUNDS (the exact framable rect, incl. HUD band + letterbox) so it has NO
  // un-tinted edge at any zoom/pan — the camera can't see beyond its bounds. Verify the tint strictly CONTAINS
  // the bounds on all four sides (this is what fixes the 54px top strip the world+fixed-margin version left).
  const b = scene.cameras.main.getBounds();
  const dn = scene._dayNight;
  check(dn.x <= b.x && dn.y <= b.y && (dn.x + dn.width) >= (b.x + b.width) && (dn.y + dn.height) >= (b.y + b.height),
    `tint CONTAINS the camera bounds on all sides (no un-tinted edge at any zoom/pan)`);
}
scene.applyDayNight(12, 0); const dayAlpha = scene._dayNight.alpha;
scene.applyDayNight(0, 0);  const nightAlpha = scene._dayNight.alpha;
check(nightAlpha > dayAlpha, `midnight tint is STRONGER than noon (noon≈clear, night dim-blue): ${dayAlpha.toFixed(2)} → ${nightAlpha.toFixed(2)}`);
scene.applyDayNight(3, 0);  const preDawn = scene._dayNight.alpha;
check(preDawn < nightAlpha && preDawn > dayAlpha, `3am lerps BETWEEN midnight and dawn (smooth ramp, not a snap)`);

// ---------------------------------------------------------------------------
section("👥 A3-4 — occupancy badge reflects who's inside a building");
const occHomeB = world.buildings.find((b) => b.type === "home") || world.buildings[0];
// drop two citizens INSIDE that building's footprint (center-tile test) + one far outside
const occAgents = [
  { id: "zelda", x: occHomeB.x, y: occHomeB.y, color: "#ff5247", moving: false, adjacentTo: [] },
  { id: "yan",   x: occHomeB.x + Math.min(1, occHomeB.w - 1), y: occHomeB.y, color: "#6ee7b7", moving: false, adjacentTo: [] },
  { id: "wanda", x: 0, y: 0, color: "#00d4ff", moving: false, adjacentTo: [] }, // outside
];
scene.applyTick(occAgents, true);
scene.time.now = 100000; // jump past the occupancy throttle window
scene.update();
const occBadge = scene._occBadges.get(occHomeB.id);
check(!!occBadge, `a building with occupants gets an occupancy badge`);
check(/👥\s*2/.test(bubbleBadgeText(occBadge)), `badge shows the right count (👥 2 — wanda is outside)`);
// emptying the building tears the badge down (no stale "0")
const movedOut = occAgents.map((a) => ({ ...a, x: 0, y: 0 }));
scene.applyTick(movedOut, true);
scene.time.now = 200000;
scene.update();
check(!scene._occBadges.get(occHomeB.id), `badge is torn down when the building empties (no leak / stale 0)`);

// ---------------------------------------------------------------------------
section("🏠 B2 — interior scene builds from B1-shaped data (scaffold; real-data/B3-art-swappable)");
const interior = new InteriorScene();
// stub matches behaviorist's REAL world.json interior shape (theme/tile/spawnInside/sublocations{label,kind,station,seats})
const stub = stubInterior("bakery");
check(stub.theme === "kitchen" && stub.tile === 32 && stub.w > 0 && stub.h > 0, `stubInterior('bakery') → kitchen, tile 32, size ${stub.w}x${stub.h}`);
check(Array.isArray(stub.sublocations) && stub.sublocations.some((s) => s.kind === "counter") && stub.sublocations.some((s) => s.station), `kitchen has a counter + a station sub-location (B1 shape)`);
check(stub.sublocations.some((s) => Array.isArray(s.seats)), `a table sublocation carries seats[]`);
// drive the scene lifecycle the way the host will: enter() then create()
let exited = null;
interior.enter("bakery", (id) => { exited = id; });
interior.preload(); interior.create();
check(interior._created && interior.data && interior.data.theme === "kitchen", `scene builds the interior on create()`);
check(interior.furnitureNodes.length >= stub.sublocations.length, `furniture drawn for every sub-location (${interior.furnitureNodes.length} nodes)`);
// live occupant update (B1 shape {id,x,y,sublocationId}): someone walks in, then a different set replaces them
interior.applyOccupants([{ id: "baker", x: 6, y: 2, sublocationId: "counter" }, { id: "regular", x: 2, y: 5, sublocationId: "t1" }]);
check(interior.agentSprites.has("baker") && interior.agentSprites.has("regular"), `applyOccupants places occupants at interior {x,y}`);
interior.applyOccupants([{ id: "student", x: 4, y: 2, sublocationId: "reg" }]);
check(interior.agentSprites.has("student") && !interior.agentSprites.has("baker"), `applyOccupants adds the arrival + removes those no longer inside`);
interior.update(); // ease + place — must not throw
// EXIT control invokes the host callback (returns to town)
interior.exit();
check(exited === "bakery", `EXIT fires the host onExit(buildingId) callback`);
// re-enter a DIFFERENT theme rebuilds cleanly (no furniture leak from the prior room)
interior.enter("college", () => {});
const beforeRebuild = interior.furnitureNodes.length;
interior.buildInterior();
check(interior.data.theme === "classroom", `re-enter('college') rebuilds as a classroom`);
check(interior.furnitureNodes.length > 0 && interior.furnitureNodes.length < beforeRebuild + 999, `rebuild replaces furniture (no unbounded leak)`);
// the default provider prefers a REAL world.buildings[b].interior when present (here: none in the test → stub fallback)
check(typeof interior.dataProvider.getInterior === "function" && typeof interior.dataProvider.fetchOccupants === "function", `default provider exposes getInterior + fetchOccupants (real-data seam)`);
// C-fix-1: the EXIT control is a PROMINENT button (bg pill + a generous interactive hit-zone), not bare text.
check(!!interior._exitBg && !!interior._exitHit, `EXIT is a styled button (bg + hit-zone), not bare text`);
check(interior._exitHit._interactive !== false && (interior._exitW || 0) > 60, `EXIT hit-zone is interactive + generously sized (${Math.round(interior._exitW)}px)`);
// C-fix-2: a click on an occupant INSIDE the interior opens THAT citizen's card via window.__inspector.openAgent.
{
  // put an occupant at a known interior tile, then simulate a click (pointerup, no drag) at its screen point.
  interior.applyOccupants([{ id: "barista", x: 3, y: 3, sublocationId: "counter" }]);
  let openedId = null;
  globalThis.window.__inspector = { openAgent: (id) => { openedId = id; } };
  // camera getWorldPoint(x,y) = (x+scroll, y+scroll); scroll is 0 → world == screen. Occupant center is at
  // (3.x*T + T/2). Click there: pointerdown then pointerup with no move → _handleInteriorClick picks the occupant.
  const T = interior.TILE, cx = 3 * T + T / 2, cy = 3 * T + T / 2;
  interior.input._fire ? null : null; // (the stub input just records handlers; call the scene methods directly)
  interior._dragging = true; interior._moved = false; // simulate a clean click (down, no move)
  interior._handleInteriorClick({ x: cx, y: cy, event: { clientX: cx, clientY: cy } });
  check(openedId === "barista", `click an occupant inside → opens THAT citizen's card (window.__inspector.openAgent)`);
  // a click on EMPTY interior space opens nothing
  openedId = null;
  interior._handleInteriorClick({ x: cx + 5 * T, y: cy + 5 * T, event: {} });
  check(openedId === null, `click on empty interior space → opens no card`);
}

// ---------------------------------------------------------------------------
section("🪑 D-interior-social — presence deltas + table-talk marker");
{
  // a fresh interior that HAS a table — the cafe (cafe-table-1) in the real world.json (the test sets __townWorld,
  // so the default provider loads the real interior; bakery has no table, cafe does).
  interior.enter("cafe", () => {}); interior.buildInterior();
  const tableSub = (interior.data.sublocations.find((s) => s.kind === "table") || {}).id;
  // spy on _presenceCue to capture the classified verbs
  const cues = [];
  const origCue = interior._presenceCue.bind(interior);
  interior._presenceCue = (id, kind) => { cues.push({ id, kind }); return origCue(id, kind); };
  // 1) a NEW occupant at the door (no sublocationId) → "entered"
  interior.applyOccupants([{ id: "ann", x: interior.data.spawnInside.x, y: interior.data.spawnInside.y }]);
  check(cues.some((c) => c.id === "ann" && c.kind === "entered"), `a new occupant → "entered" cue`);
  // 2) ann moves to the table seat → "sat" (sublocationId none→table)
  const tS = interior.data.sublocations.find((s) => s.id === tableSub);
  interior.applyOccupants([{ id: "ann", x: tS.x, y: tS.y, sublocationId: tableSub }]);
  check(cues.some((c) => c.id === "ann" && c.kind === "sat"), `none→table sublocation → "sat" cue`);
  // 3) ann stands (table→none, still present) → "stood"
  interior.applyOccupants([{ id: "ann", x: interior.data.spawnInside.x, y: interior.data.spawnInside.y }]);
  check(cues.some((c) => c.id === "ann" && c.kind === "stood"), `table→none (still inside) → "stood" cue`);
  interior._presenceCue = origCue;
  // 4) TABLE-TALK: two occupants share a table + a dialogue closes → a marker appears on that table
  interior.applyOccupants([
    { id: "kla", x: tS.x, y: tS.y, sublocationId: tableSub },
    { id: "sam", x: tS.x, y: tS.y, sublocationId: tableSub },
  ]);
  interior.onDialogue({ type: "dialogue", op: "record", outcome: "conversed", participants: ["kla", "sam"], topic: "the festival" });
  check(!!(interior._tableTalk && interior._tableTalk.has(tableSub)), `2 participants at one table + conversed dialogue → table-talk marker on that table`);
  // 5) participants NOT sharing a spot → no marker
  interior._tableTalk.clear();
  interior.applyOccupants([{ id: "kla", x: tS.x, y: tS.y, sublocationId: tableSub }, { id: "bob", x: 0, y: 0 }]);
  interior.onDialogue({ type: "dialogue", op: "record", outcome: "conversed", participants: ["kla", "bob"], topic: "x" });
  check(interior._tableTalk.size === 0, `participants not sharing a table → no marker`);
  // 6) a walk_by (not "conversed") → no marker
  interior.applyOccupants([{ id: "kla", x: tS.x, y: tS.y, sublocationId: tableSub }, { id: "sam", x: tS.x, y: tS.y, sublocationId: tableSub }]);
  interior.onDialogue({ type: "dialogue", op: "record", outcome: "walk_by", participants: ["kla", "sam"] });
  check(interior._tableTalk.size === 0, `non-conversed outcome → no marker`);
}

// ---------------------------------------------------------------------------
section("feed module (ported behavior)");
// feed.js is pure DOM; give it a tiny document shim and assert it builds rows without throwing.
const rows = [];
const mkEl = () => ({ className: "", dataset: {}, style: {}, innerHTML: "", children: rows, appendChild(){}, removeChild(){}, prepend(n){ rows.unshift(n); }, querySelectorAll(){ return []; }, addEventListener(){}, classList:{toggle(){},add(){}}, lastChild:null });
globalThis.document = { getElementById: () => mkEl(), createElement: () => mkEl(), querySelectorAll: () => [], addEventListener() {} };
const { createFeed } = await import("./feed.js");
const feed = createFeed({ colorByActor: { baker: "#ff9100" } });
feed.addEvent({ kind: "purchase", actor: "baker", payload: { item: "coffee", price_usdc: 0.02, shop: "cafe", counterparty: "barista" }, explorer: "https://x/tx" });
feed.addDialogue({ outcome: "conversed", participants: ["baker", "smith"], topic: "the festival", turns: 3 });
check(rows.length >= 2, `feed renders a purchase row + a dialogue row (${rows.length} rows)`);

// ---------------------------------------------------------------------------
section("LimeZu pack — real-art wiring (?art=limezu)");
const lz = resolveAssetPack("?art=limezu");
check(lz.key === "limezu" && lz.tileSize === 16, `?art=limezu selects the LimeZu pack (tileSize 16)`);
// preload registers the real texture keys (our stubbed loader marks them present)
const lzScene = new SceneBase(); lzScene.TILE = 28;
lz.preload(lzScene);
check(lzScene.textures.exists("limezu:ground:grass"), `preload registers ground tiles (grass/road/pavement)`);
check(lzScene.textures.exists("limezu:bld:shop") && lzScene.textures.exists("limezu:bld:home"), `preload registers building facades`);
check(lzScene.textures.exists("limezu:char:baker"), `preload registers the 5 character sprites`);
// building → facade mapping. The pack now prefers a PER-ID facade (SHOP_BY_ID / CIVIC_BY_ID — e.g. cafe→
// limezu:bld:cafe, college→limezu:bld:college) and falls back BY TYPE (shop→shop/shop2, home→home, civic→civic)
// for any id not listed. Assert that contract (the first shop/civic in world.json IS a per-id one, so we accept
// the per-id storefront OR the generic type facade — both are valid LimeZu facades, never a placeholder).
const shopB = world.buildings.find((b) => b.type === "shop");
const homeB = world.buildings.find((b) => b.type === "home");
const civicB = world.buildings.find((b) => b.type === "civic");
const SHOP_IDS = ["cafe", "grocer", "depot", "bakery", "smithy"]; // SHOP_BY_ID keys in assets.js
const CIVIC_IDS = ["college", "pub", "townhall"];                 // CIVIC_BY_ID keys in assets.js
const shopKey = lz.buildingTextureKey(lzScene, shopB);
check(shopKey === `limezu:bld:${shopB.id}` || /^limezu:bld:shop2?$/.test(shopKey),
  `a shop maps to a LimeZu storefront (per-id ${SHOP_IDS.includes(shopB.id) ? shopB.id : "→shop/shop2"}: ${shopKey})`);
check(lz.buildingTextureKey(lzScene, homeB) === "limezu:bld:home", `a home maps to the LimeZu house`);
if (civicB) {
  const civicKey = lz.buildingTextureKey(lzScene, civicB);
  check(civicKey === `limezu:bld:${civicB.id}` || civicKey === "limezu:bld:civic",
    `a civic building maps to a LimeZu civic facade (per-id ${CIVIC_IDS.includes(civicB.id) ? civicB.id : "→civic"}: ${civicKey})`);
}
// ground tile keys (the additive scene hook) + agent sprite keys
check(lz.groundTileKey(lzScene, "grass") === "limezu:ground:grass" && lz.groundTileKey(lzScene, "street") === "limezu:ground:road", `groundTileKey maps kind→tile (street→road)`);
check(lz.agentTextureKey(lzScene, { id: "smith" }) === "limezu:char:smith", `agent maps to its LimeZu character`);
// per-texture FALLBACK: an unknown agent / a 404'd texture degrades to placeholder
check(lz.agentTextureKey(lzScene, { id: "stranger", color: "#fff" }).startsWith("placeholder:agent:"), `unknown agent falls back to a placeholder sprite`);
// the scene builds end-to-end with LimeZu (tiled ground + facades), no throw
const lzTown = new TownScene();
lzTown.pack = lz; lzTown.world = world; lzTown.TILE = world.tile;
lzTown._pendingAgents = [{ id: "baker", x: 5, y: 7, color: "#ff9100", moving: false, adjacentTo: [] }];
lzTown.preload(); lzTown.create(); // load real keys via the stub, then build (mirrors Phaser lifecycle)
lzTown.update();
check(lzTown._buildingNodes.length >= world.buildings.length, `LimeZu scene builds the town (${lzTown._buildingNodes.length} loose nodes)`);
check(!!lzTown._groundTiles && lzTown._groundTiles.items.length > 0, `LimeZu ground is rendered as TILE sprites (${lzTown._groundTiles ? lzTown._groundTiles.items.length : 0})`);
const bakerSprite = lzTown.agentSprites.get("baker");
check(bakerSprite && bakerSprite.sprite._tall === true, `a LimeZu character renders as a TALL (feet-anchored) sprite`);

// ---------------------------------------------------------------------------
// C-panel — multi-panel inspector invariants (static source check). The inspector's DOM half is a browser-only
// IIFE (its CommonJS export is inert under "type":"module"), so its live behavior is gated by Playwright, not
// here. These cheap textual tripwires guard the FOUR operator-flagged behaviors against silent regression:
//   (1) MANY cards at once  (2) DRAGGABLE by the header  (3) PERSISTENT (only ✕ closes)  (4) ACTIVITY default.
section("C-panel — multi-panel inspector (static invariants; Playwright is the live gate)");
const inspectorSrc = readFileSync(join(HERE, "..", "inspector.js"), "utf8");
// (1) multiple panels: a Map keyed by id, and re-opening an already-open citizen RAISES instead of duplicating.
check(/const panels = new Map\(\)/.test(inspectorSrc) && /\.inspector-panel-card/.test(inspectorSrc),
  `multiple cards: a panels Map + a per-card .inspector-panel-card node (not the single #inspector-panel)`);
check(/const existing = panels\.get\(id\);[\s\S]*?raiseCard\(existing\); return;/.test(inspectorSrc),
  `re-opening an open citizen RAISES its card (no duplicate)`);
// (2) draggable: the header (.inspector-head) is the drag handle; interactive children don't start a drag.
check(/head\.addEventListener\("pointerdown"/.test(inspectorSrc) && /querySelector\(".inspector-head"\)/.test(inspectorSrc),
  `draggable: pointerdown on .inspector-head starts the drag`);
check(/closest\(".inspector-close, .inspector-tab, .inspector-btn, a, button"\)/.test(inspectorSrc),
  `drag does NOT start from the ✕ / tabs / buttons / links`);
check(/clampCard\(/.test(inspectorSrc), `dragged card is clamped to the viewport`);
// (3) persistent: the document outside-click handler no longer closes cards (only its ✕ does).
check(!/if \(panel\.contains\(e\.target\)\) return;/.test(inspectorSrc) && !/if \(onCanvas\) return; \/\/ canvas handler decides/.test(inspectorSrc),
  `persistence: the old outside-click auto-close (panel.contains / canvas-decides → hide) is REMOVED`);
check(/✕ closes ONLY this card/.test(inspectorSrc) && /closeCard\(card\)/.test(inspectorSrc),
  `persistence: only a card's own ✕ closes it (closeCard wired to .inspector-close)`);
// (4) ACTIVITY is the default tab: its pill is `on`, its pane is un-hidden, INVENTORY starts hidden, and the
// poll starts on open (switchTab(card,"activity") right after first paint).
check(/<button class="inspector-tab on" data-tab="activity"/.test(inspectorSrc) && /data-pane="inventory" hidden/.test(inspectorSrc),
  `ACTIVITY is the default tab (its pill is on, INVENTORY pane starts hidden)`);
check(/switchTab\(card, "activity"\); \/\/ C-panel: ACTIVITY is the default/.test(inspectorSrc),
  `ACTIVITY poll starts immediately on open (switchTab(card,"activity"))`);
// load-bearing seams preserved: the __inspector hook, the interior-view guard, the three canvas-click paths.
check(/window\.__inspector = \{[\s\S]*?openAgent:/.test(inspectorSrc) && /switchTab:/.test(inspectorSrc) && /get state\(\)/.test(inspectorSrc),
  `window.__inspector hook preserved (openAgent / switchTab / hide / state)`);
check(/window\.__townView === "interior"\) return;/.test(inspectorSrc), `__townView==="interior" guard preserved in onCanvasClick`);
check(/enterInterior\(bHit\.id\)/.test(inspectorSrc) && /openShop\(shopHit/.test(inspectorSrc) && /openAgent\(agentHits\[0\]\.id/.test(inspectorSrc),
  `the 3 canvas-click paths preserved (openAgent / openShop / enterInterior)`);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "✅ ALL GREEN" : `❌ ${failures} FAILURE(S)`} — W3-phaser engine test`);
process.exit(failures === 0 ? 0 : 1);
