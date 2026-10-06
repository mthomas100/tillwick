// renderer/phaser/assets.js — the SWAPPABLE ART INTERFACE (art-agnostic engine, per docs/design/architecture.md §6).
//
// The Phaser scene (town-scene.js) NEVER references a specific art set. It asks the ACTIVE asset pack for
// textures by semantic role ("a building of type shop", "an agent sprite", "the ground tile for a street").
// Packs:
//   - "placeholder" (DEFAULT, committable, ZERO external art): textures generated at runtime from Phaser
//     Graphics (colored rounded rects for buildings, a coin sprite for agents). Renders immediately, offline.
//   - "limezu"      (operator-bought LimeZu Modern Interiors/Exteriors; raw art stays OUT of the repo):
//     loads a tileset/atlas + character frames from renderer/phaser/assets/limezu/* — wired by W3-map/W3-sprites.
//   - "ninja"       (CC0 Ninja Adventure fallback): same shape, from assets/ninja/*.
// Switch packs with NO engine change via ?art=limezu|ninja|placeholder (default placeholder). Missing pack art
// degrades to placeholder per-texture, so a half-installed pack still renders.
//
// CONTRACT each pack implements:
//   key, label
//   preload(scene)                       -> queue this.load.* for whatever the pack needs (placeholder: none)
//   ready(scene)                         -> after load: generate/prepare textures (placeholder makes them here)
//   groundFill(kind) -> 0xRRGGBB         -> flat color for a ground tile kind ("grass"|"street"|"sidewalk")
//   buildingTextureKey(scene, building)  -> a Phaser texture key to render this building (by type/color); may
//                                           lazily generate the texture on first use; returns null to fall back
//                                           to a drawn rect (so a pack can opt out of any building)
//   agentTextureKey(scene, agent)        -> a Phaser texture key for this agent's sprite (by color/id)
//   tileSize                             -> source tile px the pack's art assumes (for scaling); informational
//
// All keys are namespaced `pack:` so two packs never collide in the Phaser TextureManager.

/** Build a rounded-rect building texture once per (pack,color,w,h) and cache the key. */
function genBuildingTexture(scene, ns, color, wTiles, hTiles, tile) {
  const key = `${ns}:bld:${color}:${wTiles}x${hTiles}`;
  if (scene.textures.exists(key)) return key;
  const W = Math.max(1, Math.round(wTiles * tile));
  const H = Math.max(1, Math.round(hTiles * tile));
  const g = scene.add.graphics();
  const c = Phaser.Display.Color.HexStringToColor(color).color;
  // body
  g.fillStyle(c, 1);
  g.fillRoundedRect(0, 0, W, H, Math.min(10, tile * 0.35));
  // subtle top highlight + bottom shade for a touch of depth (pure placeholder flavor)
  g.fillStyle(0xffffff, 0.08); g.fillRoundedRect(0, 0, W, Math.max(2, H * 0.18), 6);
  g.fillStyle(0x000000, 0.18); g.fillRect(0, H - Math.max(2, H * 0.12), W, Math.max(2, H * 0.12));
  // border
  g.lineStyle(2, 0x000000, 0.45);
  g.strokeRoundedRect(1, 1, W - 2, H - 2, Math.min(10, tile * 0.35));
  g.generateTexture(key, W, H);
  g.destroy();
  return key;
}

/** Build a circular "citizen coin" texture once per (pack,color) and cache the key. */
function genAgentTexture(scene, ns, color, tile) {
  const key = `${ns}:agent:${color}`;
  if (scene.textures.exists(key)) return key;
  const R = Math.round(tile * 0.36);
  const S = R * 2 + 6;
  const g = scene.add.graphics();
  const c = Phaser.Display.Color.HexStringToColor(color).color;
  g.fillStyle(0x000000, 0.35); g.fillCircle(S / 2, S / 2 + 1, R + 1); // soft shadow ring
  g.fillStyle(c, 1); g.fillCircle(S / 2, S / 2, R);
  g.lineStyle(2, 0x0b0b0a, 1); g.strokeCircle(S / 2, S / 2, R);
  g.fillStyle(0xffffff, 0.25); g.fillCircle(S / 2 - R * 0.3, S / 2 - R * 0.3, R * 0.35); // glint
  g.generateTexture(key, S, S);
  g.destroy();
  return key;
}

// ---- the placeholder pack: fully self-contained, no external files ----
const placeholderPack = {
  key: "placeholder",
  label: "Placeholder (generated)",
  tileSize: 28,
  preload() {/* nothing to load — textures are generated in ready()/lazily */},
  ready() {/* building + agent textures are generated lazily on first use (color-dependent) */},
  groundFill(kind) {
    return kind === "street" ? 0x1c1c1e : kind === "sidewalk" ? 0x3a3a36 : 0x14241a; // grass default
  },
  buildingTextureKey(scene, b) {
    return genBuildingTexture(scene, "placeholder", b.color || "#52607a", b.w, b.h, scene.TILE);
  },
  agentTextureKey(scene, a) {
    return genAgentTexture(scene, "placeholder", a.color || "#ff9100", scene.TILE);
  },
};

// ---- external packs (LimeZu / Ninja Adventure): same interface, art loaded from local folders ----
// These are intentionally thin: they declare WHERE their art lives and fall back to generated placeholder
// textures for anything not yet present, so the engine + scene need zero changes when the art lands.
function makeFolderPack(key, label, dir, tileSize) {
  return {
    key, label, tileSize,
    _loaded: false,
    preload(scene) {
      // W3-map / W3-sprites will author these. Guard each with a check so a missing pack doesn't 404-spam:
      // we register the paths; Phaser's loader emits a 'loaderror' we listen for to mark assets unavailable.
      this._dir = `phaser/assets/${dir}`;
      // Example expected assets (authored later): a tileset image + a character atlas.
      // scene.load.image(`${key}:tiles`, `${this._dir}/tileset.png`);
      // scene.load.atlas(`${key}:chars`, `${this._dir}/characters.png`, `${this._dir}/characters.json`);
      // Left commented until the art exists so the placeholder path stays clean + zero-404 today.
    },
    ready() { this._loaded = true; },
    groundFill(kind) { return placeholderPack.groundFill(kind); }, // until a tileset is wired
    buildingTextureKey(scene, b) {
      // Prefer pack art if present, else placeholder.
      const k = `${key}:bld:${b.type}`;
      if (scene.textures.exists(k)) return k;
      return placeholderPack.buildingTextureKey(scene, b);
    },
    agentTextureKey(scene, a) {
      const k = `${key}:char:${a.id}`;
      if (scene.textures.exists(k)) return k;
      return placeholderPack.agentTextureKey(scene, a);
    },
  };
}

// ---- the LimeZu pack: REAL Modern Exteriors art, loaded from renderer/phaser/assets/limezu/* ----
// (art is gitignored/proprietary — operator-supplied; the cropped files are: ground/{grass,road,pavement}.png,
// buildings/{shop,shop2,home,civic}.png, characters/{baker,barista,grocer,courier,smith}.png — all 16px-grid.)
// Buildings + agents render via real texture keys (zero scene change). Ground renders via the optional
// groundTileKey() hook the scene tiles when present (additive; placeholder pack omits it → flat color).
const limezuPack = (() => {
  const dir = "phaser/assets/limezu";
  const GROUND = ["grass", "road", "pavement"];
  // Per-ID facades (file under buildings/<id>.png):
  //  - civic (college/pub/townhall): WIDE buildings (school ~1.04, victorian ~1.12) that fill their wide-short
  //    footprints, vs the tall-thin generic civic.png (1:3) that contain-fit to a sliver.
  //  - shop (cafe/grocer/depot/bakery/smithy): each a SINGLE clean storefront (LimeZu Market_Medium, 112x144),
  //    vs the old shop/shop2 crops which were 1.3 storefronts wide → read as "1.5 buildings". Per-id also
  //    differentiates the 5 shops (different wall colors/awnings).
  // The generic shop/shop2/home/civic images stay as the fallback for any id not listed (additive + safe).
  const BUILDINGS = ["shop", "shop2", "home", "civic", "college", "pub", "townhall",
    "cafe", "grocer", "depot", "bakery", "smithy"];
  // 5 merchants + the 3 non-merchant townsfolk (S1-4): each is a distinct LimeZu premade character (the
  // down-idle 16x32 frame), so student/musician/regular render as PEOPLE, not the placeholder coin/circle.
  const CHARS = ["baker", "barista", "grocer", "courier", "smith", "student", "musician", "regular"];
  // building ID → its own facade image. A shop id not listed falls back to the shop/shop2 alternation; a civic
  // id not listed falls back to the generic "civic" image.
  const CIVIC_BY_ID = { college: "college", pub: "pub", townhall: "townhall" };
  const SHOP_BY_ID = { cafe: "cafe", grocer: "grocer", depot: "depot", bakery: "bakery", smithy: "smithy" };
  const failed = new Set(); // keys whose file 404'd → fall back per-texture
  // LimeZu ground KIND → which ground image (the scene asks for grass/street/sidewalk).
  const groundImageFor = (kind) => (kind === "street" ? "road" : kind === "sidewalk" ? "pavement" : "grass");
  // building → facade image. Prefer a per-id facade (single clean storefront / wide civic); else fall back by
  // TYPE (shops alternate shop/shop2 for variety keyed by id so it's stable; homes → home; civic → civic).
  const buildingImageFor = (b) => {
    if (b.type === "shop") return SHOP_BY_ID[b.id] || (hashStr(b.id) % 2 === 0 ? "shop" : "shop2");
    if (b.type === "home") return "home";
    return CIVIC_BY_ID[b.id] || "civic";
  };
  function hashStr(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return Math.abs(h); }

  // ---- INTERIOR art (B3): named furniture/floor/wall pieces sliced from _limezu-src/1_Interiors/ ----
  // The interior scene (scenewright B2) requests a piece by SEMANTIC NAME; we map name → a `limezu:int:*`
  // texture key, or fall back per-piece (floors/walls → a generated flat tile; objects → null so B2 draws a
  // placeholder rect). Crops live under assets/limezu/interiors/{floors,walls,objects}/ (gitignored;
  // regen via scripts/crop-interiors.sh). Mirrors the exterior `failed`-Set degrade — a half-cropped pack
  // still renders. Names align to B1's `interior.theme` + `sublocation.kind` enums (sim/interiors.ts).
  const INT_FLOORS = ["wood", "wood-dark", "tile", "stone", "carpet"];
  const INT_WALLS = ["plaster", "wood", "brick", "tile"];
  // the object crops actually produced by crop-interiors.sh (one PNG each under interiors/objects/):
  const INT_OBJECTS = [
    "counter", "counter-3", "stove", "oven", "sink", "table", "table-wide", "table-dark", "chair",
    "display-case", "fridge", "fridge-open", "espresso", "coffee-maker", "range-hood",
    "shelf", "produce", "cooler", "freezer",
    "desk", "lectern", "chalkboard", "blackboard", "bookshelf", "globe",
    "bed", "bunk-bed", "wardrobe",
    "tv", "sofa", "sofa-long", "cabinet", "plant", "plant-tall",
    "piano", "amp", "guitar", "guitar-electric", "mic", "harp",
    "forge", "anvil",
  ];
  // ALIAS: a requested name (B1's raw `kind`, or a world.json object id) → the crop that paints it. So
  // scenewright can pass `sublocation.kind` ("counter"|"table"|"desk"|"stage"|"bed"|"shelf"|"appliance"|
  // "register"|"seat") straight through, OR a specific id (espresso-machine, oven, bar-counter, lectern…).
  const INT_ALIAS = {
    // B1 kinds → a sensible default crop
    appliance: "stove", register: "counter", seat: "chair", stage: "mic",
    // table/seat specifics
    "table-2chairs": "table-wide", "table-4chairs": "table-dark", "dining-table": "table-dark",
    stool: "chair",
    // appliance specifics (world.json object ids)
    "espresso-machine": "espresso", "coffee-urn": "coffee-maker", roaster: "coffee-maker",
    "home-baker-stove": "stove", "home-barista-stove": "stove", "home-grocer-stove": "stove",
    "home-courier-stove": "stove", "home-smith-stove": "stove", "coliving-stove": "stove",
    "market-cooler": "cooler", "dorm-kitchenette": "counter",
    // counters
    "bar-counter": "counter-3", "cafe-counter": "counter", "bakery-counter": "counter",
    "smithy-counter": "counter", "supply-counter": "counter-3", "pharmacy-counter": "counter",
    "cafe-register": "counter", "grocer-register": "counter", "bakery-register": "counter",
    "supply-register": "counter", "smithy-register": "counter",
    // shelves / displays
    "grocery-shelves": "shelf", "produce-stand": "produce", "bakery-display": "display-case",
    "tool-wall": "shelf", "cafe-bean-shelf": "shelf", "hardware-bins": "shelf",
    "market-crates": "produce", "supply-crate": "produce",
    "cafe-roaster": "coffee-maker", "flour-sacks": "produce", "dough-table": "table-dark",
    // multi-seat furniture (the plural ids B1 may reuse) — render as a single representative piece
    "cafe-tables": "table-wide", "lecture-chairs": "chair", "council-chairs": "chair",
    "pub-tables": "table-wide", "lecture-seats": "chair",
    // desks / boards
    "townhall-desk": "desk", "council-table": "table-dark", "town-notice": "chalkboard", "dorm-desks": "desk",
    // a lecture podium reads as a lectern, NOT a mic (B1's college spot is kind:"stage" id:"lectern"; alias the
    // generic "podium" too so a college board/podium never falls to a placeholder rect); board synonyms.
    podium: "lectern", whiteboard: "chalkboard", board: "chalkboard", "class-board": "chalkboard",
    // B1 INSTANCE-id BASES (the renderer strips a trailing -<n>, so cafe-table-1/2 → cafe-table → table, etc.).
    // These cover the NEW sublocation ids B1 ships beyond the rooms[] objects.
    "cafe-table": "table-wide", "pub-table": "table-wide", "study-desk": "desk", "coliving-bed": "bed",
    "lecture-desk": "desk", "dorm-bed": "bed", "home-bed": "bed", "bar-table": "table-wide",
    // sofas / tv / lounge
    "college-sofa": "sofa", "dorm-sofa": "sofa-long", "coliving-sofa": "sofa-long",
    "dorm-tv": "tv", "coliving-tv": "tv", fireplace: "stove",
    // beds
    "dorm-beds": "bunk-bed", "home-baker-bed": "bed", "home-barista-bed": "bed",
    "home-grocer-bed": "bed", "home-courier-bed": "bed", "home-smith-bed": "bed",
    // HOME / dorm / coliving furniture (each home reuses its own prefixed object ids) → shared crops.
    // tables → dining-table art; desks → desk; fridges → fridge; wardrobes → wardrobe.
    "home-baker-table": "table-dark", "home-barista-table": "table-dark", "home-grocer-table": "table-dark",
    "home-courier-table": "table-dark", "home-smith-table": "table-dark", "coliving-table": "table-dark",
    "home-baker-desk": "desk", "home-barista-desk": "desk", "home-grocer-desk": "desk",
    "home-courier-desk": "desk", "home-smith-desk": "desk",
    "home-baker-fridge": "fridge", "home-barista-fridge": "fridge", "home-grocer-fridge": "fridge",
    "home-courier-fridge": "fridge", "home-smith-fridge": "fridge", "coliving-fridge": "fridge",
    "home-baker-wardrobe": "wardrobe", "home-barista-wardrobe": "wardrobe", "home-grocer-wardrobe": "wardrobe",
    "home-courier-wardrobe": "wardrobe", "home-smith-wardrobe": "wardrobe",
    // smithy stand-ins
    forge: "forge", anvil: "anvil", workbench: "table-dark", "quench-tub": "sink",
    // music / busking — `pub-stage` is B1's busking-spot id (kind:"stage"); the mic stand is the busking focal.
    "pub-stage": "mic", "beer-taps": "counter", "bar-stools": "chair", dartboard: "globe",
    // rug → reuse the warm carpet FLOOR texture (the bedroom rug crops are near-transparent)
    rug: "@floor:carpet",
  };
  const intKeyExists = (scene, k) => scene.textures.exists(k) && !failed.has(k);
  // Generated flat-color fallback tile for a floor/wall when its crop is missing (so the scene always tiles).
  function genIntTile(scene, kind, color) {
    const key = `limezu:int:gen:${kind}`;
    if (scene.textures.exists(key)) return key;
    const g = scene.add.graphics();
    g.fillStyle(color, 1); g.fillRect(0, 0, 48, 48);
    g.fillStyle(0x000000, 0.06); g.fillRect(0, 0, 48, 2); g.fillRect(0, 0, 2, 48); // faint seam
    g.generateTexture(key, 48, 48); g.destroy();
    return key;
  }
  const INT_FLOOR_FILL = { wood: 0x9c7048, "wood-dark": 0x6e4a2c, tile: 0xd8d0c0, stone: 0x8a9088, carpet: 0xcdb86a };
  const INT_WALL_FILL = { plaster: 0xe6e4e8, wood: 0x8a6a44, brick: 0xa85650, tile: 0x9aa0a6 };

  return {
    key: "limezu", label: "LimeZu Modern Exteriors (operator-bought)", tileSize: 16,
    tileSizeInterior: 48, // interior crops are on a 48px grid (the source resolution)
    preload(scene) {
      scene.load.on("loaderror", (file) => { if (file && file.key) failed.add(file.key); });
      for (const g of GROUND) scene.load.image(`limezu:ground:${g}`, `${dir}/ground/${g}.png`);
      for (const b of BUILDINGS) scene.load.image(`limezu:bld:${b}`, `${dir}/buildings/${b}.png`);
      for (const c of CHARS) scene.load.image(`limezu:char:${c}`, `${dir}/characters/${c}.png`);
      // INTERIOR pieces (B3) — guarded by the same loaderror→failed listener; a missing crop degrades per-key.
      for (const f of INT_FLOORS) scene.load.image(`limezu:int:floor:${f}`, `${dir}/interiors/floors/${f}.png`);
      for (const w of INT_WALLS) scene.load.image(`limezu:int:wall:${w}`, `${dir}/interiors/walls/${w}.png`);
      for (const o of INT_OBJECTS) scene.load.image(`limezu:int:obj:${o}`, `${dir}/interiors/objects/${o}.png`);
    },
    ready() { /* textures are loaded by the Phaser loader; nothing to generate */ },
    // LimeZu-palette ground colors (sampled from the tiles) — the fallback when groundTileKey is unused/missing.
    groundFill(kind) { return kind === "street" ? 0x4a4a4e : kind === "sidewalk" ? 0x9a958a : 0x4f7a43; },
    // Optional (the scene tiles this when present): the real ground TILE texture for a kind, or null to flat-fill.
    groundTileKey(scene, kind) {
      const k = `limezu:ground:${groundImageFor(kind)}`;
      return scene.textures.exists(k) && !failed.has(k) ? k : null;
    },
    buildingTextureKey(scene, b) {
      const k = `limezu:bld:${buildingImageFor(b)}`;
      if (scene.textures.exists(k) && !failed.has(k)) return k;
      return placeholderPack.buildingTextureKey(scene, b); // per-building fallback
    },
    agentTextureKey(scene, a) {
      const k = `limezu:char:${a.id}`;
      if (scene.textures.exists(k) && !failed.has(k)) return k;
      return placeholderPack.agentTextureKey(scene, a);
    },

    // ---- INTERIOR getters (B3 — consumed by the B2 interior scene) ----
    // FLOOR: a full 48px tileable floor texture for `kind` (interior.floor). Always returns a key (crop, or a
    // generated flat tile). kind ∈ wood|wood-dark|tile|stone|carpet (unknown → wood).
    interiorFloor(scene, kind) {
      const f = INT_FLOORS.includes(kind) ? kind : "wood";
      const k = `limezu:int:floor:${f}`;
      return intKeyExists(scene, k) ? k : genIntTile(scene, `floor:${f}`, INT_FLOOR_FILL[f] || 0x9c7048);
    },
    // WALL: a 48px wall/boundary tile for `variant`. Always returns a key. variant ∈ plaster|wood|brick|tile
    // (unknown → plaster).
    interiorWall(scene, variant) {
      const w = INT_WALLS.includes(variant) ? variant : "plaster";
      const k = `limezu:int:wall:${w}`;
      return intKeyExists(scene, k) ? k : genIntTile(scene, `wall:${w}`, INT_WALL_FILL[w] || 0xe6e4e8);
    },
    // OBJECT: a furniture/fixture texture key for a semantic `name` (a B1 `kind`, a world.json object id, or a
    // specific piece name). Resolves aliases, then returns the crop key — or NULL when there's no art for it
    // (B2 then draws its own placeholder rect). Never throws. `@floor:<k>` aliases reuse a floor texture (rug).
    interiorObject(scene, name) {
      if (!name) return null;
      // resolve a single raw name through the alias chain → either a crop key, "@floor:*", or null.
      const resolve = (raw) => {
        let n = String(raw);
        const seen = new Set();
        while (INT_ALIAS[n] && !seen.has(n)) { seen.add(n); n = INT_ALIAS[n]; }
        if (n.startsWith("@floor:")) return this.interiorFloor(scene, n.slice(7)); // e.g. rug → carpet floor
        const k = `limezu:int:obj:${n}`;
        return intKeyExists(scene, k) ? k : null;
      };
      const hit = resolve(name);
      if (hit) return hit;
      // B1 ships INSTANCE ids = base + a numeric suffix (cafe-table-1, study-desk-2, pub-table-1…). If the raw
      // id didn't resolve, strip a trailing "-<n>" and retry the BASE through aliases — so any count of a spot
      // paints the same furniture. (Only a trailing -digits; ids like home-baker-bed / pub-stage are untouched.)
      const base = String(name).replace(/-\d+$/, "");
      if (base !== String(name)) return resolve(base);
      return null; // unknown/missing → null (caller draws a placeholder)
    },
    // CONVENIENCE for B2 (scenewright's proposed shape): take a whole B1 sub-location and pick its furniture
    // texture. Prefers the specific object `id` (→ richer art, e.g. espresso-machine vs a generic stove), then
    // falls back to the `kind`. Same null-on-unknown contract as interiorObject. So B2 can call
    // `pack.furnitureTextureKey(scene, subLoc)` directly with the B1 record.
    furnitureTextureKey(scene, subLoc) {
      if (!subLoc) return null;
      return this.interiorObject(scene, subLoc.id) || this.interiorObject(scene, subLoc.kind);
    },
    // Introspection for B2 / tests: the frozen lists of available semantic names.
    interiorNames() { return { floors: [...INT_FLOORS], walls: [...INT_WALLS], objects: [...INT_OBJECTS], aliases: Object.keys(INT_ALIAS) }; },
  };
})();

const PACKS = {
  placeholder: placeholderPack,
  limezu: limezuPack,
  ninja: makeFolderPack("ninja", "Ninja Adventure (CC0)", "ninja", 16),
};

/** Resolve the active pack from ?art= (default placeholder); unknown name → placeholder. */
function resolveAssetPack(search) {
  let name = "placeholder";
  try {
    const q = new URLSearchParams(search || (typeof location !== "undefined" ? location.search : ""));
    name = q.get("art") || name;
  } catch { /* no URL context (tests) → placeholder */ }
  return PACKS[name] || PACKS.placeholder;
}

export { PACKS, resolveAssetPack, genBuildingTexture, genAgentTexture };
