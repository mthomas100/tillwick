// renderer/phaser/town-renderer.js — the Wave 3 renderer ENTRY POINT (replaces renderer/main.js).
// Boots the Phaser game into #left, wires the sim WebSocket to the scene + activity feed, and keeps the
// load-bearing coexistence contracts the existing DOM overlays depend on:
//   - the Phaser <canvas> gets id="c"            → inspector.js (getElementById("c")) binds its click handler;
//   - window.__townRenderPos / __townDrawPos     → published every frame by the scene for inspector hit-tests;
//   - window.__townWorld                          → the world for inspector/control overlays;
//   - #hud / #feed / tx-overlay / inspector / control plane → untouched DOM siblings on top of the canvas.
//
// Mount order matters: index.html loads phaser.min.js (global Phaser) BEFORE this module. This file is an ESM
// module (type="module"), same as the old main.js, so the <script type="module" src="./phaser/town-renderer.js">
// swap is a one-line change in index.html (the lead applies it — index.html is a hot file).

import { TownScene } from "./town-scene.js";
import { InteriorScene } from "./interior-scene.js";
import { createFeed } from "./feed.js";

const hud = document.getElementById("hud");
const left = document.getElementById("left");

// shared color map (filled as agents arrive) — feed rows/bars match sprite colors. Also published as
// window.__townColors so the interior scene (B2) can color occupants the presence map doesn't carry a color for.
const colorByActor = {};
if (typeof window !== "undefined") window.__townColors = colorByActor;
const feed = createFeed({ colorByActor });

let scene = null;
let interiorScene = null;       // B2: the interior view (second Phaser scene; starts asleep)
let game = null;
let world = null;
let tickNo = 0;
let lastAgents = [];
let openInteriorBuilding = null; // the building whose interior is currently shown (null = town view)

function bootGame(w) {
  // Phaser canvas coordinate grid = the town's pixel size; CSS scales it to fit (max-width/height in index.html).
  scene = new TownScene();
  // Hand the world to the scene UP FRONT so its create() (which runs after preload's assets load) builds with
  // the data already present — independent of when the game's "ready" event fires. Agents are stashed too.
  scene.world = w; scene.TILE = w.tile; scene._pendingAgents = lastAgents;
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: left,
    backgroundColor: "#0b0b0a",
    pixelArt: true,
    // RESIZE: the canvas matches the #left container size exactly (fills the FULL vertical height, no black
    // band). The town's own pixel size becomes the WORLD; the scene sets the camera zoom so the town's HEIGHT
    // fills the viewport and pans horizontally for the rest (fitToContainer()).
    scale: { mode: Phaser.Scale.RESIZE, width: w.width * w.tile, height: w.height * w.tile },
    // ONLY the TownScene boots. The InteriorScene is NOT in this array — if it were, Phaser would AUTO-START it
    // (init→preload→create) and its create() would draw a room OVER the town (the "translucent square" bug).
    // We add it below with autoStart:false so it stays fully dormant (no init/preload/create, nothing rendered)
    // until a building click calls game.scene.run("interior"). Town view must be byte-identical to Wave A.
    scene: [scene],
    banner: false,
  });
  // Give the Phaser canvas the id the inspector expects + light chrome. NO max-height here — layout.css governs
  // the canvas size now (it fills #left), and the camera (not CSS) frames the town.
  game.events.once("ready", () => {
    const cv = game.canvas;
    if (cv) {
      cv.id = "c";
      cv.style.display = "block";
      cv.style.boxShadow = "0 0 0 1px #1a1a1a, 0 20px 60px rgba(0,0,0,.5)";
    }
    // hand the world to the scene now that it's live
    scene.setWorld(world, lastAgents);
    // B2: register the interior scene DORMANT (3rd arg autoStart=FALSE). It will not run until enterInterior()
    // calls scene.run("interior"). This is the fix for the over-town render: a scene that never started can't draw.
    interiorScene = new InteriorScene();
    game.scene.add("interior", interiorScene, false);
    if (typeof window !== "undefined") window.__townView = "town";
  });
}

function updateHud() {
  if (!hud || !world) return;
  const moving = lastAgents.filter((a) => a.moving).length;
  hud.innerHTML =
    `<b>${world.title}</b> · ${lastAgents.length} citizens · <span class="live">${moving}</span> walking · tick <span class="live">${tickNo}</span>` +
    `<br><span class="dim">Phaser · scroll to zoom · drag to pan · click a citizen to follow</span>`;
}

function rememberColors(agents) { for (const a of agents) if (a.color) colorByActor[a.id] = a.color; }

// ZOOM CONTROLS: self-injected + / − buttons in the MAP pane's bottom-right (clear of the activity feed on the
// right, the ⚙ CTRL tab top-right, and the 🎵 button bottom-left). Each press calls scene.zoomBy(), which nudges
// the eased _targetZoom that update() animates toward — so the zoom glides SMOOTHLY, never jumps. Mirrors the
// vanilla-IIFE style of music.js; mounted into #left (position:relative) so it sits in the map's corner. No
// index.html edit (this module is already loaded). Buttons disable at the clamp extremes for honest affordance.
function mountZoomControls() {
  const host = document.getElementById("left");
  if (!host || document.getElementById("zoom-controls")) return;
  const box = document.createElement("div");
  box.id = "zoom-controls";
  Object.assign(box.style, {
    position: "absolute", right: "14px", bottom: "14px", zIndex: "40",
    display: "flex", flexDirection: "column", gap: "6px",
  });
  const mkBtn = (label, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
    Object.assign(b.style, {
      width: "36px", height: "36px", fontSize: "20px", lineHeight: "34px", textAlign: "center", padding: "0",
      cursor: "pointer", background: "rgba(0,0,0,.55)", color: "#fafaf5", border: "1px solid #2a2a2a",
      borderRadius: "8px", fontFamily: "inherit", userSelect: "none", transition: "color .15s, border-color .15s",
    });
    b.onmouseenter = () => { if (!b.disabled) b.style.borderColor = "#ff9100"; };
    b.onmouseleave = () => { b.style.borderColor = "#2a2a2a"; };
    return b;
  };
  const plus = mkBtn("+", "Zoom in");
  const minus = mkBtn("−", "Zoom out"); // − (minus sign, not hyphen)
  // Reflect the clamp on the buttons: disable + at max, − at the whole-town floor.
  function syncDisabled() {
    if (!scene) return;
    const base = scene._baseZoom || 1, t = scene._targetZoom || base;
    const atMax = t >= base * 3 - 1e-3, atMin = t <= base + 1e-3;
    for (const [b, off] of [[plus, atMax], [minus, atMin]]) {
      b.disabled = off; b.style.opacity = off ? "0.45" : "1"; b.style.cursor = off ? "default" : "pointer";
    }
  }
  const press = (factor) => () => { if (scene && scene.zoomBy) { scene.zoomBy(factor); syncDisabled(); } };
  plus.addEventListener("click", press(1.3));
  minus.addEventListener("click", press(1 / 1.3));
  box.appendChild(plus); box.appendChild(minus);
  host.appendChild(box);
  // keep the disabled state honest as the wheel/pinch also moves the target
  setInterval(syncDisabled, 250);
  syncDisabled();
}
mountZoomControls();

// ---- B2: town ↔ interior scene switch ----
// Enter a building's interior: sleep the town scene, wake + drive the interior scene, flip the coexistence
// flag so the town overlays (inspector) stand down (they hit-test TOWN coords). The inspector calls this when a
// building WITH an `interior` is clicked (instead of opening the shop panel). Exit reverses it.
function enterInterior(buildingId) {
  if (!game || !interiorScene || !buildingId) return;
  const b = (world && Array.isArray(world.buildings)) ? world.buildings.find((x) => x.id === buildingId) : null;
  if (!b || !b.interior) return; // only modelled interiors are enterable (back-compat: others keep the shop panel)
  openInteriorBuilding = buildingId;
  if (typeof window !== "undefined") window.__townView = "interior";
  // hand the scene its building + the exit callback, then swap scenes (sleep town so it stops updating/eating input)
  interiorScene.enter(buildingId, exitInterior);
  if (game.scene.isSleeping("interior") || !game.scene.isActive("interior")) game.scene.run("interior");
  game.scene.sleep("town");
  game.scene.bringToTop("interior");
  // HIDE the town #hud DOM overlay while inside — it's town chrome ("N citizens walking") that's meaningless in
  // an interior AND it sits top-left exactly over the interior's EXIT button (the operator-flagged "can't find
  // the way back"). The interior scene draws its own header + EXIT. Restored on exit.
  if (hud) hud.style.display = "none";
}
function exitInterior() {
  if (!game) return;
  openInteriorBuilding = null;
  if (game.scene.isActive("interior")) game.scene.sleep("interior");
  game.scene.wake("town");
  if (typeof window !== "undefined") window.__townView = "town";
  if (hud) hud.style.display = ""; // restore the town HUD
  updateHud();
}

// ---- socket ----
const ws = new WebSocket(`ws://${location.host}`);
// PERSIST THE FEED ACROSS REFRESH: the WS only carries the LIVE stream, so a mid-run refresh blanks the
// activity panel. On connect, fetch the recent-event backlog once and replay it through the feed (same
// addEvent/addDialogue paths as live), THEN the live stream continues. Best-effort: a missing endpoint
// (older/stale sim) just leaves the feed live-only — exactly today's behavior, no error surfaced.
async function hydrateFeed() {
  try {
    const res = await fetch("/events?recent=200");
    if (!res.ok) return; // endpoint not present yet (stale sim) → silently stay live-only
    const backlog = await res.json();
    const n = feed.hydrate(backlog);
    if (n && (n.events || n.dialogues)) console.log(`[feed] hydrated ${n.events} events + ${n.dialogues} dialogues from backlog`);
  } catch { /* sim momentarily unreachable → live-only; the WS will still stream */ }
}
ws.onopen = () => { hydrateFeed(); };
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "world") {
    world = m.world; lastAgents = m.agents || []; rememberColors(lastAgents);
    if (typeof window !== "undefined") window.__townWorld = world;
    if (!game) bootGame(world);
    else scene?.setWorld(world, lastAgents);
    updateHud();
  } else if (m.type === "tick") {
    tickNo = m.tick; lastAgents = m.agents || []; rememberColors(lastAgents);
    scene?.applyTick(lastAgents);
    updateHud();
  } else if (m.type === "event") {
    feed.addEvent(m);
    scene?.onEvent(m);
  } else if (m.type === "dialogue") {
    feed.addDialogue(m);
    scene?.onDialogue(m);
    // D-interior-social (b): if the interior view is open and a participant is inside THAT building, forward the
    // closed dialogue to the interior scene so it can mark the table-talk (it joins participants→sublocationId).
    if (interiorScene && openInteriorBuilding && Array.isArray(m.participants) && m.participants.some((id) => interiorScene.agentState && interiorScene.agentState.has(id))) {
      interiorScene.onDialogue(m);
    }
  } else if (m.type === "interior") {
    // B2: the sim's presence map pushes {type:"interior", building, occupants:[{id,x,y,sublocationId?}]} on
    // enter/leave/go_inside. Forward to the interior scene ONLY when it's the building currently shown.
    if (interiorScene && m.building === openInteriorBuilding) interiorScene.applyOccupants(m.occupants || []);
  }
  // run-state / usage are handled by control.js (its own WS) — ignored here.
};
ws.onclose = () => { if (hud) hud.innerHTML = `<b>disconnected</b> <span class="dim">— is the sim running?</span>`; };

// expose for debugging / control overlay introspection + the B2 interior-switch entry the inspector calls.
if (typeof window !== "undefined") window.__townRenderer = {
  get scene() { return scene; },
  get interiorScene() { return interiorScene; },
  get world() { return world; },
  get view() { return openInteriorBuilding ? "interior" : "town"; },
  enterInterior, exitInterior,
};
