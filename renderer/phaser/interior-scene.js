// renderer/phaser/interior-scene.js — B2: the INTERIOR view. Click a building in the town → this scene becomes
// the full view of the app: the inside of that building, rendered with LimeZu interior art (decorator's B3 pack),
// its named sub-locations/furniture (behaviorist's B1 data), the agents who are inside placed at their interior
// coords, a minimap, and a clear EXIT control back to the town.
//
// SCAFFOLD PHASE (this file, now): a STANDALONE scene driven by two injected providers, each with a STUB so the
// shell renders today with ZERO dependency on B1/B3:
//   - dataProvider.getInterior(buildingId) -> InteriorData   (B1 — stubbed here as a believable layout)
//   - artPack (B3 interior pack)                              (B3 — stubbed here as drawn colored rects)
// When B1's real interior feed + B3's real art land, the lead swaps the stubs for the real providers; the scene
// code does not change (same contract). The town→interior SCENE SWITCH + the __town* coexistence seam are a
// SEPARATE, later step (gated on the lead's ruling) — this file deliberately does NOT touch town-scene or the
// shared globals, so it's safe to land + unit-test in isolation.
//
// ── INTERIOR DATA CONTRACT (behaviorist's B1, landed in world.json — this is the REAL shape) ────────────────
// world.buildings[b].interior = {
//   w, h,                               // interior size in INTERIOR tiles (own grid, origin 0,0)
//   theme: "kitchen"|"grocery"|"workshop"|"classroom"|"bedroom"|"pub"|"living",  // floor/art hint
//   tile,                               // interior tile px the layout assumes (per-building, e.g. 32)
//   spawnInside: { x, y },              // entry tile (door-side); also our exit-marker spot
//   sublocations: [{ id, label, kind:"counter"|"appliance"|"table"|"register"|"desk"|"bed"|"shelf"|"stage",
//                    x, y, station?:bool, seats?:[{x,y}] }],  // furniture/zones in interior tiles (1x1 each)
// }
// Occupants (live; B1's presence map, via GET /who-inside/:building + WS {type:"interior",building,occupants}):
//   [{ id, x, y, sublocationId? }]      — x,y are INTERIOR-LOCAL coords. The scene places each agent at (x,y).
//   (color isn't in the presence payload; the scene resolves it from the town's color map when available.)

import { resolveAssetPack } from "./assets.js";

const EASE = 0.2;

// ── STUB interior (real B1 SHAPE) — for headless tests + a graceful fallback if a building lacks interior data.
// Matches behaviorist's world.json shape exactly (theme/tile/spawnInside/sublocations{label,kind,station,seats})
// so swapping the real `world.buildings[b].interior` in needs ZERO scene change.
function stubInterior(buildingId) {
  const id = String(buildingId || "room");
  const theme =
    /bakery|cafe|kitchen/.test(id) ? "kitchen" :
    /grocer|market/.test(id) ? "grocery" :
    /smith|depot|workshop/.test(id) ? "workshop" :
    /home|house/.test(id) ? "bedroom" :
    /college|school|class/.test(id) ? "classroom" :
    /pub|bar|tavern/.test(id) ? "pub" : "living";
  const base = { w: 10, h: 8, theme, tile: 32, spawnInside: { x: 5, y: 7 }, sublocations: [] };
  if (theme === "kitchen") base.sublocations = [
    { id: "counter", label: "service counter", kind: "counter", x: 6, y: 2, station: true },
    { id: "stove", label: "stove", kind: "appliance", x: 8, y: 2, station: true },
    { id: "t1", label: "window table", kind: "table", x: 2, y: 5, seats: [{ x: 1, y: 5 }, { x: 3, y: 5 }] },
    { id: "reg", label: "register", kind: "register", x: 4, y: 2 },
  ];
  else if (theme === "grocery") base.sublocations = [
    { id: "reg", label: "checkout", kind: "register", x: 6, y: 2, station: true },
    { id: "shelf", label: "shelves", kind: "shelf", x: 2, y: 2 }, { id: "produce", label: "produce", kind: "shelf", x: 4, y: 2 },
  ];
  else if (theme === "workshop") base.sublocations = [
    { id: "anvil", label: "anvil", kind: "appliance", x: 7, y: 2, station: true },
    { id: "bench", label: "workbench", kind: "counter", x: 2, y: 2, station: true },
  ];
  else if (theme === "classroom") base.sublocations = [
    { id: "d1", label: "desk", kind: "desk", x: 2, y: 3 }, { id: "d2", label: "desk", kind: "desk", x: 4, y: 3 },
    { id: "d3", label: "desk", kind: "desk", x: 6, y: 3 }, { id: "podium", label: "podium", kind: "stage", x: 4, y: 6, station: true },
  ];
  else if (theme === "bedroom") base.sublocations = [
    { id: "bed", label: "bed", kind: "bed", x: 2, y: 2 }, { id: "desk", label: "desk", kind: "desk", x: 7, y: 2 },
  ];
  else if (theme === "pub") base.sublocations = [
    { id: "bar", label: "bar", kind: "counter", x: 6, y: 2, station: true },
    { id: "stage", label: "stage", kind: "stage", x: 8, y: 5, station: true },
    { id: "t1", label: "table", kind: "table", x: 2, y: 5, seats: [{ x: 1, y: 5 }, { x: 3, y: 5 }] },
  ];
  else base.sublocations = [
    { id: "t1", label: "table", kind: "table", x: 4, y: 4, seats: [{ x: 3, y: 4 }, { x: 5, y: 4 }] },
    { id: "shelf", label: "shelf", kind: "shelf", x: 1, y: 2 },
  ];
  return base;
}
// Default provider: prefers the REAL interior from window.__townWorld.buildings[b].interior; falls back to the
// stub for a building with no interior data (or in headless tests where there's no world). Occupants come from
// GET /who-inside/:building (one-shot) + the live {type:"interior"} WS push the host forwards via applyOccupants.
function defaultDataProvider() {
  const realInterior = (buildingId) => {
    try {
      const w = (typeof window !== "undefined" && window.__townWorld) || null;
      const b = w && Array.isArray(w.buildings) ? w.buildings.find((x) => x.id === buildingId) : null;
      if (b && b.interior && Array.isArray(b.interior.sublocations)) return { ...b.interior, _label: b.label || buildingId };
    } catch { /* fall through to stub */ }
    return null;
  };
  return {
    getInterior: (buildingId) => realInterior(buildingId) || stubInterior(buildingId),
    // one-shot occupant fetch (live updates arrive via the host → applyOccupants from the {type:"interior"} WS push)
    async fetchOccupants(buildingId) {
      try {
        if (typeof fetch !== "function") return [];
        const res = await fetch("/who-inside/" + encodeURIComponent(buildingId));
        if (!res.ok) return [];
        const j = await res.json();
        return Array.isArray(j.occupants) ? j.occupants : [];
      } catch { return []; }
    },
  };
}

// ── B3 STUB: floor/furniture as drawn rects, so the scene renders before the real interior art exists. A real
// B3 pack will expose interiorFloorTileKey/furnitureTextureKey on the same asset-pack object; we prefer those
// when present and fall back to these colors. (Mirrors how the exterior pack degrades to flat fills.) ─────────
const FLOOR_FILL = { kitchen: 0x3a2f28, grocery: 0x2f3a2c, workshop: 0x322c26, bedroom: 0x2c2f3a, classroom: 0x33322a, pub: 0x2a2622, living: 0x2e2b30, generic: 0x26262b };
// furniture look per B1 sublocation kind (drawn-rect fallback when B3 art isn't present)
const FURNITURE = {
  counter: { fill: 0x8a6a3a, label: "▭" }, appliance: { fill: 0x55585e, label: "♨" },
  register: { fill: 0x7a6a4a, label: "▥" }, table: { fill: 0x6a4a2a, label: "▢" },
  desk: { fill: 0x5a4632, label: "▤" }, stage: { fill: 0x5a2f4a, label: "♪" },
  bed: { fill: 0x3a4a6a, label: "▬" }, shelf: { fill: 0x474038, label: "▦" },
};
const SEAT_FILL = 0x4a4a52;
// B1 `theme` → decorator's B3 floor MATERIAL (interiorFloor takes wood|wood-dark|tile|stone|carpet, not a theme).
const THEME_TO_FLOOR = { kitchen: "tile", grocery: "tile", workshop: "stone", classroom: "wood", bedroom: "carpet", pub: "wood-dark", living: "carpet" };
// B1 `theme` → a wall material (interiorWall takes plaster|wood|brick|tile).
const THEME_TO_WALL = { kitchen: "tile", grocery: "plaster", workshop: "brick", classroom: "plaster", bedroom: "plaster", pub: "wood", living: "plaster" };

export class InteriorScene extends Phaser.Scene {
  constructor() {
    super("interior");
    this.TILE = 48;                 // RENDER tile px (interiors are roomy); independent of the data's own `tile`
    this.data = null;               // current interior layout (world.buildings[b].interior shape)
    this.dataProvider = defaultDataProvider(); // reads real __townWorld interiors + /who-inside; stub fallback
    this.artPack = null;            // resolved from ?art= in create(); B3 extends this same pack object
    this.furnitureNodes = [];
    this.agentSprites = new Map();  // id -> { sprite, label }
    this.agentState = new Map();    // id -> { x, y, tx, ty, color } (x,y = interior tile coords)
    this._onExit = null;            // callback the host wires to return to the town scene
    this._buildingId = null;
  }

  // ---- external API (the host/town calls these) ----
  // Enter a building's interior. `buildingId` selects the data; `onExit` is invoked when the user hits EXIT.
  enter(buildingId, onExit) {
    this._buildingId = buildingId;
    this._onExit = onExit || null;
    if (this._created) this.buildInterior();
  }
  setDataProvider(p) { if (p) this.dataProvider = p; } // B1 injection seam
  // live occupant update (the interior analog of applyTick) — B1 shape {id,x,y,sublocationId?}. The host forwards
  // the {type:"interior", building, occupants} WS push here (filtered to THIS building). Color isn't in the
  // presence payload, so resolve it from the town's color map (window.__townColors) when available.
  applyOccupants(occupants) {
    if (!this._created || !this.data) return;
    const colorOf = (id) => { try { return (typeof window !== "undefined" && window.__townColors && window.__townColors[id]) || undefined; } catch { return undefined; } };
    // D-interior-social (a): DIFF the prev occupant set vs this push to classify each transition (mirrors
    // interiorist's diffPresence verb rules, CLIENT-side, derived purely from the {type:"interior"} broadcast):
    //   new id → entered · gone id → left · sublocationId none→spot / spot→other → sat/moved · spot→none → stood.
    // Each fires a one-shot visual CUE so the room reads as alive ("walks in, sits down, gets up, leaves").
    for (const o of occupants || []) {
      let st = this.agentState.get(o.id);
      const col = o.color || colorOf(o.id);
      const prevSub = st ? st.sublocationId : undefined;
      const isNew = !st;
      if (!st) { st = { x: o.x, y: o.y, tx: o.x, ty: o.y, color: col, sublocationId: o.sublocationId }; this.agentState.set(o.id, st); }
      st.x = o.x; st.y = o.y; if (col) st.color = col;
      st.sublocationId = o.sublocationId;
      if (!this.agentSprites.has(o.id)) this.spawnOccupant({ ...o, color: st.color });
      // classify the transition (only on a CHANGE — unchanged occupants fire nothing)
      if (isNew) this._presenceCue(o.id, "entered");
      else if (prevSub !== o.sublocationId) {
        if (o.sublocationId && this._subKind(o.sublocationId) === "table") this._presenceCue(o.id, "sat");
        else if (o.sublocationId) this._presenceCue(o.id, "moved");
        else this._presenceCue(o.id, "stood");
      }
    }
    // drop sprites for anyone no longer inside this building — with a brief fade-out (left) before destroy.
    const here = new Set((occupants || []).map((o) => o.id));
    for (const id of [...this.agentSprites.keys()]) if (!here.has(id)) { this._fadeOutAndDestroy(id); }
    this._applyCameraSplit(); // new occupant sprites are world objects → keep them off the HUD camera
  }

  // the kind of a sublocation by id (for sat-vs-moved classification) — from the interior def.
  _subKind(subId) {
    const s = this.data && Array.isArray(this.data.sublocations) ? this.data.sublocations.find((x) => x.id === subId) : null;
    return s ? s.kind : undefined;
  }

  // D-interior-social (b): a TABLE-TALK marker. The host (town-renderer) forwards a closed dialogue record here
  // when a participant is inside the open building. We JOIN client-side: each participant's CURRENT sublocationId
  // (from agentState — no new broadcast field) → if ≥2 share one social spot (a table/counter/stage), float a
  // transient 💬 glyph + soft highlight over that spot for a few seconds so a table-of-talkers reads as a scene.
  // Degrades clean: participants at different spots, or not both inside, or a non-"conversed" outcome → no marker.
  onDialogue(d) {
    if (!this._created || !this.data || !d || d.outcome !== "conversed") return;
    const parts = Array.isArray(d.participants) ? d.participants : [];
    if (parts.length < 2) return;
    // group the participants we can see by their current sublocation
    const bySpot = new Map();
    for (const id of parts) {
      const st = this.agentState.get(id);
      const sub = st && st.sublocationId;
      if (!sub) continue;
      const k = this._subKind(sub);
      if (k !== "table" && k !== "counter" && k !== "stage") continue; // social spots only
      let arr = bySpot.get(sub); if (!arr) { arr = []; bySpot.set(sub, arr); }
      arr.push(id);
    }
    // mark every spot where ≥2 of the participants are sitting together
    for (const [subId, who] of bySpot) if (who.length >= 2) this._showTableTalk(subId, d.topic);
  }

  // Draw a transient speech glyph + a soft pulsing highlight over a sublocation tile. Re-keyed per sublocation
  // (a fresh dialogue at the same table refreshes it); self-destroys after a few seconds. Tracked in
  // _tableTalk so a room rebuild (buildInterior) can clear stale markers.
  _showTableTalk(subId, topic) {
    if (!this._tableTalk) this._tableTalk = new Map();
    const s = this.data.sublocations.find((x) => x.id === subId); if (!s) return;
    const old = this._tableTalk.get(subId); if (old) { try { old.container.destroy(); } catch {} if (old.timer && old.timer.remove) { try { old.timer.remove(false); } catch {} } this._tableTalk.delete(subId); }
    const T = this.TILE, cx = s.x * T + T / 2, cy = s.y * T;
    // a soft highlight ring under the glyph + a 💬 bubble above the table
    const hi = this.add.graphics();
    hi.fillStyle(0xffe08a, 0.16); hi.fillRoundedRect(s.x * T - 2, s.y * T - 2, T + 4, T + 4, 6);
    hi.lineStyle(2, 0xffe08a, 0.5); hi.strokeRoundedRect(s.x * T - 2, s.y * T - 2, T + 4, T + 4, 6);
    const glyph = this.add.text(cx, cy - T * 0.55, "💬", { fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.6)}px` }).setOrigin(0.5, 1);
    const container = this.add.container(0, 0, [hi, glyph]).setDepth(99994);
    // a gentle bob on the glyph (guarded for headless)
    if (this.tweens && typeof this.tweens.add === "function") this.tweens.add({ targets: glyph, y: glyph.y - T * 0.12, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    const entry = { container };
    if (this.time && typeof this.time.delayedCall === "function") entry.timer = this.time.delayedCall(4500, () => { try { container.destroy(); } catch {} this._tableTalk.delete(subId); });
    this._tableTalk.set(subId, entry);
  }

  // A one-shot presence CUE over an occupant: a brief expanding ring (sat/moved/entered) or a soft fade-in on
  // spawn. Cheap + self-destroying — no per-frame work, no leak. Guarded so the headless engine-test (no tween
  // loop) is a no-op. Colors: entered/sat = warm (arrival/settle), stood/moved = cool (transit).
  _presenceCue(id, kind) {
    const vis = this.agentSprites.get(id); if (!vis || !vis.sprite) return;
    const T = this.TILE, st = this.agentState.get(id); if (!st) return;
    // entered: fade the freshly-spawned sprite in
    if (kind === "entered" && vis.sprite.setAlpha && this.tweens && typeof this.tweens.add === "function") {
      vis.sprite.setAlpha(0); if (vis.label && vis.label.setAlpha) vis.label.setAlpha(0);
      this.tweens.add({ targets: [vis.sprite, vis.label].filter(Boolean), alpha: 1, duration: 280, ease: "Quad.easeOut" });
    }
    // a ring pulse at the occupant's destination (all kinds except a plain entered fade get one too)
    if (this.add && typeof this.add.graphics === "function" && this.tweens && typeof this.tweens.add === "function") {
      const warm = kind === "entered" || kind === "sat";
      const color = warm ? 0xffb347 : 0x8ad6ff;
      const ring = this.add.graphics().setDepth(99996);
      const cx = st.tx * T + T / 2, cy = st.ty * T + T / 2 + T * 0.3; // at the feet
      const draw = (r, a) => { ring.clear(); ring.lineStyle(2.5, color, a); ring.strokeEllipse(cx, cy, r * 2, r * 0.9); };
      draw(T * 0.2, 0.9);
      this.tweens.add({ targets: { r: T * 0.2, a: 0.9 }, r: T * 0.7, a: 0, duration: 520, ease: "Quad.easeOut",
        onUpdate: (tw, tgt) => draw(tgt.r, tgt.a), onComplete: () => ring.destroy() });
    }
  }

  // Fade an occupant out (left the building), then destroy. Falls back to instant destroy headless.
  _fadeOutAndDestroy(id) {
    const vis = this.agentSprites.get(id);
    if (!vis || !vis.sprite || !vis.sprite.setAlpha || !this.tweens || typeof this.tweens.add !== "function") { this.destroyOccupant(id); return; }
    this.tweens.add({ targets: [vis.sprite, vis.label].filter(Boolean), alpha: 0, duration: 240, ease: "Quad.easeIn", onComplete: () => this.destroyOccupant(id) });
    // detach from the live maps NOW so a re-entry during the fade re-spawns cleanly (the fading ghost just expires)
    this.agentSprites.delete(id); this.agentState.delete(id);
    // keep the fading sprite/label alive only for the tween (they're no longer tracked)
    if (vis._fading) return; vis._fading = true;
  }

  // ---- Phaser lifecycle ----
  preload() {
    this.artPack = resolveAssetPack();
    // The pack's preload() queues ground/buildings/chars + the B3 interior pieces (floors/walls/objects). Phaser
    // dedupes by key, so calling it here is cheap even though the town scene already loaded most of it (the
    // interior scene runs in the SAME game, sharing the TextureManager). A pack without preload() is a no-op.
    if (typeof this.artPack.preload === "function") this.artPack.preload(this);
  }
  create() {
    this._created = true;
    this.cameras.main.setBackgroundColor(0x0b0b0a);
    this.input.setTopOnly(false);
    this.mkChrome();        // header + EXIT button + minimap container
    this.setupCamera();
    // HUD CAMERA: a dedicated second camera renders the chrome (header/EXIT/minimap) at a FIXED zoom 1 / scroll 0,
    // so it stays pinned to the screen regardless of the world camera's zoom/pan. (A bare setScrollFactor(0)
    // object is STILL scaled by the world camera's zoom — the interior frames at zoom ~1.4, so the chrome drifted
    // off the top-left + scaled; the operator couldn't find EXIT. Same class as the day/night-tint zoom bug.)
    // The world (main) camera IGNORES the chrome; the HUD camera IGNORES the world content. Re-applied on rebuild.
    this._uiCam = this.cameras.add(0, 0, this.scale.gameSize.width || this.cameras.main.width, this.scale.gameSize.height || this.cameras.main.height);
    this._uiCam.setScroll(0, 0);
    this._applyCameraSplit();
    this.buildInterior();   // builds if enter() already ran; else waits for enter()
  }

  // Route the chrome to the HUD camera and the world to the main camera. The main camera ignores the chrome
  // objects; the HUD camera ignores every non-chrome (world) object. Called after create() + every buildInterior()
  // (the world objects are rebuilt, so the HUD camera's ignore-list must be refreshed).
  _applyCameraSplit() {
    if (!this._uiCam) return;
    const chrome = [this._header, this._exitBg, this._exitTxt, this._exitHint, this._exitHit, this._minimap].filter(Boolean);
    // world = everything on the display list that isn't chrome
    const all = (this.children && this.children.list) ? this.children.list : [];
    const chromeSet = new Set(chrome);
    const worldObjs = all.filter((o) => !chromeSet.has(o));
    try { this.cameras.main.ignore(chrome); } catch { /* objects may not all exist yet */ }
    try { this._uiCam.ignore(worldObjs); } catch { /* */ }
  }

  // build the room: floor, walls, furniture at sub-locations, then occupants. Idempotent (rebuild-safe).
  buildInterior() {
    if (!this._created) return;
    this.data = this.dataProvider.getInterior(this._buildingId);
    const d = this.data, T = this.TILE;
    // teardown a prior room
    if (this._floor) this._floor.destroy();
    for (const n of this.furnitureNodes) n.destroy();
    this.furnitureNodes = [];
    for (const id of [...this.agentSprites.keys()]) this.destroyOccupant(id);
    // clear any stale table-talk markers from the prior room (D-interior-social b)
    if (this._tableTalk) { for (const [, m] of this._tableTalk) { try { m.container.destroy(); } catch {} if (m.timer && m.timer.remove) { try { m.timer.remove(false); } catch {} } } this._tableTalk.clear(); }
    // floor: decorator's B3 floor tile (interiorFloor takes a MATERIAL — map theme→material), else a flat fill.
    // B3's interiorFloor ALWAYS returns a key (real crop or a generated flat tile), so prefer it when present.
    const floorKey = typeof this.artPack.interiorFloor === "function" ? this.artPack.interiorFloor(this, THEME_TO_FLOOR[d.theme] || "wood") : null;
    const intTileSrc = this.artPack.tileSizeInterior || this.artPack.tileSize || 16;
    const g = this.add.graphics().setDepth(0);
    this._floor = g;
    if (floorKey && this.textures.exists(floorKey)) {
      const ts = this.add.tileSprite(0, 0, d.w * T, d.h * T, floorKey).setOrigin(0, 0).setDepth(0);
      ts.setTileScale(T / intTileSrc, T / intTileSrc);
      this.furnitureNodes.push(ts); // tracked for teardown
    } else {
      g.fillStyle(FLOOR_FILL[d.theme] || FLOOR_FILL.generic, 1);
      g.fillRect(0, 0, d.w * T, d.h * T);
    }
    // wall border: a band of the B3 wall tile around the edge when available, else a dark stroke
    const wallKey = typeof this.artPack.interiorWall === "function" ? this.artPack.interiorWall(this, THEME_TO_WALL[d.theme] || "plaster") : null;
    if (wallKey && this.textures.exists(wallKey)) {
      const wb = Math.round(T * 0.5); // wall band thickness
      const top = this.add.tileSprite(0, 0, d.w * T, wb, wallKey).setOrigin(0, 0).setDepth(2);
      top.setTileScale(T / intTileSrc, (wb / intTileSrc));
      this.furnitureNodes.push(top);
    }
    g.lineStyle(Math.max(3, T * 0.12), 0x14110e, 1).strokeRect(0, 0, d.w * T, d.h * T);
    g.lineStyle(1, 0xffffff, 0.04);
    for (let x = 1; x < d.w; x++) { g.beginPath(); g.moveTo(x * T, 0); g.lineTo(x * T, d.h * T); g.strokePath(); }
    for (let y = 1; y < d.h; y++) { g.beginPath(); g.moveTo(0, y * T); g.lineTo(d.w * T, y * T); g.strokePath(); }
    // entry/exit marker at spawnInside (cosmetic — the door you came in through)
    if (d.spawnInside) { const dg = this.add.graphics().setDepth(1); dg.fillStyle(0x0b0b0a, 1); dg.fillRect(d.spawnInside.x * T + T * 0.2, d.spawnInside.y * T + T * 0.55, T * 0.6, T * 0.45); this.furnitureNodes.push(dg); }
    // furniture + seats at each sub-location (real B3 sprite if offered, else a labeled colored rect)
    for (const s of d.sublocations || []) this.drawFurniture(s);
    // initial occupants: one-shot fetch (live updates arrive via the host forwarding the {type:"interior"} WS push)
    if (typeof this.dataProvider.fetchOccupants === "function") {
      Promise.resolve(this.dataProvider.fetchOccupants(this._buildingId)).then((occ) => { if (this.data === d) this.applyOccupants(occ); }).catch(() => {});
    }
    this.fitToView();
    this.drawMinimap();
    const label = d._label || this._buildingId;
    if (this._header) this._header.setText(`  ${label}  ·  interior  `);
    this._applyCameraSplit(); // world objects were rebuilt → refresh which camera renders what
  }

  drawFurniture(s) {
    const T = this.TILE, w = T, h = T; // B1 sublocations are single-tile anchors (x,y)
    const px = s.x * T, py = s.y * T;
    // seats first (drawn under/around the table) — small pads at each seat coord
    for (const seat of s.seats || []) {
      const sg = this.add.graphics().setDepth(seat.y * T + T);
      sg.fillStyle(SEAT_FILL, 1); sg.fillRoundedRect(seat.x * T + T * 0.28, seat.y * T + T * 0.28, T * 0.44, T * 0.44, 4);
      this.furnitureNodes.push(sg);
    }
    // B3 furniture: interiorObject(name) resolves a specific id (espresso-machine, bar-counter…) via decorator's
    // alias table, else the B1 kind; returns null when there's no crop → we draw the placeholder rect below.
    // The interior crops are on a 48px grid; contain-fit to the tile box at natural aspect (no stretch).
    const artKey = typeof this.artPack.interiorObject === "function" ? (this.artPack.interiorObject(this, s.id) || this.artPack.interiorObject(this, s.kind)) : null;
    if (artKey && this.textures.exists(artKey)) {
      const src = this.textures.get(artKey).getSourceImage();
      const sw = (src && src.width) || T, sh = (src && src.height) || T;
      // let furniture be up to ~1.4 tiles tall (some pieces are taller than 1 tile), bottom-anchored on the tile
      const scale = Math.min((w * 1.2) / sw, (h * 1.4) / sh);
      const img = this.add.image(px + w / 2, py + h, artKey).setOrigin(0.5, 1).setDisplaySize(sw * scale, sh * scale).setDepth(py + h);
      this.furnitureNodes.push(img);
    } else {
      const meta = FURNITURE[s.kind] || { fill: 0x44444a, label: "▢" };
      const r = this.add.graphics().setDepth(py + h);
      r.fillStyle(meta.fill, 1); r.fillRoundedRect(px + 4, py + 4, w - 8, h - 8, 5);
      // a station (where a producer works) gets a subtle accent ring so the workspace reads
      r.lineStyle(2, s.station ? 0xff9100 : 0x000000, s.station ? 0.7 : 0.4).strokeRoundedRect(px + 4, py + 4, w - 8, h - 8, 5);
      this.furnitureNodes.push(r);
      const t = this.add.text(px + w / 2, py + h / 2, meta.label, { fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.4)}px`, color: "#ffffff" }).setOrigin(0.5).setAlpha(0.5).setDepth(py + h);
      this.furnitureNodes.push(t);
    }
    // sub-location name plate (B1 `label`) — a SUBTLE ground-label BELOW the furniture so it never fights the
    // furniture sprite or an occupant's name (which float above the head). Dim + small; the art carries the read.
    const lbl = this.add.text(px + w / 2, py + h + 1, s.label || s.kind, { fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.18)}px`, color: "#8a8a82", stroke: "#0b0b0a", strokeThickness: 2 }).setOrigin(0.5, 0).setAlpha(0.8).setDepth(5);
    this.furnitureNodes.push(lbl);
  }

  spawnOccupant(o) {
    const T = this.TILE;
    const st = this.agentState.get(o.id) || { tx: o.x, ty: o.y };
    const key = typeof this.artPack.agentTextureKey === "function" ? this.artPack.agentTextureKey(this, o) : null;
    let sprite;
    if (key && this.textures.exists(key)) {
      sprite = this.add.image(st.tx * T + T / 2, st.ty * T + T / 2, key);
      const tex = this.textures.get(key).getSourceImage();
      const tall = tex && tex.height > tex.width * 1.4;
      if (tall) { sprite.setOrigin(0.5, 0.82); sprite.setDisplaySize(tex.width * (T * 1.7 / tex.height), T * 1.7); } else sprite.setOrigin(0.5);
      sprite._tall = !!tall;
    } else {
      // stub coin
      const r = this.add.graphics();
      const col = Phaser.Display.Color.HexStringToColor(o.color || "#ff9100").color;
      r.fillStyle(0x000000, 0.35).fillCircle(T / 2, T / 2 + 1, T * 0.28 + 1);
      r.fillStyle(col, 1).fillCircle(T / 2, T / 2, T * 0.28);
      r.lineStyle(2, 0x0b0b0a, 1).strokeCircle(T / 2, T / 2, T * 0.28);
      sprite = r;
    }
    const label = this.add.text(st.tx * T + T / 2, st.ty * T + T / 2 - T * 0.5, o.id, { fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.26)}px`, color: "#fafaf5", stroke: "#0b0b0a", strokeThickness: 2 }).setOrigin(0.5);
    this.agentSprites.set(o.id, { sprite, label });
  }
  destroyOccupant(id) { const v = this.agentSprites.get(id); if (v) { v.sprite.destroy(); v.label.destroy(); this.agentSprites.delete(id); } this.agentState.delete(id); }

  update() {
    if (!this._created || !this.data) return;
    const T = this.TILE;
    for (const [id, vis] of this.agentSprites) {
      const st = this.agentState.get(id); if (!st) continue;
      st.tx += (st.x - st.tx) * EASE; st.ty += (st.y - st.ty) * EASE;
      const cx = st.tx * T + T / 2, cy = st.ty * T + T / 2;
      const depth = (st.ty + 1) * T + 2;
      if (vis.sprite.setPosition) vis.sprite.setPosition(cx, cy).setDepth(depth);
      const headY = vis.sprite._tall ? cy - T * 1.5 : cy - T * 0.5;
      vis.label.setPosition(cx, headY).setDepth(99999);
    }
  }

  // ---- chrome: header, EXIT button, minimap ----
  mkChrome() {
    // header plate (top-left): the building name
    this._header = this.add.text(0, 0, "  interior  ", { fontFamily: "ui-monospace, monospace", fontSize: "18px", color: "#ff9100", backgroundColor: "#0b0b0a" }).setOrigin(0, 0).setScrollFactor(0).setDepth(100000).setPadding(8, 7, 8, 7);
    // EXIT — a PROMINENT button (operator couldn't find the old bare top-right text). A bordered orange pill in
    // the TOP-LEFT (where eyes land first, right under the building name) with a hover glow + an "(Esc)" hint, so
    // it unmistakably reads as "the way back". Built as bg Graphics + Text in a scroll-locked container.
    this._exitBg = this.add.graphics().setScrollFactor(0).setDepth(100001);
    this._exitTxt = this.add.text(0, 0, "← EXIT TO TOWN", { fontFamily: "ui-monospace, monospace", fontSize: "16px", fontStyle: "bold", color: "#0b0b0a" }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(100002);
    this._exitHint = this.add.text(0, 0, "Esc", { fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#0b0b0a" }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(100002).setAlpha(0.7);
    this._exitHover = false;
    this._drawExitButton();
    // a generous invisible hit-zone over the pill (scroll-locked) so the whole button is clickable, not just glyphs
    this._exitHit = this.add.zone(0, 0, 10, 10).setOrigin(0, 0).setScrollFactor(0).setDepth(100003).setInteractive({ useHandCursor: true });
    this._exitHit.on("pointerover", () => { this._exitHover = true; this._drawExitButton(); });
    this._exitHit.on("pointerout", () => { this._exitHover = false; this._drawExitButton(); });
    this._exitHit.on("pointerdown", (p, x, y, ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); this.exit(); });
    // Esc exits (operator ask). keydown-ESC fires on the ACTIVE scene; the interior scene is active while shown.
    this.input.keyboard?.on("keydown-ESC", () => this.exit());
    this.positionChrome();
    this.scale.on("resize", () => { this.positionChrome(); this.fitToView(); this.drawMinimap(); });
  }
  // Draw/redraw the EXIT pill (idempotent — called on hover toggle + reposition). Orange fill normally, brighter
  // on hover, with a dark border. Sized to the label + the "Esc" hint chip.
  _drawExitButton() {
    if (!this._exitBg || !this._exitTxt) return;
    const padX = 14, padY = 9, gap = 8;
    const labelW = this._exitTxt.width, hintW = this._exitHint ? this._exitHint.width + 10 : 0; // hint has its own chip pad
    const w = padX + labelW + gap + hintW + padX, h = this._exitTxt.height + padY * 2;
    this._exitW = w; this._exitH = h;
    const fill = this._exitHover ? 0xffb84d : 0xff9100;
    this._exitBg.clear();
    this._exitBg.fillStyle(0x000000, 0.35); this._exitBg.fillRoundedRect(3, 5, w, h, 9);   // drop shadow
    this._exitBg.fillStyle(fill, 1); this._exitBg.fillRoundedRect(0, 0, w, h, 9);            // body
    this._exitBg.lineStyle(2, 0x0b0b0a, 1); this._exitBg.strokeRoundedRect(0, 0, w, h, 9);   // border
    // "Esc" hint chip (a subtle inset box at the right)
    if (this._exitHint) { const hx = padX + labelW + gap, hw = this._exitHint.width + 8; this._exitBg.fillStyle(0x0b0b0a, 0.16); this._exitBg.fillRoundedRect(hx - 4, h / 2 - 9, hw, 18, 4); }
  }
  positionChrome() {
    if (this._header) this._header.setPosition(12, 12);
    // EXIT pill sits TOP-LEFT, just below the building-name header (eyes land here first).
    const ex = 12, ey = 12 + (this._header ? this._header.height : 30) + 8;
    if (this._exitBg) this._exitBg.setPosition(ex, ey);
    if (this._exitTxt) this._exitTxt.setPosition(ex + 14, ey + (this._exitH || 36) / 2);
    if (this._exitHint) this._exitHint.setPosition(ex + 14 + this._exitTxt.width + 8 + 4, ey + (this._exitH || 36) / 2);
    if (this._exitHit) this._exitHit.setPosition(ex, ey).setSize(this._exitW || 160, this._exitH || 36);
  }
  exit() { if (typeof this._onExit === "function") this._onExit(this._buildingId); }

  // minimap: a tiny top-right-under-EXIT schematic of the room + occupant dots (scroll-locked).
  drawMinimap() {
    if (!this.data) return;
    if (this._minimap) this._minimap.destroy();
    const d = this.data;
    const MW = 120, scale = MW / (d.w * this.TILE), MH = d.h * this.TILE * scale;
    const vw = this.scale.gameSize.width || this.cameras.main.width;
    const ox = vw - MW - 16, oy = 52;
    const g = this.add.graphics().setScrollFactor(0).setDepth(100000);
    g.fillStyle(0x0b0b0a, 0.85).fillRect(ox - 4, oy - 4, MW + 8, MH + 8);
    g.lineStyle(1, 0x2a2a2a, 1).strokeRect(ox - 4, oy - 4, MW + 8, MH + 8);
    g.fillStyle(0x33333a, 1).fillRect(ox, oy, MW, MH);
    for (const s of d.sublocations || []) { const meta = FURNITURE[s.kind] || { fill: 0x55555a }; g.fillStyle(meta.fill, 1); g.fillRect(ox + s.x * this.TILE * scale, oy + s.y * this.TILE * scale, Math.max(2, this.TILE * scale), Math.max(2, this.TILE * scale)); }
    for (const [, st] of this.agentState) { const col = Phaser.Display.Color.HexStringToColor(st.color || "#ff9100").color; g.fillStyle(col, 1).fillCircle(ox + st.tx * this.TILE * scale, oy + st.ty * this.TILE * scale, 2.5); }
    this._minimap = g;
  }

  // ---- camera: contain-fit the room + gentle pan/zoom (mirrors the town's framing approach) ----
  // Also owns the INTERIOR click hit-test: the town inspector stands down in interior view (the __townView guard),
  // so the interior scene itself resolves a click → an occupant → opens that citizen's card via the SAME
  // window.__inspector.openAgent(id). A drag (pan) is distinguished from a click by movement threshold, so panning
  // the room doesn't open a card.
  setupCamera() {
    const cam = this.cameras.main;
    this._dragging = false; this._dragLast = { x: 0, y: 0 };
    this._downAt = { x: 0, y: 0 }; this._moved = false;
    this.input.on("pointerdown", (p) => { this._dragging = true; this._moved = false; this._dragLast.x = p.x; this._dragLast.y = p.y; this._downAt.x = p.x; this._downAt.y = p.y; });
    this.input.on("pointermove", (p) => {
      if (!this._dragging || !p.isDown) return;
      cam.scrollX -= (p.x - this._dragLast.x) / cam.zoom; cam.scrollY -= (p.y - this._dragLast.y) / cam.zoom;
      this._dragLast.x = p.x; this._dragLast.y = p.y;
      if (Math.hypot(p.x - this._downAt.x, p.y - this._downAt.y) > 5) this._moved = true; // it's a drag, not a click
    });
    const end = (p) => {
      const wasClick = this._dragging && !this._moved;
      this._dragging = false;
      if (wasClick && p) this._handleInteriorClick(p);
    };
    this.input.on("pointerup", end);
    this.input.on("pointerupoutside", () => { this._dragging = false; });
  }

  // A click inside the interior: pick the nearest occupant within a tile of the cursor and open their card. Skips
  // clicks on the chrome (EXIT/minimap have their own handlers + higher depth). Falls back to no-op on empty space.
  _handleInteriorClick(p) {
    if (!this._created || !this.data) return;
    const cam = this.cameras.main, T = this.TILE;
    const world = cam.getWorldPoint(p.x, p.y); // screen → interior world px (camera-aware)
    let best = null, bestD2 = (0.9 * T) * (0.9 * T); // within ~0.9 interior tiles
    for (const [id, st] of this.agentState) {
      if (!this.agentSprites.has(id)) continue;
      const cx = st.tx * T + T / 2, cy = st.ty * T + T / 2;
      const d2 = (cx - world.x) * (cx - world.x) + (cy - world.y) * (cy - world.y);
      if (d2 <= bestD2) { bestD2 = d2; best = id; }
    }
    if (best && typeof window !== "undefined" && window.__inspector && typeof window.__inspector.openAgent === "function") {
      // open at the click point (screen coords) — the inspector positions the panel near it
      window.__inspector.openAgent(best, p.event ? p.event.clientX : undefined, p.event ? p.event.clientY : undefined);
    }
  }
  fitToView() {
    if (!this.data) return;
    const cam = this.cameras.main, T = this.TILE;
    const roomW = this.data.w * T, roomH = this.data.h * T;
    const vw = this.scale.gameSize.width || cam.width, vh = this.scale.gameSize.height || cam.height;
    if (!vw || !vh) return;
    const PAD = 60, TOP = 56;
    const z = Math.min((vw - 2 * PAD) / roomW, (vh - TOP - 2 * PAD) / roomH);
    cam.setZoom(z);
    cam.centerOn(roomW / 2, roomH / 2 + TOP / (2 * z));
  }
}

// Export the pure stub for headless tests (the scene builds from it without a live B1).
export { stubInterior };
