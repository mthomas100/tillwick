# renderer/phaser/assets/ — swappable art packs

The Phaser engine (`../town-scene.js`) is **art-agnostic**. It asks the active asset pack (`../assets.js`) for
textures by semantic role; it never references a specific art set. Pick a pack at runtime with `?art=`:

- `?art=placeholder` (default) — textures generated at runtime from Phaser Graphics. **Zero external art**, in repo.
- `?art=limezu` — loads from `limezu/` (operator-bought **LimeZu Modern Interiors/Exteriors**). Raw LimeZu art is
  **proprietary → kept OUT of the repo**; the operator drops it in locally. Authored by **W3-map / W3-sprites**.
- `?art=ninja` — loads from `ninja/`: a slot for an open (e.g. CC0) tileset. None is bundled, so it currently degrades to the placeholder art.

Expected layout for a folder pack (see `makeFolderPack` in `../assets.js`):

```
limezu/  (or ninja/)
  tileset.png            # ground + building tiles
  characters.png + .json # walk-cycle character atlas (Phaser atlas)
```

Until a pack's art lands, each missing texture **degrades to the generated placeholder** per-asset, so a
half-installed pack still renders. The engine needs **no change** when art is added — only files in this folder.

## LimeZu building crops (gitignored — regenerate from `_limezu-src/`)

The `limezu/` folder is gitignored (proprietary art). The building facades are CROPS of the operator-bought
LimeZu Modern Exteriors source under `_limezu-src/` (also gitignored). The pack maps building → facade by
**id first** (its own crop), falling back by **type** (`shop`/`shop2`/`home`/`civic`) — see `CIVIC_BY_ID` +
`SHOP_BY_ID` + `buildingImageFor` in `../assets.js`. Two reasons for the per-id crops:
- the 3 CIVIC buildings get WIDE facades so they fill their wide-short footprints instead of contain-fitting the
  tall-thin 1:3 `civic.png` to a sliver;
- the 5 SHOPS each get a SINGLE clean storefront (LimeZu Market_Medium) instead of the old `shop`/`shop2` crops
  which were ~1.3 storefronts wide and read as "1.5 buildings"; per-id also differentiates the shops.

To regenerate the per-id crops on a fresh checkout, copy these source singles into `limezu/buildings/`:

```
# CIVIC — from renderer/phaser/assets/_limezu-src/Modern_Exteriors_16x16/ME_Theme_Sorter_16x16/
13_School_Singles_16x16/ME_Singles_School_16x16_School_1.png                 -> limezu/buildings/college.png   (384x368)
13_School_Singles_16x16/ME_Singles_School_16x16_School_1.png                 -> limezu/buildings/townhall.png  (384x368, same grand school)
24_Additional_Houses_Singles_16x16/24_Additional_Houses_Victorian_House_5_16x16.png -> limezu/buildings/pub.png (288x256, Victorian → The Rose & Crown)

# SHOPS — single storefronts from 9_Shopping_Center_and_Markets_Singles_16x16/ (all 112x144), file prefix:
#   ME_Singles_Shopping_Center_and_Markets_16x16_Market_Medium_<N>.png
Market_Medium_5  -> limezu/buildings/cafe.png      (tan, orange awning  → Hobbs Cafe)
Market_Medium_1  -> limezu/buildings/grocer.png    (green, red awning   → Willows Market)
Market_Medium_9  -> limezu/buildings/depot.png     (tan, red awning     → Harvey Oak Supply)
Market_Medium_3  -> limezu/buildings/bakery.png    (green, double doors → Moreno Bakery)
Market_Medium_11 -> limezu/buildings/smithy.png    (tan, glass front    → Harvey Oak Smithy)
```

If any per-id crop is absent, that building falls back by type (shop→shop/shop2, civic→civic.png), and if THAT
is absent, to the generated placeholder — so a fresh checkout without the crops still renders (just less pretty).

## LimeZu INTERIOR crops (B3 — gitignored; regenerate with `scripts/crop-interiors.sh`)

`limezu/interiors/{floors,walls,objects}/*.png` are the FURNITURE / floor / wall pieces for the interior
scene (B2). They're CROPS of the operator-bought LimeZu Modern Interiors under `_limezu-src/1_Interiors/48x48/`
(also gitignored). The pack (`../assets.js` `limezuPack`) requests a piece by SEMANTIC NAME via three getters
— `interiorFloor(scene,kind)`, `interiorWall(scene,variant)`, `interiorObject(scene,name)` — each with the same
per-key degrade as the exterior pack (a missing crop → a generated flat tile for floors/walls, or `null` for
objects so the scene draws a placeholder rect). Names align to B1's `interior.theme` + `sublocation.kind` enums
(see `sim/interiors.ts`); the full available-name list + alias table live in `assets.js`.

**To regenerate on a fresh checkout: `bash scripts/crop-interiors.sh`** (from the repo root, needs ImageMagick).
It crops named tile-rects from the 48px source sheets — the exact `(sheet, x, y, w, h)` provenance for every
piece is in that script (one `crop … "$OUT/…"` line each). The source sheets are the combined `Theme_Sorter`
sheets (not the unnamed numbered Singles): Kitchen/Grocery/Bedroom/Classroom/LivingRoom/Music + Room_Builder
floors & walls. Two notes: smithy `forge`/`anvil` are a dark recolor of the kitchen stove (LimeZu has no forge);
`rug` aliases to the warm `carpet` floor (the bedroom rug crops are near-transparent). Validate the pack with
`node scripts/test-interior-pack.mjs` (zero-token) and visually at `http://localhost:4042/?art=limezu`. If a
crop is absent the piece degrades per the rules above — a fresh checkout without crops still renders.

## The full `limezu/` layout the pack looks for (none of it is in this repo)

Buy LimeZu's **Modern Exteriors** (<https://limezu.itch.io/modernexteriors>) and **Modern Interiors**
(<https://limezu.itch.io/moderninteriors>), unpack them into `_limezu-src/`, then produce these crops.
Every one is optional: whatever is missing falls back to the generated placeholder art.

```
limezu/ground/{grass,road,pavement}.png                      16x16 tiles from Modern Exteriors
limezu/characters/{baker,barista,courier,grocer,smith,student,musician,regular}.png
                                                             16x32 single standing frames, one per citizen
limezu/buildings/{shop,shop2,home,civic}.png                 type fallbacks (Modern Exteriors singles)
limezu/buildings/{cafe,grocer,depot,bakery,smithy,college,townhall,pub}.png
                                                             per-building facades (mapping above)
limezu/interiors/{floors,walls,objects}/*.png                bash scripts/crop-interiors.sh
```

The interior crops are fully scripted and the per-building facades are mapped file-by-file above. The
ground tiles, character frames and the four type fallbacks were cropped by hand when the town was
built and their exact source rects were not recorded: pick any matching 16px pieces from the packs.
