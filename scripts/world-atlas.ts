// scripts/world-atlas.ts — generate docs/design/WORLD-ATLAS.md: the GROUND TRUTH of every building,
// station, seat and object — coords in both spaces, the real asset chain each object renders through, an
// ASCII floorplan per interior, and MECHANICAL layout smells (T0-tape). This is the input document for the
// next wave's interior redesign: the smells section is deliberately brutal and specific.
//
//   npx tsx scripts/world-atlas.ts            # (re)write docs/design/WORLD-ATLAS.md
//   npx tsx scripts/world-atlas.ts --stdout   # print the markdown instead of writing
//   npx tsx scripts/world-atlas.ts --check    # print the smell summary; exit 1 if any HIGH smell (gate)
//
// Sources: sim/world.json (geometry) · renderer/phaser/assets.js driven through a mock scene (the REAL
// alias resolution — zero copied tables) · the gitignored LimeZu crops' PNG headers (pixel truth) ·
// sim/telemetry.ts DEFAULT_ROLE_CONFIG (whose workplace each building is). Read-only; no LLM; no sim.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadWorld, insideTile, resolveAssetChain, resolveSurface, renderFit, floorplanAscii,
  townMapAscii, buildingLetters, computeSmells, themeToFloor, themeToWall,
  affordancesOf, affordancesCell, AFFORDANCE_VOCAB,
  type AtlasBuilding, type AtlasWorld, type Smell,
} from "./atlas-lib.js";
import { DEFAULT_ROLE_CONFIG } from "../sim/telemetry.js";

const OUT = join(ROOT, "docs", "design", "WORLD-ATLAS.md");

function fmtSmell(s: Smell): string {
  const badge = s.severity === "high" ? "🟥 HIGH" : s.severity === "med" ? "🟧 MED" : "🟨 low";
  return `- **${badge} · ${s.code}** — ${s.msg}`;
}

function buildingSection(b: AtlasBuilding, world: AtlasWorld, workplaceOf: Map<string, string[]>): string {
  const L: string[] = [];
  const streetTop = world.street.rows[0];
  const [ix, iy] = insideTile(b, streetTop);
  const letters = buildingLetters(world);
  L.push(`### ${letters.get(b.id)} · ${b.label} \`${b.id}\``);
  L.push("");
  const purpose: string[] = [`type **${b.type}**`, `area **${b.area ?? "—"}**`];
  if (b.goods?.length) purpose.push(`sells ${b.goods.map((g) => `${g.id} @ ${g.price}`).join(", ")}`);
  if (b.producer) purpose.push(`produces **${b.producer.produces}**`);
  if (b.resident) purpose.push(`home of **${b.resident}**`);
  const workers = workplaceOf.get(b.id);
  if (workers?.length) purpose.push(`workplace of **${workers.join(", ")}**`);
  L.push(`Purpose: ${purpose.join(" · ")}.`);
  L.push("");
  L.push(`Exterior: footprint (${b.x},${b.y}) ${b.w}×${b.h} · door **(${b.door.x},${b.door.y})** · inside-tile **(${ix},${iy})** (the single world tile every goTo routes to — all occupants stand here in the exterior view).`);
  const spawnHere = Object.entries(world.spawns ?? {}).filter(([, s]) => Math.abs(s.x - b.door.x) <= 1 && Math.abs(s.y - b.door.y) <= 1).map(([id]) => id);
  if (spawnHere.length) L.push(`Spawns at this door: ${spawnHere.join(", ")}.`);
  L.push("");

  if (!b.interior) {
    L.push(`**NO INTERIOR MODEL.** Rooms exist only as NL text (world-tree): ${(b.rooms ?? []).map((r) => `${r.label} [${r.objects.map((o) => o.id).join(", ")}]`).join(" · ") || "none"}.`);
    L.push("");
  } else {
    const it = b.interior;
    const floor = resolveSurface("floor", themeToFloor(it));
    const wall = resolveSurface("wall", themeToWall(it));
    L.push(
      `Interior: **${it.w}×${it.h}** tiles (own local grid) · theme **${it.theme}** · floor **${themeToFloor(it)}** (${floor.generated ? "generated flat fill" : "crop"}) · wall **${themeToWall(it)}** (${wall.generated ? "generated flat band" : "crop"}) · entry/spawn **(${it.spawnInside.x},${it.spawnInside.y})** — agents stand HERE (the doorway) until they \`go_inside\` a spot.`,
    );
    L.push("");
    const staff = workplaceOf.get(b.id);
    L.push("| spot id | label | kind | (x,y) | station | seats | affordances | crop (via) | px | renders as | verdict |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of it.sublocations) {
      const chain = resolveAssetChain(s);
      const seats = (s.seats ?? []).map((x) => `(${x.x},${x.y})`).join(" ") || "—";
      let px = "—", renders = "placeholder rect", verdict = "🟥 MISSING";
      if (chain.textureKey && chain.px) {
        const fit = renderFit(chain.px);
        px = `${chain.px.w}×${chain.px.h}`;
        renders = `${fit.dispTilesW}×${fit.dispTilesH} tiles`;
        verdict = fit.squashed ? `🟥 SQUASHED (${fit.srcTilesW}×${fit.srcTilesH}-tile art in a 1-tile box)` : "✅ ok";
      } else if (chain.textureKey) {
        px = "crop file unreadable";
        verdict = "🟧 unknown";
      }
      L.push(`| \`${s.id}\` | ${s.label} | ${s.kind} | (${s.x},${s.y}) | ${s.station ? "★" : ""} | ${seats} | ${affordancesCell(affordancesOf(s, b, staff))} | ${chain.cropName ?? "—"} (${chain.resolvedVia ?? "none"}) | ${px} | ${renders} | ${verdict} |`);
    }
    L.push("");
    const fp = floorplanAscii(it);
    L.push("```");
    L.push(...fp.lines);
    L.push("```");
    L.push(`Legend: ${fp.legend.join(" · ")} · \`+\`=entry · \`ˢ\`=seat · \`#\`=wall`);
    L.push("");
  }

  const smells = computeSmells(b);
  L.push(`**Layout smells (${smells.length})**`);
  L.push("");
  if (smells.length === 0) L.push("- none detected");
  else L.push(...smells.map(fmtSmell));
  L.push("");
  return L.join("\n");
}

function generate(): { md: string; smellTotals: Map<string, number>; highCount: number; perBuilding: Array<{ id: string; high: number; med: number; low: number }> } {
  const world = loadWorld();
  const workplaceOf = new Map<string, string[]>();
  for (const [agent, bld] of Object.entries(DEFAULT_ROLE_CONFIG.workplace)) {
    if (!bld) continue;
    workplaceOf.set(bld, [...(workplaceOf.get(bld) ?? []), agent]);
  }

  const L: string[] = [];
  L.push("# WORLD ATLAS — ground truth of every place, station, seat and object");
  L.push("");
  L.push("> GENERATED — do not hand-edit. Regenerate: `npx tsx scripts/world-atlas.ts` (from the repo root).");
  L.push("> Sources: `sim/world.json` · the renderer's own alias resolution (`renderer/phaser/assets.js`, driven");
  L.push("> headlessly) · LimeZu crop PNG headers · `sim/telemetry.ts` role config. Coordinates: world tiles for");
  L.push("> exteriors; each interior is its OWN local grid (origin 0,0) — the two spaces never mix.");
  L.push("");

  // town overview
  L.push("## Town overview");
  L.push("");
  L.push(`Grid **${world.width}×${world.height}** · street rows ${world.street.rows.join(",")} · sidewalk rows ${world.sidewalks.rows.join(",")} · cross-park columns x=31,32 (walkability field exists but the LIVE sim ignores it — rows-only walkable(), sim-server.ts:52; the two corridors connect ONLY via building tiles unless W2-move lands).`);
  L.push("");
  const areas = (world.areas ?? []).map((a) => `**${a.label ?? a.id}** [${(a.buildings ?? []).join(", ") || "open"}]`).join(" · ");
  L.push(`Districts: ${areas}`);
  L.push("");
  const tm = townMapAscii(world);
  L.push("```");
  L.push(...tm.lines);
  L.push("```");
  L.push(`Legend: ${tm.legend.join(" · ")} · \`D\`=door · \`+\`=inside tile · \`═\`street \`─\`sidewalk \`¦\`park column (ignored by walkable())`);
  L.push("");
  L.push("Agent spawns: " + Object.entries(world.spawns ?? {}).map(([id, s]) => `${id}(${s.x},${s.y})`).join(" · "));
  L.push("");

  // affordance vocabulary (operator addendum: per-object action menus are ground truth for the phase)
  L.push("## Affordance vocabulary v0 (SHARED NAMING — atlas + tape menu/choice beats + ACT prompt)");
  L.push("");
  L.push("> Proposed by flightrecorder from world.json mechanics; lifegiver (prompt menus) + socialweaver");
  L.push("> (commerce/social) confirm or extend. Per-spot assignments are in each building's table below.");
  L.push("> Known gap, flagged per-spot as `no-affordances`: an appliance WITHOUT `station:true` (dartboard,");
  L.push("> fireplace, quench tub, coffee urn) currently affords NOTHING — dead furniture until a verb like");
  L.push("> `use`/`play`/`warm` is agreed.");
  L.push("");
  L.push("| verb | meaning |");
  L.push("|---|---|");
  for (const [verb, meaning] of Object.entries(AFFORDANCE_VOCAB)) L.push(`| \`${verb}\` | ${meaning} |`);
  L.push("");

  // renderer-class smells that apply to EVERY interior (so per-building lists stay specific)
  L.push("## Renderer-class smells (every interior, one fix each — not repeated per building)");
  L.push("");
  L.push("- **🟥 occupant-on-furniture** — occupants render AT their spot tile (`interior-scene.js update()`), so an agent at a counter/register is drawn overlapping the furniture sprite (the operator's \"grocer overlapping the counter\"). Needs a stand-offset (draw at the adjacent approach tile or feet-anchor below the prop).");
  L.push("- **🟥 walls-are-decorative** — interiors draw only a half-tile decorative band along the TOP edge (`interior-scene.js:328-334`); no side/bottom walls, so nothing anchors furniture visually and rooms read as floating scatter.");
  L.push("- **🟧 labels-8px** — spot labels render at `floor(48*0.18)` = 8px (`interior-scene.js:386`) — illegible at normal zoom (\"tiny illegible labels\").");
  L.push("- **🟥 single-tile-box contain-fit** — every crop is crushed into a ~1-tile box (`interior-scene.js:371`); all multi-tile art becomes slivers (instances flagged per building below). Fix direction: scale by source tiles (`sw/48 × sh/48` render tiles) or give sublocations a real footprint.");
  L.push("- **🟧 spawn-is-the-default-pose** — `enter()` puts every agent on the interior door tile until its LLM issues `go_inside` (`interiors.ts:118-131`); with no nudge, agents idle in doorways (4 of 6 inside-agents sat on the door tile at audit time).");
  L.push("");

  // per-building
  L.push("## Buildings");
  L.push("");
  const smellTotals = new Map<string, number>();
  const perBuilding: Array<{ id: string; high: number; med: number; low: number }> = [];
  let highCount = 0;
  for (const b of world.buildings) {
    L.push(buildingSection(b, world, workplaceOf));
    const smells = computeSmells(b);
    const rec = { id: b.id, high: 0, med: 0, low: 0 };
    for (const s of smells) {
      smellTotals.set(s.code, (smellTotals.get(s.code) ?? 0) + 1);
      if (s.severity === "high") { rec.high++; highCount++; }
      else if (s.severity === "med") rec.med++;
      else rec.low++;
    }
    perBuilding.push(rec);
  }

  // summary
  L.push("## Smell summary");
  L.push("");
  L.push("| building | 🟥 high | 🟧 med | 🟨 low |");
  L.push("|---|---|---|---|");
  for (const r of perBuilding) L.push(`| ${r.id} | ${r.high} | ${r.med} | ${r.low} |`);
  L.push("");
  L.push("| smell | count |");
  L.push("|---|---|");
  for (const [code, n] of [...smellTotals.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${code} | ${n} |`);
  L.push("");
  L.push(`_Generated ${new Date().toISOString()}._`);
  L.push("");
  return { md: L.join("\n"), smellTotals, highCount, perBuilding };
}

function main(): void {
  const args = process.argv.slice(2);
  const { md, smellTotals, highCount, perBuilding } = generate();
  if (args.includes("--check")) {
    console.log("world-atlas smell check:");
    for (const r of perBuilding) console.log(`  ${r.id.padEnd(14)} high=${r.high} med=${r.med} low=${r.low}`);
    console.log("  by code: " + [...smellTotals.entries()].map(([c, n]) => `${c}:${n}`).join(" · "));
    console.log(`  HIGH total: ${highCount}`);
    process.exitCode = highCount > 0 ? 1 : 0;
    return;
  }
  if (args.includes("--stdout")) {
    process.stdout.write(md);
    return;
  }
  writeFileSync(OUT, md);
  console.log(`wrote ${OUT} (${md.split("\n").length} lines; ${highCount} HIGH smells)`);
}

main();
