#!/bin/bash
# crop-interiors.sh — slice LimeZu INTERIOR art (B3) into the `limezu` interior pack.
#
# Mechanical (no LLM): crops named tile-rects from the gitignored 48px LimeZu interior source sheets into
# renderer/phaser/assets/limezu/interiors/{floors,walls,objects}/. Mirrors the EXTERIOR crop pattern
# (a rect from a source sheet; provenance recorded). Output is GITIGNORED (proprietary art); only THIS
# recipe + assets.js wiring are committed — so a fresh checkout regenerates the pack by running this.
#
# Source grid = 48px/tile. Each crop is `Wtiles*48 x Htiles*48 + Xpx + Ypx`, coords verified by eye against
# the grid-annotated sheets (see assets/README.md §"LimeZu interior crops" for the (sheet,x,y,w,h) table).
#
# Usage:  bash scripts/crop-interiors.sh            (run from the repo root; needs ImageMagick `magick`)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # repo root
SRC="$HERE/renderer/phaser/assets/_limezu-src/1_Interiors/48x48"
RB="$SRC/Room_Builder_subfiles_48x48"
TS="$SRC/Theme_Sorter_48x48"
OUT="$HERE/renderer/phaser/assets/limezu/interiors"

if ! command -v magick >/dev/null 2>&1; then echo "ERROR: ImageMagick 'magick' not found (brew install imagemagick)"; exit 1; fi
if [ ! -d "$SRC" ]; then echo "ERROR: LimeZu interior source missing: $SRC (proprietary art — drop it in first)"; exit 1; fi

mkdir -p "$OUT/floors" "$OUT/walls" "$OUT/objects"

# crop <sheet> <x> <y> <wpx> <hpx> <outfile>  — one rect → one PNG (transparent preserved)
crop () { magick "$1" -crop "${4}x${5}+${2}+${3}" +repage "$6"; }

echo "== floors (Room_Builder_Floors 720x1920) =="
crop "$RB/Room_Builder_Floors_48x48.png"   0 624  48 48 "$OUT/floors/wood.png"      # light wood planks
crop "$RB/Room_Builder_Floors_48x48.png" 384 480  48 48 "$OUT/floors/wood-dark.png" # dark herringbone wood
crop "$RB/Room_Builder_Floors_48x48.png" 192  96  48 48 "$OUT/floors/tile.png"      # cream/beige tile
crop "$RB/Room_Builder_Floors_48x48.png" 576  96  48 48 "$OUT/floors/stone.png"     # grey-green stone
crop "$RB/Room_Builder_Floors_48x48.png"   0 432  48 48 "$OUT/floors/carpet.png"    # pale yellow patterned (carpet stand-in)

echo "== walls (Room_Builder_Walls 1536x1920) =="
crop "$RB/Room_Builder_Walls_48x48.png"     0 144  48 48 "$OUT/walls/plaster.png"   # white plaster
crop "$RB/Room_Builder_Walls_48x48.png"   528 144  48 48 "$OUT/walls/wood.png"      # wood-plank wall
crop "$RB/Room_Builder_Walls_48x48.png"  1056 144  48 48 "$OUT/walls/brick.png"     # red/maroon wall
crop "$RB/Room_Builder_Walls_48x48.png"  1056 288  48 48 "$OUT/walls/tile.png"      # grey concrete/tiled wall

echo "== KITCHEN objects (12_Kitchen 768x2352) — cafe/bakery =="
K="$TS/12_Kitchen_48x48.png"
crop "$K"  96 336  48 48 "$OUT/objects/counter.png"          # straight wood counter (1x1)
crop "$K"  96 480 144 48 "$OUT/objects/counter-3.png"        # 3-wide counter run
crop "$K" 432 528  48 96 "$OUT/objects/stove.png"            # 4-burner stove + oven (1x2)
crop "$K" 432 528  48 96 "$OUT/objects/oven.png"             # alias-art for oven (= stove)
crop "$K" 432 336  48 96 "$OUT/objects/sink.png"             # sink/wash basin unit
crop "$K"   0 528  48 96 "$OUT/objects/table.png"            # light-wood cafe table (top-down, 1x2)
crop "$K" 432 816  96 48 "$OUT/objects/table-wide.png"       # wide light-wood cafe table (2x1)
crop "$K" 432 960  96 48 "$OUT/objects/table-dark.png"       # dark-wood dining table (2x1)
crop "$K" 192 528  48 48 "$OUT/objects/chair.png"            # single wood chair
crop "$K" 336 864  96 96 "$OUT/objects/display-case.png"     # glass bakery display case (2x2)
crop "$K" 432 1104 48 96 "$OUT/objects/fridge.png"           # steel fridge (1x2)
crop "$K" 432 1296 48 96 "$OUT/objects/fridge-open.png"      # open fridge w/ produce
crop "$K" 624 1392 48 96 "$OUT/objects/espresso.png"         # espresso machine (portafilter)
crop "$K" 624 1200 48 48 "$OUT/objects/coffee-maker.png"     # counter coffee maker
crop "$K" 528 1392 48 96 "$OUT/objects/range-hood.png"       # stove with range hood

echo "== GROCERY objects (16_Grocery_store 768x3744) — grocer/depot =="
G="$TS/16_Grocery_store_48x48.png"
crop "$G"   0 768  96 144 "$OUT/objects/shelf.png"           # stocked gondola shelf, packed (2x3)
crop "$G" 240 624 144 48  "$OUT/objects/produce.png"         # row of produce crates (3x1)
crop "$G"  96 384  96 144 "$OUT/objects/cooler.png"          # market freezer/cooler chest (2x3)
crop "$G" 576 192  48 144 "$OUT/objects/freezer.png"         # tall steel freezer (1x3)

echo "== CLASSROOM objects (5_Classroom_and_library 768x1632) — college/townhall =="
C="$TS/5_Classroom_and_library_48x48.png"
crop "$C"   0   0  48 144 "$OUT/objects/desk.png"            # single school desk + chair (1x3)
crop "$C" 240  48 144 96 "$OUT/objects/lectern.png"          # teacher desk w/ open book (3x2)
crop "$C" 480 144 144 96 "$OUT/objects/chalkboard.png"       # green chalkboard on stand (3x2)
crop "$C" 624 240 144 96 "$OUT/objects/blackboard.png"       # dark blackboard
crop "$C" 624 144  96 96 "$OUT/objects/bookshelf.png"        # red bookcase full of books (2x2)
crop "$C" 624  48  48 48 "$OUT/objects/globe.png"            # globe (decor)

echo "== BEDROOM objects (4_Bedroom 768x5136) — homes/dorm =="
B="$TS/4_Bedroom_48x48.png"
crop "$B" 384  96  48 144 "$OUT/objects/bed.png"             # blue bed (top-down, 1x3)
crop "$B" 480  48  48 192 "$OUT/objects/bunk-bed.png"        # framed/headboard bed (1x4)
crop "$B" 576  48  96 96  "$OUT/objects/wardrobe.png"        # wooden dresser (2x2)
# NOTE: no dedicated rug crop — the bedroom rugs are near-transparent pale grey (read empty). The pack
# aliases interiorObject("rug") → the warm `carpet` floor texture instead (a patterned floor patch).

echo "== LIVING ROOM objects (2_LivingRoom 768x2160) — homes/college/pub lounge =="
L="$TS/2_LivingRoom_48x48.png"
crop "$L"  96   0  96 96  "$OUT/objects/tv.png"              # flatscreen TV on stand (2x2)
crop "$L" 144 192  96 96  "$OUT/objects/sofa.png"            # upholstered sofa/armchair (2x2)
crop "$L"  48 336 144 96  "$OUT/objects/sofa-long.png"       # long couch (3x2)
crop "$L" 336 192  96 144 "$OUT/objects/cabinet.png"         # wooden cabinet/wardrobe (2x3)
crop "$L" 528   0  48 96  "$OUT/objects/plant.png"           # potted plant (1x2)
crop "$L" 624   0  48 96  "$OUT/objects/plant-tall.png"      # palm (1x2)

echo "== MUSIC objects (6_Music_and_sport 768x2304) — pub busking =="
M="$TS/6_Music_and_sport_48x48.png"
crop "$M"   0  96  96 96  "$OUT/objects/piano.png"           # upright piano (2x2)
crop "$M"   0 192  48 48  "$OUT/objects/amp.png"             # amplifier
crop "$M" 336 144  48 96  "$OUT/objects/guitar.png"          # acoustic guitar on stand (1x2)
crop "$M" 480 144  48 96  "$OUT/objects/guitar-electric.png" # electric guitar on stand (1x2)
crop "$M" 720 240  48 96  "$OUT/objects/mic.png"             # microphone stand (1x2) — busking focal
crop "$M" 624   0  96 144 "$OUT/objects/harp.png"            # harp (decor)

echo "== SMITHY stand-ins (recolor kitchen stove → industrial appliance) =="
# LimeZu has no forge/anvil; tint the dark stove darker+desaturated so it reads as a forge/industrial unit.
magick "$OUT/objects/stove.png" -modulate 70,40,100 "$OUT/objects/forge.png"
magick "$OUT/objects/stove.png" -modulate 60,20,100 "$OUT/objects/anvil.png"

echo "OK — interior crops written under $OUT"
find "$OUT" -name '*.png' | wc -l | xargs echo "total crops:"
