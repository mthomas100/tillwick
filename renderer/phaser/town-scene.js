// renderer/phaser/town-scene.js — the Phaser 3 scene that draws the living town (Wave 3 engine).
//
// REPLACES the flat-canvas draw in renderer/main.js. Responsibilities:
//   - build the town from sim/world.json (ground lanes + buildings) via the ACTIVE asset pack (art-agnostic);
//   - render agents as depth-sorted sprites that occlude correctly behind/in front of buildings;
//   - a camera (drag-to-pan, wheel-zoom, double-click an agent to follow, Esc/click-empty to release);
//   - 💬 emoji action bubbles from {type:"event"} say and {type:"dialogue"} records (conversations — NEW);
//   - publish the inspector contract every frame: window.__townRenderPos (interpolated tile pos) and
//     window.__townDrawPos (FANNED tile pos for crowded tiles), plus window.__townWorld — exactly what
//     renderer/inspector.js hit-tests against, so the existing inspector keeps working untouched.
//
// The scene OWNS no socket. It's fed by town-renderer.js (the glue) via setWorld()/applyTick()/onEvent()/
// onDialogue(). That keeps the scene a pure view and the WS handling in one place (the proven separation).
//
// Coexistence: Phaser renders into the #left container; town-renderer.js gives the created <canvas> the id
// "c" so inspector.js (document.getElementById("c")) binds its click handler to it. All DOM overlays
// (#feed, #hud, tx-overlay, inspector, control plane) remain absolutely-positioned siblings ON TOP.

import { resolveAssetPack } from "./assets.js";

const BUBBLE_MS = 6000; // how long a speech/dialogue bubble lingers
const FAN_RADIUS = 0.28; // tiles — ring radius for spreading co-located sprites (matches the old renderer)
const EASE = 0.2; // per-frame easing toward the tile target (smooth walking)
// A3-1: replay a real conversation as STAGGERED on-map bubbles (the back-and-forth becomes visible).
const DIALOGUE_STAGGER_MS = 1300; // gap between successive turns as they replay over the two speakers
const DIALOGUE_LINE_MS = 2400;    // how long each replayed turn's bubble lingers (> the gap so it reads)
// A3-2: a role-action status ("🥖 baking…") is a transient, lower-key bubble than a spoken line.
const STATUS_BUBBLE_MS = 4500;
// verb → emoji when a status event omits payload.emoji (behaviorist may send either). Fallback 🛠.
const STATUS_EMOJI = { bake: "🥖", busk: "🎸", play: "🎸", study: "📚", read: "📚", sell: "🪙", restock: "📦", deliver: "📦", tend: "🧹", clean: "🧹", cook: "🍳", brew: "☕", serve: "☕", craft: "🔨", forge: "🔨", build: "🔨", work: "🛠" };
// Does a string already LEAD with an emoji/pictograph? (so we don't double-prepend when behaviorist bakes the
// emoji into payload.text). Uses the Unicode Extended_Pictographic property — covers every emoji glyph; guarded
// so an engine lacking the \p{} class (very old) just falls back to "no leading emoji" (prepend our own).
let _emojiLead;
try { _emojiLead = /^\s*\p{Extended_Pictographic}/u; } catch { _emojiLead = null; }
function startsWithEmoji(s) { return !!_emojiLead && _emojiLead.test(String(s || "")); }

export class TownScene extends Phaser.Scene {
  constructor() {
    super("town");
    this.world = null;
    this.TILE = 28;
    this.pack = resolveAssetPack();
    this.agentSprites = new Map(); // id -> { sprite, label, ring, color }
    this.agentState = new Map();   // id -> { x, y, tx, ty, moving, adjacentTo } (tx/ty = render-interpolated)
    this.bubbles = new Map();      // id -> { container, expires }
    this._dialogueReplays = new Map(); // dialogue-id -> [delayedCall timers] (so an overlapping convo cancels stale turns)
    this.linkGfx = null;           // adjacency links layer
    this._buildingNodes = null; // loose building game objects (depth-sorted with agents)
    this.follow = null;            // agent id the camera follows, or null
    this._pendingWorld = null;     // world set before create() runs
    this._pendingAgents = null;
  }

  // ---- external feed (called by town-renderer.js) ----
  // The world data is handed in; the actual BUILD happens in create() (guaranteed AFTER preload's assets are
  // loaded — critical so LimeZu textures exist before buildings/agents are drawn). If create() hasn't run yet
  // we only STASH; if it has, we rebuild + re-sync (e.g. a sim restart sends a fresh `world`).
  setWorld(world, agents) {
    this.world = world;
    this.TILE = world.tile;
    this._pendingAgents = agents || this._pendingAgents;
    if (!this._created) return; // create() will build once assets are loaded
    this.buildTown();
    this.fitToContainer(); // re-frame the whole town (a restart may change world size); buildTown no longer sets bounds
    this.applyTick(agents, /*snap*/ true);
  }
  applyTick(agents, snap = false) {
    if (!agents || !this._created || !this.world) { if (agents) this._pendingAgents = agents; return; }
    for (const a of agents) {
      let st = this.agentState.get(a.id);
      if (!st) { st = { x: a.x, y: a.y, tx: a.x, ty: a.y, moving: !!a.moving, adjacentTo: a.adjacentTo || [] }; this.agentState.set(a.id, st); }
      st.x = a.x; st.y = a.y; st.moving = !!a.moving; st.adjacentTo = a.adjacentTo || [];
      st.color = a.color || st.color;
      if (snap) { st.tx = a.x; st.ty = a.y; }
      if (!this.agentSprites.has(a.id)) this.spawnAgent(a);
      else this.maybeUpgradeSprite(a); // a placeholder sprite → real texture once it has loaded
    }
  }

  // If an agent's sprite was created with a FALLBACK texture (asset not yet loaded at spawn) but its REAL
  // texture is now available, replace it. Belt-and-suspenders against any load/spawn race.
  maybeUpgradeSprite(a) {
    const vis = this.agentSprites.get(a.id);
    if (!vis || !vis.usedFallback) return;
    const want = this.pack.agentTextureKey(this, a);
    if (want === vis.sprite.texture.key) return; // still the same (still fallback) — nothing better yet
    // upgrade: destroy old sprite, respawn with the real texture
    vis.sprite.destroy(); vis.ring.destroy(); vis.label.destroy();
    this.agentSprites.delete(a.id);
    this.spawnAgent(a);
  }
  onEvent(ev) {
    if (!ev) return;
    if (ev.kind === "say" && ev.payload && ev.payload.text) {
      this.showBubble(ev.actor, `${ev.payload.text}`);
    } else if (ev.kind === "status" && ev.payload) {
      // A3-2: a role-action status — a transient emoji bubble over the actor ("🥖 baking…"). Robust to BOTH
      // agreed conventions (locked w/ behaviorist): the emoji may live in a separate `payload.emoji`, OR be
      // baked into `payload.text` ("🥖 baking…"). So: start from `text`; only PREPEND an emoji if the text
      // doesn't already lead with one (else "🥖 baking…" would render "🥖 🥖 baking…"). Emoji source order:
      // explicit payload.emoji → verb→emoji map → 🛠 default.
      const p = ev.payload;
      const verb = String(p.verb || "").toLowerCase();
      const text = (p.text != null && String(p.text).trim()) ? String(p.text).trim() : (verb || "working…");
      const emoji = p.emoji || STATUS_EMOJI[verb] || "🛠";
      const label = startsWithEmoji(text) ? text : `${emoji} ${text}`;
      // honor an optional payload.ttlMs (behaviorist may send a fade hint); else our default linger.
      const ttl = (typeof p.ttlMs === "number" && p.ttlMs > 0) ? p.ttlMs : STATUS_BUBBLE_MS;
      this.showBubble(ev.actor, label, ttl);
    }
  }

  // A3-1 — VISIBLE real conversations. The sim broadcasts a CLOSED conversation as
  //   {type:"dialogue", op:"record", participants:[a,b], outcome, topic, turns, transcript:[{speaker,text}], ...}
  // The genuine back-and-forth lives in transcript[] (confirmed live: 20/26 records are 4-turn "conversed").
  // We REPLAY it as staggered speech bubbles alternating over the two speakers so the operator literally sees
  // them talking. The first turn (and the reply, if present) shows IMMEDIATELY — the exchange starts on screen
  // at once and the engine-test's "both participants get a bubble synchronously" invariant holds — then the
  // remaining turns play in over DIALOGUE_STAGGER_MS each. (The feed still gets its one-line summary, in parallel.)
  onDialogue(d) {
    if (!d || d.outcome !== "conversed") return;
    // Cancel any in-flight replay for THIS conversation (a re-broadcast / overlap) so stale turns don't fight.
    this._cancelReplay(d.id);
    const transcript = Array.isArray(d.transcript) ? d.transcript.filter((t) => t && t.text) : [];
    if (transcript.length < 2) {
      // Older sim or an empty transcript → fall back to the original single 💬 topic bubble on both speakers.
      const topic = d.topic ? `${d.topic}` : "chatting";
      for (const id of d.participants || []) this.showBubble(id, `💬 ${topic}`, DIALOGUE_LINE_MS);
      return;
    }
    // Show turn 0 (and turn 1, the first reply) synchronously — the conversation opens instantly, both speakers
    // light up. Stagger the rest. A bubble belongs to its turn's speaker; a fresh turn for the same speaker
    // replaces their previous one (showBubble already swaps), so each speaker shows their latest line.
    const timers = [];
    const playTurn = (i) => {
      const t = transcript[i];
      if (!t || !t.speaker) return;
      this.showBubble(t.speaker, `${t.text}`, DIALOGUE_LINE_MS);
    };
    playTurn(0);
    if (transcript.length > 1) playTurn(1); // immediate first reply → reads as a real exchange from frame 1
    // Schedule turns 2..n-1 (live path only — the headless engine-test has no real timer loop, which is fine:
    // its assertion only checks the synchronous opening pair).
    if (this.time && typeof this.time.delayedCall === "function") {
      for (let i = 2; i < transcript.length; i++) {
        const delay = (i - 1) * DIALOGUE_STAGGER_MS; // i=2 lands one stagger after the synchronous opener
        const handle = this.time.delayedCall(delay, () => playTurn(i));
        timers.push(handle);
      }
    }
    if (d.id) this._dialogueReplays.set(d.id, timers);
  }

  // Cancel + forget any pending replay turns for a dialogue id (overlap / supersede / teardown safety).
  _cancelReplay(id) {
    if (!id) return;
    const timers = this._dialogueReplays.get(id);
    if (timers) { for (const h of timers) { try { h.remove(false); } catch { /* already fired */ } } this._dialogueReplays.delete(id); }
  }

  // ---- Phaser lifecycle ----
  preload() { this.pack.preload(this); }

  create() {
    this.pack.ready(this); // assets from preload() are now loaded — safe to generate/use textures
    this._created = true;
    this.cameras.main.setBackgroundColor(this.pack.groundFill("grass"));
    this.linkGfx = this.add.graphics().setDepth(5);
    this.input.setTopOnly(false);
    this.setupCameraControls();
    // Build now that textures are guaranteed loaded (LimeZu facades/characters/ground all present).
    if (this.world) { this.buildTown(); this.applyTick(this._pendingAgents, true); this._pendingAgents = null; }
    // Frame the whole town (contain/letterbox), and re-frame whenever the canvas/container resizes (Scale.RESIZE).
    this.fitToContainer();
    this.scale.on("resize", () => this.fitToContainer());
    // COEXISTENCE SEAM (camera-aware hit-testing): the inspector/overlays convert a canvas-relative click to a
    // world TILE. Their legacy math assumed canvas-px == world-px (camera at zoom 1, scroll 0) — which is FALSE
    // now that the camera zooms/pans to frame the town (and whenever the user wheel-zooms). Publish the true
    // transform (Phaser camera getWorldPoint → tile units) so the inspector reads the EXACT tile under the cursor
    // at any zoom/scroll. inspector.js prefers this when present and falls back to its old math otherwise.
    if (typeof window !== "undefined") {
      window.__townScreenToTile = (canvasX, canvasY) => {
        const p = this.cameras.main.getWorldPoint(canvasX, canvasY);
        const T = this.TILE || 28;
        return { tx: p.x / T, ty: p.y / T, px: p.x, py: p.y };
      };
    }
    this.setupDayNight();   // A3-3: a camera-locked tint overlay driven by the game clock
    this.setupOccupancy();  // A3-4: per-building "who's inside" badges
  }

  // ---- A3-3: DAY/NIGHT TINT ----------------------------------------------------------------------------
  // A single full-viewport rectangle, locked to the camera (scrollFactor 0) at a very high depth and LOW alpha,
  // tinted from a 4-stop color ramp keyed on the game-clock hour (night→dawn→day→dusk). It is NON-interactive
  // (never setInteractive) and sits ABOVE everything, so it can't eat a click and never perturbs depth or the
  // inspector hit-test. The hour comes from a tiny independent GET /run-state poll (cheap; no coupling to
  // control.js, which owns its own socket). Cosmetic + additive — if the poll fails, the tint just stays put.
  setupDayNight() {
    // A WORLD-covering tint rectangle (NOT screen-fixed). The earlier screen-fixed version (setScrollFactor(0),
    // sized to cam.width×cam.height) was WRONG: a scrollFactor-0 object still gets scaled by the camera ZOOM, and
    // the town frames at zoom ~0.59, so a canvas-sized rect covered only ~59% of the screen (top-left) → a
    // translucent SQUARE with un-tinted map beyond it (operator-flagged). Fix: cover the whole WORLD at
    // scrollFactor 1 (moves with the map) sized to the full world px — every camera view then sees uniform tint at
    // any zoom/pan, with zero per-frame math. Non-interactive + high depth so it never eats clicks / perturbs
    // depth. Sized in buildTown()/here from the world; re-sized on a world rebuild via syncDayNightSize().
    this._dayNight = this.add.rectangle(0, 0, 10, 10, 0x0a0e2a, 0)
      .setOrigin(0, 0).setScrollFactor(1).setDepth(99000);
    if (this._dayNight.disableInteractive) this._dayNight.disableInteractive(); // belt-and-suspenders: never a click target
    this.syncDayNightSize();
    this.applyDayNight(this._gameHH != null ? this._gameHH : 12, this._gameMM || 0); // sensible default (noon) until the poll lands
    this.startClockPoll();
  }

  // Size the tint to the FULL world (plus a generous margin so a slight over-pan/letterbox never reveals an
  // un-tinted edge). Called on setup, on a world rebuild, AND after fitToContainer (camera bounds change on
  // resize/zoom). Sizes the tint to the CAMERA BOUNDS — the exact rect the camera can ever frame (set by
  // fitToContainer, incl. the HUD-clearance band + letterbox slack). The camera physically can't scroll/zoom
  // beyond its bounds, so a tint covering the bounds (+ a pad) blankets EVERY possible view — no un-tinted edge
  // at any zoom/pan. Falls back to world+margin when bounds aren't set yet (e.g. the headless engine-test).
  syncDayNightSize() {
    if (!this._dayNight || !this.world) return;
    const T = this.TILE, PAD = 2 * T;
    const cam = this.cameras && this.cameras.main;
    const b = cam && typeof cam.getBounds === "function" ? cam.getBounds() : null;
    if (b && b.width > 0 && b.height > 0) {
      this._dayNight.setPosition(b.x - PAD, b.y - PAD).setSize(b.width + 2 * PAD, b.height + 2 * PAD);
    } else {
      const M = 4 * T; // no camera bounds yet → cover the world + a generous margin
      this._dayNight.setPosition(-M, -M).setSize(this.world.width * T + 2 * M, this.world.height * T + 2 * M);
    }
  }

  // Poll the sim for the game clock and drive the tint. Also opportunistically used by occupancy's day sense.
  // Uses fetch (browser only); guarded so the headless engine-test (no fetch) simply never polls.
  startClockPoll() {
    if (typeof fetch !== "function" || typeof window === "undefined") return;
    const poll = async () => {
      try {
        const res = await fetch("/run-state");
        if (res.ok) {
          const rs = await res.json();
          const gc = rs && rs.gameClock;
          if (gc && typeof gc.hh === "number") { this._gameHH = gc.hh; this._gameMM = gc.mm || 0; this.applyDayNight(gc.hh, gc.mm || 0); }
        }
      } catch { /* sim momentarily unreachable → keep the current tint */ }
    };
    poll();
    this._clockTimer = setInterval(poll, 5000); // 5s is plenty — a 20-min day moves ~1 game-hour per 50s real
  }

  // 4-stop ramp → an interpolated {color, alpha}. Stops at local 0h (deep night), 6h (dawn), 12h (clear day),
  // 18h (dusk), wrapping 24→0. We lerp BOTH the RGB and the alpha between the two bracketing stops by the
  // fractional hour, so dawn/dusk glide rather than snap. Day alpha is ~0 (no tint); night is a cool, dim blue.
  applyDayNight(hh, mm) {
    if (!this._dayNight) return;
    const h = ((Number(hh) || 0) + (Number(mm) || 0) / 60) % 24;
    // [hour, 0xRRGGBB, alpha]
    const STOPS = [
      [0,  0x0a0e2a, 0.46], // midnight — deep cool blue
      [6,  0x4a2c4e, 0.26], // dawn — muted violet
      [12, 0x000000, 0.00], // noon — no tint
      [18, 0x6a2c12, 0.24], // dusk — warm amber-brown
      [24, 0x0a0e2a, 0.46], // wrap back to midnight
    ];
    let a = STOPS[0], b = STOPS[STOPS.length - 1];
    for (let i = 0; i < STOPS.length - 1; i++) { if (h >= STOPS[i][0] && h <= STOPS[i + 1][0]) { a = STOPS[i]; b = STOPS[i + 1]; break; } }
    const span = (b[0] - a[0]) || 1;
    const f = Math.max(0, Math.min(1, (h - a[0]) / span));
    const lerp = (x, y) => x + (y - x) * f;
    const ca = a[1], cb = b[1];
    const r = Math.round(lerp((ca >> 16) & 0xff, (cb >> 16) & 0xff));
    const g = Math.round(lerp((ca >> 8) & 0xff, (cb >> 8) & 0xff));
    const bl = Math.round(lerp(ca & 0xff, cb & 0xff));
    const alpha = lerp(a[2], b[2]);
    this._dayNight.setFillStyle((r << 16) | (g << 8) | bl, 1);
    this._dayNight.setAlpha(alpha);
  }

  // ---- A3-4: OCCUPANCY BADGES --------------------------------------------------------------------------
  // Above each building, a badge shows WHO is inside at a glance: a count + up to N small avatar coins in the
  // citizens' own colors. Computed CLIENT-SIDE each tick by intersecting live render positions with the building
  // footprints (window.__townWorld.buildings) — no sim change. Each building owns ONE reusable Container; we
  // update its contents in place and only rebuild the coin row when the occupant SET changes (diffed by a key),
  // so there's no per-frame allocation and nothing leaks. Throttled to ~the tick cadence (not every frame).
  setupOccupancy() {
    this._occBadges = new Map(); // building id -> { container, bg, countText, coins:[], key }
    this._occLastAt = 0;
  }

  // occupant set for a building: agents whose CENTER tile falls within the footprint. Cap the drawn coins so a
  // packed shop doesn't draw a mile of dots; the count is exact.
  refreshOccupancy(renderPos, now) {
    if (!this._occBadges || !this.world || !Array.isArray(this.world.buildings)) return;
    if (now - (this._occLastAt || 0) < 450) return; // throttle: ~tick cadence, not every frame
    this._occLastAt = now;
    const T = this.TILE;
    const MAX_COINS = 5;
    const inside = (b, p) => p && p.x + 0.5 >= b.x && p.x + 0.5 < b.x + b.w && p.y + 0.5 >= b.y && p.y + 0.5 < b.y + b.h;
    for (const b of this.world.buildings) {
      // collect occupants (id+color), stable order by id so the key + coin layout are deterministic
      const occ = [];
      for (const [id, vis] of this.agentSprites) {
        const p = renderPos[id]; if (inside(b, p)) occ.push({ id, color: vis.color || "#ff9100" });
      }
      occ.sort((m, n) => String(m.id).localeCompare(String(n.id)));
      const key = occ.map((o) => o.id).join(",");
      let badge = this._occBadges.get(b.id);
      if (occ.length === 0) {
        // empty → tear the badge down (don't leave a stale "0")
        if (badge) { badge.container.destroy(); this._occBadges.delete(b.id); }
        continue;
      }
      // position: centered over the building, just above its top edge (above the name label too)
      const cx = (b.x + b.w / 2) * T;
      const topY = b.y * T - T * 0.9;
      if (!badge) { badge = this.makeOccBadge(); this._occBadges.set(b.id, badge); }
      badge.container.setPosition(cx, topY).setDepth(99997); // just under the name label (99998), above all else
      if (badge.key !== key) { this.fillOccBadge(badge, occ, MAX_COINS); badge.key = key; }
    }
  }

  // Build the reusable container for one building's badge (a pill bg + a count text + a row of coin graphics).
  makeOccBadge() {
    const bg = this.add.graphics();
    const countText = this.add.text(0, 0, "", { fontFamily: "ui-monospace, monospace", fontSize: "10px", color: "#0b0b0a" }).setOrigin(0, 0.5);
    const container = this.add.container(0, 0, [bg, countText]).setDepth(99997);
    return { container, bg, countText, coins: [], key: null };
  }

  // (Re)draw a badge's contents for the current occupant set: "👥 N" + up to maxCoins colored dots, on a pill.
  fillOccBadge(badge, occ, maxCoins) {
    for (const c of badge.coins) c.destroy();
    badge.coins = [];
    const n = occ.length;
    const label = `👥 ${n}`;
    badge.countText.setText(label);
    const coinR = 4, coinGap = 11, padX = 7, padY = 4;
    const labelW = badge.countText.width;
    const drawn = Math.min(n, maxCoins);
    const coinsW = drawn > 0 ? (drawn * coinGap + 4) : 0;
    const totalW = padX * 2 + labelW + coinsW;
    const totalH = 18;
    // pill background, centered horizontally on the container origin
    badge.bg.clear();
    badge.bg.fillStyle(0x0b0b0a, 0.82); badge.bg.fillRoundedRect(-totalW / 2, -totalH / 2, totalW, totalH, 9);
    badge.bg.lineStyle(1, 0x2a2a2a, 1); badge.bg.strokeRoundedRect(-totalW / 2, -totalH / 2, totalW, totalH, 9);
    // count text on the left
    badge.countText.setPosition(-totalW / 2 + padX, 0);
    // coins after the label
    let x = -totalW / 2 + padX + labelW + 8;
    for (let i = 0; i < drawn; i++) {
      const g = this.add.graphics();
      const col = Phaser.Display.Color.HexStringToColor(occ[i].color || "#ff9100").color;
      g.fillStyle(0x0b0b0a, 1); g.fillCircle(x, 0, coinR + 1);
      g.fillStyle(col, 1); g.fillCircle(x, 0, coinR);
      badge.container.add(g); badge.coins.push(g);
      x += coinGap;
    }
    // "+k" if there are more occupants than coins drawn
    if (n > maxCoins) {
      const more = this.add.text(x - 2, 0, `+${n - maxCoins}`, { fontFamily: "ui-monospace, monospace", fontSize: "9px", color: "#9a9a93" }).setOrigin(0, 0.5);
      badge.container.add(more); badge.coins.push(more);
    }
  }

  // Frame the ENTIRE town inside the viewport — "contain"/letterbox, NOT "cover" — so NOTHING is ever clipped:
  // not the top stories under the #hud band, not the right-edge buildings, not the bottom. The whole map is on
  // screen at the baseline zoom; the wheel zooms IN from there (never out past the full-town frame). Re-run on
  // every resize. (Operator bar: zero cut-off anywhere.)
  fitToContainer() {
    if (!this.world) return;
    const cam = this.cameras.main;
    const T = this.TILE;
    const townW = this.world.width * T, townH = this.world.height * T;
    const vh = this.scale.gameSize.height || cam.height;
    const vw = this.scale.gameSize.width || cam.width;
    if (!vh || !vw) return;
    // Reserve a HUD-clearance band at the TOP so the top building row sits BELOW the absolute #hud overlay
    // (top-left). We fit the town PLUS this band, and a small foot band, into the viewport — so the binding axis
    // accounts for the reserved space and the whole town still fits. (Labels sit just above each facade, well
    // inside the town rect, so contain-fitting the town rect frames them too.)
    const HUD = 84;          // px of vertical headroom for the HUD band (screen-space, pre-zoom-independent)
    const PAD = 0.5 * T;     // a little breathing room on every side so nothing kisses the viewport edge
    // "Contain": the SMALLER ratio binds so BOTH axes fit (letterbox the looser one). Fit against the padded
    // extents — width gets PAD on both sides; height gets the HUD band on top + PAD on both sides.
    const z = Math.min((vw - 2 * PAD) / townW, (vh - HUD - 2 * PAD) / townH);
    this._baseZoom = z;
    this._targetZoom = z;
    cam.setZoom(z);
    // Build the VIRTUAL framed rect (world units) that should EXACTLY fill the viewport at this zoom: the town,
    // offset so it has a PAD margin on the left and a (HUD+PAD) margin on top (clearing the HUD). Its size is the
    // viewport mapped to world units (vw/z × vh/z); the leftover letterbox slack falls to the right/bottom — all
    // grass/off-map, never a clipped building. Set BOUNDS to this rect and centerOn its center: Phaser then shows
    // exactly it (clamp-safe — no manual scroll that the clamp would fight). Re-derived on every resize.
    const viewW = vw / z, viewH = vh / z;     // viewport in world units
    const originX = -PAD / z;                  // world x at the viewport's left edge
    const originY = -(HUD + PAD) / z;          // world y at the viewport's top edge (town pushed below the HUD)
    // PAN FIX (operator-flagged): the bounds USED to be EXACTLY this framed rect (originX,originY,viewW,viewH) ==
    // the viewport at base zoom → Phaser clamps scroll so the viewport stays inside bounds, leaving ZERO pan slack
    // → drag-pan / two-finger-pan did NOTHING at the default zoom (the bug). Fix: EXPAND the bounds by a generous
    // PAN MARGIN on every side so there's room to scroll around the framed town at any zoom. We still centerOn the
    // framed rect's center, so the whole town is framed on load exactly as before — but now the camera can move.
    const MARGIN = Math.max(viewW, viewH) * 1.0; // a FULL view of slack each side — generous, comfortable drag room
    cam.setBounds(originX - MARGIN, originY - MARGIN, viewW + 2 * MARGIN, viewH + 2 * MARGIN);
    cam.centerOn(originX + viewW / 2, originY + viewH / 2);
    // the day/night tint is sized to the camera BOUNDS — re-fit them here (resize) so it always blankets the frame.
    this.syncDayNightSize();
  }

  // ---- build the static town (ground + buildings) ----
  buildTown() {
    const T = this.TILE, w = this.world;
    // ensure the links layer exists (buildTown can be reached from create() OR a setWorld() that arrives first)
    if (!this.linkGfx) this.linkGfx = this.add.graphics().setDepth(5);
    // (camera BOUNDS are owned by fitToContainer() — it frames the whole town + HUD clearance. Don't reset the
    // bare town rect here: a setWorld()-driven rebuild would otherwise clobber that framing.)
    // ground: a grass base + sidewalk/street bands (depth 0). Destroy a prior ground on rebuild (sim restart
    // with the page open) so layers don't accumulate.
    if (this._ground) this._ground.destroy();
    if (this._groundTiles) this._groundTiles.removeAll(true);
    // LAYER depths govern inter-layer draw order (a Phaser Layer composites as a unit — per-child depths only
    // order WITHIN a layer). Ground sits at the bottom, buildings well above it; agents (loose, not layered)
    // depth-sort per-y in update() at depth ~1000+, so they pass in front of / behind buildings correctly.
    this._groundTiles = this.add.layer().setDepth(0);
    const g = this.add.graphics().setDepth(0);
    this._ground = g;
    // A ground band is rendered with REAL tiles when the active pack exposes groundTileKey() (LimeZu); else a
    // flat color fill (placeholder). `tileKey(kind)` returns a loaded texture key or null (additive + safe).
    const tileKey = (kind) => (typeof this.pack.groundTileKey === "function" ? this.pack.groundTileKey(this, kind) : null);
    const band = (kind, x, y, wpx, hpx) => {
      const key = tileKey(kind);
      if (key) {
        const ts = this.add.tileSprite(x, y, wpx, hpx, key).setOrigin(0, 0).setDepth(0);
        // LimeZu tiles are 16px; scale the tile so 1 source tile == 1 world tile (T px).
        ts.setTileScale(T / (this.pack.tileSize || 16), T / (this.pack.tileSize || 16));
        this._groundTiles.add(ts);
      } else {
        g.fillStyle(this.pack.groundFill(kind), 1);
        g.fillRect(x, y, wpx, hpx);
      }
    };
    band("grass", 0, 0, w.width * T, w.height * T);
    for (const r of (w.sidewalks?.rows || [])) band("sidewalk", 0, r * T, w.width * T, T);
    for (const r of (w.street?.rows || [])) band("street", 0, r * T, w.width * T, T);
    // street centre dashes per street band (only over a flat-fill road; real road tiles carry their own markings)
    if (!tileKey("street")) {
      g.lineStyle(2, 0xffb300, 0.8);
      for (const r of (w.street?.rows || [])) {
        const midY = r * T + T / 2;
        for (let x = 0; x < w.width * T; x += T * 0.9) { g.beginPath(); g.moveTo(x, midY); g.lineTo(x + T * 0.5, midY); g.strokePath(); }
      }
    }
    // optional vertical connector lanes (lanes.cols) — faint, so the bridge through the park reads
    if (w.lanes && Array.isArray(w.lanes.cols)) {
      for (const c of w.lanes.cols) band("sidewalk", c.x * T, c.y0 * T, T, (c.y1 - c.y0 + 1) * T);
    }

    // Buildings are LOOSE game objects (NOT in a Layer) so their per-y depth interleaves with the agents'
    // per-y depth → an agent in front of a building's bottom edge draws over it; behind it, under it (true
    // top-down occlusion). Depth = bottom-edge y; agents sit at the same y-scale (update() uses dy*T + a small
    // bias) so they sort correctly around buildings. Tracked in _buildingNodes for teardown on rebuild.
    if (this._buildingNodes) for (const n of this._buildingNodes) n.destroy();
    this._buildingNodes = [];
    const usingArt = typeof this.pack.groundTileKey === "function"; // a real-art pack (LimeZu) → label above facade
    for (const b of w.buildings) {
      const key = this.pack.buildingTextureKey(this, b);
      const px = b.x * T, py = b.y * T, pw = b.w * T, ph = b.h * T;
      const baseEdge = (b.y + b.h) * T; // the building's bottom edge — its "ground line"
      const baseDepth = baseEdge;
      let node;
      let artTop = py; // y of the rendered facade's TOP (for placing the label); refined below for real art
      if (key && this.textures.exists(key)) {
        // CONTAIN-fit the LimeZu facade inside its footprint box at NATURAL aspect (no stretch/distort): scale by
        // whichever axis binds (min), anchor BOTTOM-CENTER on the bottom edge, horizontally centered. This keeps
        // every facade WHOLE and proportioned and guarantees it never exceeds the footprint → no towers, no
        // overlap, no clip under the HUD. (The old setDisplaySize(pw,ph) stretched art to the box; the
        // width-only scale towered tall sprites — both are avoided here.)
        const src = this.textures.get(key).getSourceImage();
        const sw = src.width || pw, sh = src.height || ph;
        const scale = Math.min(pw / sw, ph / sh);
        const dispW = sw * scale, dispH = sh * scale;
        node = this.add.image(px + pw / 2, baseEdge, key).setOrigin(0.5, 1).setDisplaySize(dispW, dispH);
        artTop = baseEdge - dispH;
      } else {
        const r = this.add.graphics();
        r.fillStyle(Phaser.Display.Color.HexStringToColor(b.color || "#52607a").color, 1);
        r.fillRect(px, py, pw, ph); r.lineStyle(2, 0x000000, 0.45); r.strokeRect(px, py, pw, ph);
        node = r;
      }
      node.setDepth(baseDepth - 1);
      this._buildingNodes.push(node);
      // door marker (only for the placeholder look; real LimeZu facades already draw their own door)
      if (!usingArt) {
        const topB = b.y < (w.street.rows[0]);
        const edgeY = (topB ? b.y + b.h : b.y) * T;
        const door = this.add.graphics().setDepth(baseDepth - 1);
        door.fillStyle(0x0b0b0a, 1);
        door.fillRect(b.door.x * T + T * 0.15, edgeY - T * 0.3, T * 0.7, T * 0.6);
        this._buildingNodes.push(door);
      }
      // label: a small plate ABOVE a real facade (so it doesn't cover the art); centered for the placeholder.
      // For real art, anchor to the facade's ACTUAL top (artTop) so the name sits just above each building rather
      // than floating in empty grass when a contained facade is shorter than its footprint.
      const labelY = usingArt ? artTop - T * 0.35 : (b.y + b.h / 2) * T;
      const label = this.add.text((b.x + b.w / 2) * T, labelY, b.label, {
        fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.42)}px`, color: "#ffffff",
        stroke: "#0b0b0a", strokeThickness: usingArt ? 3 : 0,
      }).setOrigin(0.5).setAlpha(usingArt ? 0.95 : 0.92).setDepth(99998); // labels always readable on top
      this._buildingNodes.push(label);
    }
    // publish world for the inspector / control overlays
    if (typeof window !== "undefined") window.__townWorld = this.world;
    // keep the day/night tint covering the full (possibly resized) world after a rebuild
    this.syncDayNightSize();
  }

  spawnAgent(a) {
    const T = this.TILE;
    const key = this.pack.agentTextureKey(this, a);
    const st = this.agentState.get(a.id) || { tx: a.x, ty: a.y };
    const sprite = this.add.image(st.tx * T + T / 2, st.ty * T + T / 2, key);
    // A TALL sprite (LimeZu character, ~16x32) is anchored by its FEET near the tile center and scaled so it
    // reads at roughly 1.6 tiles tall; a SQUARE sprite (placeholder coin) stays centered at native size.
    const tex = this.textures.exists(key) ? this.textures.get(key).getSourceImage() : null;
    const tall = tex && tex.height > tex.width * 1.4;
    if (tall) {
      sprite.setOrigin(0.5, 0.82);
      sprite.setDisplaySize(tex.width * (T * 1.6 / tex.height), T * 1.6); // preserve aspect, ~1.6 tiles tall
    } else {
      sprite.setOrigin(0.5);
    }
    sprite._tall = !!tall;
    const ring = this.add.graphics(); // moving indicator
    const label = this.add.text(st.tx * T + T / 2, st.ty * T + T / 2 - T * 0.62, a.id, {
      fontFamily: "ui-monospace, monospace", fontSize: `${Math.floor(T * 0.4)}px`, color: "#fafaf5",
    }).setOrigin(0.5);
    sprite.setInteractive({ useHandCursor: true });
    sprite.on("pointerdown", () => { this.follow = (this.follow === a.id) ? null : a.id; if (this.follow) this.cameras.main.startFollow(sprite, true, 0.08, 0.08); else this.cameras.main.stopFollow(); });
    // a key starting "placeholder:" means the pack fell back (its real art wasn't available yet) — flag it so
    // maybeUpgradeSprite() can swap in the real texture once it loads.
    const usedFallback = typeof key === "string" && key.startsWith("placeholder:");
    this.agentSprites.set(a.id, { sprite, ring, label, color: a.color, usedFallback });
  }

  // ---- per-frame: ease positions, fan co-located, depth-sort, draw links + bubbles, publish inspector data ----
  update() {
    if (!this.world) return;
    const T = this.TILE;
    // 0) ease the camera zoom toward the wheel's target (smooth, gentle)
    if (this._targetZoom != null) {
      const cam = this.cameras.main;
      if (Math.abs(cam.zoom - this._targetZoom) > 0.001) cam.setZoom(cam.zoom + (this._targetZoom - cam.zoom) * 0.18);
    }
    // 1) ease toward tile targets
    for (const [, st] of this.agentState) { st.tx += (st.x - st.tx) * EASE; st.ty += (st.y - st.ty) * EASE; }
    // 2) fan offsets for crowded tiles (deterministic, matches old renderer)
    const fan = this.computeFan();
    // 3) place sprites + depth, publish positions
    const renderPos = {}, drawPos = {};
    for (const [id, vis] of this.agentSprites) {
      const st = this.agentState.get(id); if (!st) continue;
      const o = fan[id] || { dx: 0, dy: 0 };
      const dx = st.tx + o.dx, dy = st.ty + o.dy;
      renderPos[id] = { x: st.tx, y: st.ty };
      drawPos[id] = { x: dx, y: dy };
      const cx = dx * T + T / 2, cy = dy * T + T / 2;
      // Depth in the SAME y-scale as buildings (depth = bottom-edge y): use the agent's FEET row + a tiny bias
      // so it sorts AROUND buildings (behind ones whose bottom is lower on screen, in front of higher ones).
      const feetDepth = (dy + 1) * T + 2;
      vis.sprite.setPosition(cx, cy).setDepth(feetDepth);
      // a tall (character) sprite rises ~1.45 tiles above the tile center; float the name + bubble above its head.
      const headY = vis.sprite._tall ? cy - T * 1.5 : cy - T * 0.62;
      vis.label.setPosition(cx, headY).setDepth(99999); // names always readable above everything
      if (vis.color && vis.color !== st._lastColor) { st._lastColor = vis.color; } // (color is baked into the texture key)
      // moving ring (at the feet)
      vis.ring.clear().setDepth(feetDepth - 1);
      if (st.moving) { vis.ring.lineStyle(1.5, 0xfafaf5, 0.35); vis.ring.strokeEllipse(cx, cy + T * 0.35, T * 0.7, T * 0.4); }
      // bubble follows (above the head)
      const bub = this.bubbles.get(id);
      if (bub) bub.container.setPosition(cx, headY - T * 0.5).setDepth(dy * T + 2000);
    }
    if (typeof window !== "undefined") { window.__townRenderPos = renderPos; window.__townDrawPos = drawPos; }
    // 4) adjacency links
    this.linkGfx.clear();
    this.linkGfx.lineStyle(2, 0x6ee7b7, 0.55);
    const seen = new Set();
    for (const [id, st] of this.agentState) {
      for (const oid of st.adjacentTo || []) {
        const k = [id, oid].sort().join("|"); if (seen.has(k)) continue; seen.add(k);
        const a = drawPos[id], b = drawPos[oid]; if (!a || !b) continue;
        this.linkGfx.beginPath(); this.linkGfx.moveTo(a.x * T + T / 2, a.y * T + T / 2); this.linkGfx.lineTo(b.x * T + T / 2, b.y * T + T / 2); this.linkGfx.strokePath();
      }
    }
    // 5) expire bubbles
    const now = this.time.now;
    for (const [id, b] of this.bubbles) if (now > b.expires) { b.container.destroy(); this.bubbles.delete(id); }
    // 6) (day/night tint is a WORLD-space rect sized once to the world in syncDayNightSize() — no per-frame work)
    // 7) refresh occupancy badges (throttled — positions are known now via renderPos)
    this.refreshOccupancy(renderPos, now);
  }

  computeFan() {
    const groups = new Map();
    for (const [id, st] of this.agentState) {
      if (!this.agentSprites.has(id)) continue;
      const key = Math.round(st.tx) + "," + Math.round(st.ty);
      let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push(id);
    }
    const out = {};
    for (const g of groups.values()) {
      if (g.length < 2) { out[g[0]] = { dx: 0, dy: 0 }; continue; }
      g.sort((m, n) => String(m).localeCompare(String(n)));
      for (let i = 0; i < g.length; i++) { const ang = (i / g.length) * Math.PI * 2; out[g[i]] = { dx: Math.cos(ang) * FAN_RADIUS, dy: Math.sin(ang) * FAN_RADIUS }; }
    }
    return out;
  }

  // Draw/replace a speech bubble over an agent. `ms` overrides the default linger (dialogue turns + status
  // use shorter lifetimes than a one-shot say so a replay reads as a sequence, not a pile-up). A wider cap
  // (54 chars) keeps a full conversational turn legible while still wrapping nothing.
  showBubble(id, text, ms) {
    if (!this.agentSprites.has(id)) return;
    const old = this.bubbles.get(id); if (old) old.container.destroy();
    const t = text.length > 54 ? text.slice(0, 52) + "…" : text;
    const txt = this.add.text(0, 0, t, { fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#0b0b0a" }).setOrigin(0.5);
    const pad = 6, w = txt.width + pad * 2, h = txt.height + pad;
    const bg = this.add.graphics();
    bg.fillStyle(0xfafaf5, 0.96); bg.fillRoundedRect(-w / 2, -h / 2, w, h, 5);
    const container = this.add.container(0, 0, [bg, txt]).setDepth(99999);
    this.bubbles.set(id, { container, expires: this.time.now + (ms || BUBBLE_MS) });
  }

  // ---- camera: smooth drag-pan + gentle eased wheel-zoom (read-only friendly) ----
  setupCameraControls() {
    const cam = this.cameras.main;
    cam.setZoom(1);
    this._targetZoom = 1;          // wheel sets this; update() eases cam.zoom toward it
    this._dragging = false;
    this._dragLast = { x: 0, y: 0 }; // our own last-pointer (Phaser's prevPosition is per-frame + jumpy)

    // DRAG-TO-PAN: track the pointer ourselves so the delta is exact (no snapping/teleport). Start the drag on
    // pointerdown (record the anchor), move the camera by the precise screen-delta / zoom on each move, end on up.
    this.input.on("pointerdown", (p) => {
      if (this.follow) return;     // following a citizen → ignore drag (Esc/click releases follow)
      this._dragging = true;
      this._dragLast.x = p.x; this._dragLast.y = p.y;
    });
    this.input.on("pointermove", (p) => {
      if (!this._dragging || !p.isDown) return;
      cam.scrollX -= (p.x - this._dragLast.x) / cam.zoom;
      cam.scrollY -= (p.y - this._dragLast.y) / cam.zoom;
      this._dragLast.x = p.x; this._dragLast.y = p.y;
    });
    const endDrag = () => { this._dragging = false; };
    this.input.on("pointerup", endDrag);
    this.input.on("pointerupoutside", endDrag);
    this.input.on("gameout", endDrag);

    // TRACKPAD-AWARE WHEEL. On a Mac trackpad a plain two-finger swipe fires a wheel event with deltaX/deltaY and
    // ctrlKey=FALSE, while a pinch-zoom fires wheel with ctrlKey=TRUE. So:
    //   • pinch (ctrlKey)        → ZOOM  (gentle eased target; update() eases cam.zoom toward it)
    //   • plain two-finger swipe → PAN   (move the camera by the scroll delta, like drag-pan)
    // A classic mouse wheel (no ctrlKey, deltaX≈0, vertical only) still PANS vertically — but most users on this
    // Mac demo are on the trackpad, and pinch covers their zoom. (dy<0 = scroll up = zoom in, for pinch.)
    this.input.on("wheel", (_p, _o, dx, dy, _dz, ev) => {
      // The raw WheelEvent carries ctrlKey (Phaser doesn't surface it directly). It's on pointer.event (always
      // set by Phaser on an input event); the InputPlugin may also pass it as the last arg on some builds.
      const native = (_p && _p.event) || ev;
      const pinch = !!(native && native.ctrlKey);
      if (pinch) {
        const step = dy < 0 ? 1.06 : 1 / 1.06;           // ~6% per tick
        this._targetZoom = clampZoom(this._targetZoom * step);
        if (native.preventDefault) native.preventDefault(); // stop the browser's page-zoom on pinch
      } else if (!this.follow) {
        // PAN: trackpad scroll deltas are in screen px; divide by zoom so the pan tracks 1:1 with the cursor.
        cam.scrollX += dx / cam.zoom;
        cam.scrollY += dy / cam.zoom;
      }
    });
    this.input.keyboard?.on("keydown-ESC", () => { this.follow = null; cam.stopFollow(); });
  }

  // Nudge the eased zoom target by a factor (used by the +/− on-screen buttons AND reused by the pinch path's
  // clamp). update() eases cam.zoom toward _targetZoom, so a button press animates SMOOTHLY (no jump). Clamped to
  // the whole-town fit baseline floor (never zoom out past the full-town frame) up to 3× (read detail).
  zoomBy(factor) {
    this._targetZoom = clampZoom((this._targetZoom || this._baseZoom || 1) * factor, this._baseZoom);
    return this._targetZoom;
  }
}

// Clamp a zoom to [base, base*3]. `base` defaults to 1 if the fit hasn't run yet. Module-scope so the wheel
// handler + zoomBy share ONE definition (the W3 "never zoom out past the full-town frame" invariant).
function clampZoom(z, base) {
  const b = base || 1;
  return Phaser.Math.Clamp(z, b, b * 3);
}
