// grade-run.ts — the God's-eye SCORECARD CLI (Wave A2). Reads the sim's own logs and prints the M1-M8
// scorecard (the scorecard) with PASS/WARN/FAIL per metric and a one-line verdict — the harsh-critic's
// instrument AND the lead's before/after gate for the A1 keystone. "Flat numbers = not there yet, seen
// without a screenshot." (D24.)
//
//   npm run grade                       # grade the whole events.jsonl
//   npm run grade -- --run latest       # T0-tape: grade ONE recorded run (manifest window + tape M7/M9)
//   npm run grade -- --run <runId>      # a specific run from sim/data/runs/
//   npm run grade -- --list-runs        # list recorded runs (id · window · reason · beats)
//   npm run grade -- --since <ISO>      # grade only events at-or-after a wall-clock time (a specific run)
//   npm run grade -- --last <N>         # grade only the last N events
//   npm run grade -- --json             # emit the raw Telemetry JSON (what GET /telemetry returns)
//   npm run grade -- --data <dir>       # point at a different sim/data dir (default: sim/data)
//   npm run grade -- --crosscheck       # also print jq-equivalent hand-counts (say/dialogue/purchase) to verify
//
// (Also runnable directly: `npx tsx scripts/grade-run.ts -- …` from the repo root.)
//
// NEVER calls an LLM; READ-ONLY over the logs; degrade-don't-die (the harness skips malformed lines).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeTelemetry, loadTelemetryInput, DEFAULT_ROLE_CONFIG, type Telemetry, type Grade } from "../sim/telemetry.js";
import { listRunIds, readManifest } from "../sim/flight-tape.js";

// ───────────────────────── arg parsing (tiny; no dep) ─────────────────────────

type Args = { since?: string; last?: number; json: boolean; data?: string; crosscheck: boolean; baseline?: number; run?: string; listRuns: boolean };
function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, crosscheck: false, listRuns: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--since") a.since = argv[++i];
    else if (t === "--last") a.last = Number(argv[++i]);
    else if (t === "--run") a.run = argv[++i];
    else if (t === "--list-runs") a.listRuns = true;
    else if (t === "--json") a.json = true;
    else if (t === "--data") a.data = argv[++i];
    else if (t === "--crosscheck") a.crosscheck = true;
    else if (t === "--baseline") a.baseline = Number(argv[++i]);
    else if (/^\d{4}-\d\d-\d\dT/.test(t) && !a.since) a.since = t; // bare ISO → --since
    else if (/^\d+$/.test(t) && a.last == null) a.last = Number(t); // bare integer → --last
  }
  return a;
}

// ───────────────────────── ANSI (degrades to plain when not a TTY) ─────────────────────────

const TTY = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  reset: TTY ? "\x1b[0m" : "",
  bold: TTY ? "\x1b[1m" : "",
  dim: TTY ? "\x1b[2m" : "",
  green: TTY ? "\x1b[32m" : "",
  yellow: TTY ? "\x1b[33m" : "",
  red: TTY ? "\x1b[31m" : "",
  cyan: TTY ? "\x1b[36m" : "",
  gray: TTY ? "\x1b[90m" : "",
};
const ICON: Record<Grade, string> = { pass: "✅", warn: "⚠️ ", fail: "❌", na: "➖" };
const COLOR: Record<Grade, string> = { pass: c.green, warn: c.yellow, fail: c.red, na: c.gray };

// visible width that ignores ANSI + counts most emoji as width-2 (good enough for column alignment).
function vlen(s: string): number {
  const noAnsi = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of noAnsi) w += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}
function padEndV(s: string, n: number): string {
  const pad = n - vlen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}
// Truncate to a visible width (ANSI-aware), appending … if it overflows — so a long VALUE never overruns the
// STATUS column. Strips ANSI for measurement, re-applies the caller's color outside.
function truncV(plain: string, n: number): string {
  if (vlen(plain) <= n) return plain;
  let out = "";
  let w = 0;
  for (const ch of plain) {
    const cw = /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

// ───────────────────────── the scorecard renderer ─────────────────────────

function renderScorecard(t: Telemetry): string {
  const L: string[] = [];
  const rule = c.gray + "─".repeat(90) + c.reset;

  L.push("");
  L.push(`${c.bold}${c.cyan}  God's-eye scorecard${c.reset}  ${c.dim}— Tillwick${c.reset}`);
  L.push(rule);

  // header: the slice + the role map M2 graded against (transparency — D-A2-4)
  const s = t.slice;
  const sliceLabel = s.label ?? (s.sinceTs ? `since ${s.sinceTs}` : "whole log");
  L.push(
    `  ${c.dim}slice:${c.reset} ${sliceLabel}   ` +
      `${c.dim}events:${c.reset} ${s.events}  ${c.dim}traces:${c.reset} ${s.traces}  ${c.dim}dialogues:${c.reset} ${s.dialogues}  ` +
      `${c.dim}agents:${c.reset} ${s.agents.length}  ${c.dim}game-days:${c.reset} ${t.gameDays.join(",") || "—"}`,
  );
  const mapStr = Object.entries(t.roleMap)
    .map(([k, v]) => `${k}→${v ?? "—"}`)
    .join("  ");
  L.push(`  ${c.dim}role→workplace (M2):${c.reset} ${c.gray}${mapStr}${c.reset}`);
  // anti-drift guard: only shows if the window/movement table fell out of sync with the workplace map.
  for (const w of t.roleConfigWarnings ?? []) L.push(`  ${c.yellow}⚠ role-config:${c.reset} ${w}`);
  L.push(rule);

  // column header
  L.push(`  ${c.bold}${padEndV("#", 4)}${padEndV("METRIC", 30)}${padEndV("VALUE", 38)}STATUS${c.reset}`);
  L.push(rule);

  for (const m of t.metrics) {
    const col = COLOR[m.grade];
    const id = padEndV(`${c.bold}${m.id}${c.reset}`, 4);
    const name = padEndV(truncV(m.name, 28), 30);
    const value = padEndV(`${col}${truncV(m.value, 36)}${c.reset}`, 38);
    const status = `${ICON[m.grade]} ${col}${m.grade.toUpperCase()}${c.reset}`;
    L.push(`  ${id}${name}${value}${status}`);
    // a dim target line under each metric so the bar is always visible next to the value
    L.push(`  ${padEndV("", 4)}${c.dim}target: ${m.target}${c.reset}`);
  }

  L.push(rule);

  // verdict — behavior layer (M1-M6) is the operator's "living their lives + really talking"
  const behavior = t.metrics.filter((m) => ["M1", "M2", "M3", "M4", "M5", "M6"].includes(m.id));
  const behaviorGreen = behavior.filter((m) => m.grade === "pass").length;
  const verdictColor = t.greenCount >= 6 ? c.green : t.greenCount >= 3 ? c.yellow : c.red;
  L.push(`  ${c.bold}${verdictColor}${t.verdict}${c.reset}   ${c.dim}(behavior layer M1-M6: ${behaviorGreen}/6 green)${c.reset}`);
  L.push("");
  // the honest read: what it means
  if (t.greenCount >= 6) L.push(`  ${c.green}→ They're living their lives across the city, going to work, and really talking. That's a living town.${c.reset}`);
  else if (behaviorGreen === 0) L.push(`  ${c.red}→ Flat. Reflex-agents hugging one street. The vision is not held yet.${c.reset}`);
  else L.push(`  ${c.yellow}→ Partway. Some pillars moving, others flat — see the ❌/⚠️ rows above.${c.reset}`);
  L.push("");

  return L.join("\n");
}

// ───────────────────────── jq cross-check (optional; --crosscheck) ─────────────────────────

function crosscheck(t: Telemetry): string {
  const m = (id: string) => t.metrics.find((x) => x.id === id)!;
  const says = (m("M4").detail as any).says;
  const dlg = (m("M3").detail as any).realConvos;
  const purch = (m("M8").detail as any).settlements;
  return [
    `  ${c.dim}cross-check (verify against jq on the same logs):${c.reset}`,
    `    say events        = ${says}   ${c.dim}( jq -r '.kind' events.jsonl | grep -c '^say$' )${c.reset}`,
    `    ≥3-turn dialogues = ${dlg}   ${c.dim}( jq 'select(.turns>=3)' dialogue.jsonl | jq -s length )${c.reset}`,
    `    purchases         = ${purch}   ${c.dim}( jq -r '.kind' events.jsonl | grep -c '^purchase$' )${c.reset}`,
    `    ${c.dim}live baseline watermarks: say:dialogue 644:26 · settlements 1164 (historical)${c.reset}`,
  ].join("\n");
}

// ───────────────────────── main ─────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.listRuns) {
    const dir = join(args.data ?? join(dirname(fileURLToPath(import.meta.url)), "..", "sim", "data"), "runs");
    const ids = listRunIds(dir);
    if (!ids.length) { console.log("no recorded runs yet (the flight tape starts recording once the sim hooks are mounted)"); return; }
    for (const id of ids) {
      const m = readManifest(dir, id);
      console.log(`${id}  ${m?.startedTs ?? "?"} → ${m?.endedTs ?? "OPEN"}  ${m?.endReason ?? ""}  beats:${m?.beats ?? "?"}`);
    }
    return;
  }
  let skipped = 0;
  const input = loadTelemetryInput({
    dataDir: args.data,
    sinceTs: args.since,
    lastN: args.last,
    runId: args.run,
    settlementBaseline: args.baseline,
    roleConfig: DEFAULT_ROLE_CONFIG,
    onSkip: () => skipped++,
  });
  const t = computeTelemetry(input);

  if (args.json) {
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderScorecard(t));
  if (args.crosscheck) process.stdout.write("\n" + crosscheck(t) + "\n");
  if (skipped > 0) process.stdout.write(`\n  ${c.yellow}note:${c.reset} skipped ${skipped} malformed/partial JSONL line(s) (degrade-don't-die)\n`);
}

main();
