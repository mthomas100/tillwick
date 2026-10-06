// scripts/verify-flight-tape.ts — END-TO-END verification of the T0-tape pipeline BEFORE the sim hooks
// are mounted: drive sim/flight-tape.ts with the EXACT call sequence the sim-server hooks will make
// (begin → pos/path/enter/status/spot/say+earshot/dialogue/purchase/leave → stop), then prove that
//   (1) telemetry grades the run by its MANIFEST window (runId slicing) and M7/M9 light up from the tape,
//   (2) the replayer renders the timeline AND fires the anomaly detectors that legacy data cannot
//       (working-from-the-doorway, at-door-dwell, inside-no-purpose, say-unheard).
// Zero tokens; a scratch data dir under os.tmpdir; cleans up after itself. `npx tsx scripts/verify-flight-tape.ts`

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlightTape } from "../sim/flight-tape.js";
import { computeTelemetry, loadTelemetryInput, DEFAULT_ROLE_CONFIG } from "../sim/telemetry.js";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`VERIFY FAILED: ${msg}`);
  console.log(`  ✅ ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "verify-flight-tape-"));
const dataDir = join(dir, "data");
mkdirSync(join(dataDir, "traces"), { recursive: true });

try {
  // ---- 1. write a mini-run through the tape, mirroring the hook call sequence one-to-one ----
  let gm = 4200;
  let t = Date.parse("2026-07-18T20:00:00.000Z");
  const tape = new FlightTape(join(dataDir, "runs"), () => gm, { now: () => new Date((t += 4000)) });
  tape.syncStatus("stopped", null); // sim boots stopped (baseline)

  const runId = tape.beginRun({ duration: { kind: "minutes", value: 15 }, roster: [{ id: "baker" }, { id: "barista" }, { id: "smith" }], gameMinPerRealSec: 1.2, ceilingUsd: 5 });
  tape.syncStatus("running", null);

  const wall = () => new Date(t).toISOString(); // events.jsonl lines share the tape's clock
  const ev = (actor: string, kind: string, payload: Record<string, unknown>, txHash?: string) =>
    appendFileSync(join(dataDir, "events.jsonl"), JSON.stringify({ ts: wall(), actor, kind, payload, ...(txHash ? { txHash } : {}) }) + "\n");

  // barista: walks to the cafe, ENTERS, emits a work status while still at the door (NO spot) → doorway flag
  tape.path("barista", { x: 12, y: 11 }, "goTo", { to: "cafe" }, [[11, 11], [10, 11], [5, 8], [5, 7]]);
  tape.pos("barista", { x: 5, y: 8, building: "cafe" }, true);
  gm += 6; tape.enter("barista", { x: 5, y: 7, building: "cafe", inside: { b: "cafe", ix: 6, iy: 8 } }, "cafe");
  gm += 4; tape.event({ actor: "barista", kind: "status", payload: { text: "brewing…", emoji: "☕", verb: "brew", at: "cafe" } }, { x: 5, y: 7, building: "cafe", inside: { b: "cafe", ix: 6, iy: 8 } });
  ev("barista", "status", { text: "brewing…", emoji: "☕", verb: "brew", at: "cafe" });
  // …then takes the counter (spot) and works for real
  gm += 10; tape.spot("barista", { x: 5, y: 7, building: "cafe", inside: { b: "cafe", ix: 6, iy: 2, spot: "cafe-counter" } }, { building: "cafe", spot: "cafe-counter", label: "service counter", ix: 6, iy: 2, kind: "counter" });
  gm += 5; tape.event({ actor: "barista", kind: "produce", payload: { good: "coffee", have: 1 } }, { x: 5, y: 7, building: "cafe", inside: { b: "cafe", ix: 6, iy: 2, spot: "cafe-counter" } });
  ev("barista", "produce", { good: "coffee", have: 1 });

  // baker: enters the bakery, does NOTHING inside for 40 game-min, leaves → at-door-dwell + inside-no-purpose
  gm += 5; tape.enter("baker", { x: 40, y: 7, building: "bakery", inside: { b: "bakery", ix: 6, iy: 8 } }, "bakery");
  gm += 40; tape.leave("baker", { x: 40, y: 8, building: "bakery" }, "bakery");

  // smith: says something with NOBODY in earshot → say-unheard; the fan RECORDS who was excluded and why
  // (D32 layer 5: silence explained); then a status whose position CONTRADICTS it
  gm += 3; tape.event({ actor: "smith", kind: "say", payload: { to: "", text: "anyone here?", turn: 7 } }, { x: 50, y: 8, building: "smithy" });
  tape.earshot("smith", { x: 50, y: 8, building: "smithy" }, { kind: "say", audience: [], excluded: [{ id: "baker", why: "walls (inside bakery)" }, { id: "barista", why: "walls (inside cafe)" }] });
  gm += 3; tape.event({ actor: "smith", kind: "status", payload: { text: "forging…", emoji: "🔨", verb: "forge", at: "smithy" } }, { x: 50, y: 11, building: "home-smith" });
  ev("smith", "status", { text: "forging…", emoji: "🔨", verb: "forge", at: "smithy" });

  // D32 beats: a suppression (evaluated, did NOT fire, reason), a FAILED act (the fallthrough trap made
  // loud), and an EMPTY affordance menu (the stuck precursor) — all tid-stamped to smith's tick 7
  gm += 2; tape.event({ actor: "smith", kind: "suppressed", payload: { trigger: "dialogue", target: "baker", reason: "cooldown 45gm remaining", tick: 7 } }, { x: 50, y: 8, building: "smithy" });
  tape.actFail("smith", { x: 50, y: 8, building: "smithy" }, { action: "juggle", reason: "unknown action (fallthrough)", tick: 7 });
  tape.event({ actor: "smith", kind: "menu", payload: { options: [], tick: 7 } }, { x: 50, y: 8, building: "smithy" });

  // a dialogue + an on-chain purchase (both located)
  gm += 4; tape.dialogue({ x: 5, y: 7, building: "cafe" }, { id: "dlg:t", participants: ["barista", "baker"], turns: 4, outcome: "conversed", topic: "morning bread", startedAtGameMin: gm });
  appendFileSync(join(dataDir, "dialogue.jsonl"), JSON.stringify({ id: "dlg:t", ts: wall(), participants: ["barista", "baker"], startedAtGameMin: gm, turns: 4, outcome: "conversed", topic: "morning bread" }) + "\n");
  gm += 4; tape.event({ actor: "baker", kind: "purchase", payload: { item: "coffee", price_usdc: 0.02, shop: "cafe", counterparty: "barista" }, txHash: "0xfeed" }, { x: 5, y: 7, building: "cafe", inside: { b: "cafe", ix: 1, iy: 5, spot: "cafe-table-1" } });
  ev("baker", "purchase", { item: "coffee", price_usdc: 0.02, shop: "cafe", counterparty: "barista" }, "0xfeed");

  gm += 6; tape.syncStatus("stopped", "duration-elapsed");

  // one trace line inside the window so telemetry has a position + the world file for geometry
  writeFileSync(join(dataDir, "traces", "barista.jsonl"), JSON.stringify({ ts: wall(), id: "barista", tick: 1, gameMin: gm - 30, perceived: { at: { x: 5, y: 7 }, shop: "cafe", adjacentTo: [] }, retrieved: [], reasoning: "verify", actions: [], wrote: { observations: 0, reflections: 0 }, result: { subtype: "success", cost_usd: 0.01, num_turns: 1, error: null } }) + "\n");
  // an out-of-window legacy dialogue that MUST NOT leak into the run slice (the epoch-overlap trap)
  appendFileSync(join(dataDir, "dialogue.jsonl"), JSON.stringify({ id: "dlg:june", participants: ["a", "b"], startedAtGameMin: 9000, turns: 4, outcome: "conversed" }) + "\n");

  console.log(`\nscratch run ${runId} written; now grade + replay it\n`);

  // ---- 2. telemetry: grade THE RUN (manifest window + tape M7 + span M9) ----
  const input = loadTelemetryInput({ dataDir, runId: "latest" });
  assert(input.slice?.label === `run ${runId}`, `telemetry slices by the run manifest (label "${input.slice?.label}")`);
  assert((input.tape?.length ?? 0) > 10, `the run's tape is loaded (${input.tape?.length} beats)`);
  assert(input.dialogues.length === 1 && input.dialogues[0].id === "dlg:t", "run slicing keeps the in-run dialogue and EXCLUDES the other-epoch june line");
  assert(typeof input.gameSpanMin === "number" && input.gameSpanMin! > 80, `game-span from the manifest (${input.gameSpanMin} gm)`);
  const tl = computeTelemetry(input);
  const metric = (id: string) => tl.metrics.find((m) => m.id === id)!;
  assert(metric("M7").grade !== "na", `M7 lights up from tape beats (${metric("M7").value})`);
  assert((metric("M7").detail.spotTakes as number) === 1 && (metric("M7").detail.interiorsUsed as string[]).length === 2, "M7 counts interiors used + spot-takes from enter/spot beats");
  assert(metric("M9").grade !== "na" && (metric("M9").detail.meaningful as number) >= 4, `M9 computes a rate over the manifest span (${metric("M9").value})`);
  assert(metric("M8").detail.settlements === 1 && metric("M8").grade === "pass", "M8 sees the run's on-chain purchase");

  // ---- 3. replayer: timeline + the tape-only anomaly detectors ----
  const out = execFileSync("npx", ["tsx", "scripts/replay-run.ts", "--data", dataDir, "--run", "latest"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 120_000 });
  assert(out.includes("real flight tape"), "replayer reads the real tape");
  assert(out.includes("takes service counter in cafe at (6,2)"), "timeline shows the spot beat with interior coords");
  assert(out.includes("working-from-the-doorway"), "DOORWAY DETECTOR fires (status while inside with no spot)");
  assert(out.includes("status-position-mismatch"), "status-vs-position detector fires from the beat's own position");
  assert(out.includes("at-door-dwell"), "at-door-dwell fires (baker 40 gm inside without a spot)");
  assert(out.includes("inside-no-purpose"), "inside-no-purpose fires (baker entered and did nothing)");
  assert(out.includes("say-unheard"), "say-unheard fires (empty earshot audience)");
  assert(out.includes("tx 0xfeed"), "purchase renders with its settlement hash");
  assert(out.includes("RUN BEGINS") && out.includes("RUN ENDS"), "run bracketing renders");

  const interiorOut = execFileSync("npx", ["tsx", "scripts/replay-run.ts", "--data", dataDir, "--run", "latest", "--interior", "cafe"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 120_000 });
  assert(/1=\(\d+,\d+\) (barista|baker)/.test(interiorOut), "interior floorplan places occupants from tape state");

  // ---- 4. D32: the causal join key + the why-not query + the new detectors ----
  const { readFileSync } = await import("node:fs");
  const rawTape = readFileSync(join(dataDir, "runs", runId, "tape.jsonl"), "utf8");
  assert(rawTape.includes('"tid":"smith:7"'), "tid causal join key stamped from the payload's tick/turn field");
  assert(out.includes("act-fail") && out.includes("juggle"), "act-fail beat surfaces as a HIGH flag (fallthrough made loud)");
  assert(out.includes("no-affordances-perceived"), "empty affordance menu flags as the stuck precursor");
  const whySmith = execFileSync("npx", ["tsx", "scripts/replay-run.ts", "--data", dataDir, "--run", "latest", "--why", "smith"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 120_000 });
  assert(whySmith.includes("did NOT dialogue") && whySmith.includes("cooldown 45gm remaining"), "--why shows the suppressed dialogue with its reason");
  assert(whySmith.includes("juggle") && whySmith.includes("NONE — empty menu"), "--why shows the failed act + the empty menu");
  const whyBaker = execFileSync("npx", ["tsx", "scripts/replay-run.ts", "--data", dataDir, "--run", "latest", "--why", "baker"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 120_000 });
  assert(whyBaker.includes("did not hear smith's say — walls (inside bakery)"), "--why shows earshot EXCLUSION with the reason (silence explained)");

  console.log("\n✅ verify-flight-tape: FULL PIPELINE GREEN (tape → manifest slicing → M7/M9 → replay → detectors → D32 why-not)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
