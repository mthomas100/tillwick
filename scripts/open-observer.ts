import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCitizens } from "../lib.js";

// ── tsx scripts/open-observer.ts <id> ───────────────────────────────────────────────────────────────────
// Open ONE citizen's observability view in a SINGLE iTerm window, SPLIT into two panes:
//   • LEFT  pane — `tail -f sim/data/agents/<id>.log` : the live STORY (🗣 reasoning + 🔧 tool calls stream).
//   • RIGHT pane — `npm run inspect -- <id>`          : the full INNER-LIFE dashboard (persona · memory stream ·
//                                                       reflection tree · today's plan · relationships · economy ·
//                                                       where the per-tick trace + SDK sessions live).
// This is the host-side half of the GUI "open this agent's logs/trace" button (sim POST /observe spawns this).
// The sim is a Node process ON the host Mac, so it can drive iTerm via osascript; this script encapsulates that
// so the lead-hot sim-server.ts change is a trivial spawn.
//
// WHY inspect (not trace) on the RIGHT: `trace` needs a specific TICK number the popup button doesn't have;
// `inspect -- <id>` needs only the id and shows the whole mind + a pointer to the trace. It's the right default
// for "show me THIS agent". (To drill into one decision: `npm run trace -- <id> <tick>` from the inspect pane.)
//
// PROVEN PATTERN: the iTerm AppleScript + escaping + degrade-don't-die mirror scripts/observe-windows.ts.
// Every external call DEGRADES: iTerm absent → Terminal.app
// fallback; Automation denied → exact remediation printed; nothing ever throws past a non-zero exit. ZERO tokens
// (inspect/tail read sim/data; no model). Read-only re: the fleet — opens a viewer, spawns no citizen.

const execFileAsync = promisify(execFile);
const IS_MAC = process.platform === "darwin";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root
const LOG_DIR = join(ROOT, "sim", "data", "agents");

const argv = process.argv.slice(2);
const useTerminal = argv.includes("--term") || argv.includes("--terminal");
const id = argv.find((a) => !a.startsWith("--")) ?? "";

// ── validate the id against the known citizen roster (so a bad/injected id can't reach the shell) ──────────
const known = new Set(loadCitizens().map((c) => c.id));
if (!id) {
  console.error("usage: tsx scripts/open-observer.ts <citizenId> [--term]");
  process.exit(2);
}
if (!known.has(id)) {
  console.error(`[observe] unknown citizen "${id}". Known: ${[...known].join(", ")}.`);
  process.exit(3);
}

// ── the two pane commands ─────────────────────────────────────────────────────────────────────────────────
// LEFT: tail the live log (touch first so tail -f doesn't error on a cold fleet). RIGHT: the inspect dashboard.
// Both cd into the repo root. The banner also sets the pane/tab title.
function tailCommand(): string {
  const logFile = join(LOG_DIR, `${id}.log`);
  return (
    `cd ${shQuote(ROOT)} && printf '\\033]0;${id} · log\\007'; echo '── tail ${id}.log (live story) ──'; ` +
    `touch ${shQuote(logFile)} && tail -n 60 -f ${shQuote(logFile)}`
  );
}
function inspectCommand(): string {
  return (
    `cd ${shQuote(ROOT)} && printf '\\033]0;${id} · mind\\007'; echo '── npm run inspect -- ${id} (inner life + trace pointer) ──'; ` +
    `npm run inspect -- ${id}`
  );
}

// ── AppleScript escaping (mirrors observe-windows.ts) ─────────────────────────────
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── iTerm: ONE window, SPLIT into two panes (left=tail, right=inspect) ───────────────────────────────────
// create window → write the tail command in its session → split that session vertically (a pane to the RIGHT)
// → write the inspect command in the new (right) session. `split ... vertically` yields a left|right divide.
function buildITermScript(): string {
  return [
    `tell application "iTerm"`,
    `  activate`,
    `  set w to (create window with default profile)`,
    `  tell current session of w`,
    `    write text "${asEscape(tailCommand())}"`,
    `    set rightPane to (split vertically with default profile)`,
    `  end tell`,
    `  tell rightPane to write text "${asEscape(inspectCommand())}"`,
    `  return "OK"`,
    `end tell`,
  ].join("\n");
}

// ── Terminal.app fallback: no clean split via `do script`, so open TWO windows (tail + inspect) ───────────
function buildTerminalScript(): string {
  return [
    `tell application "Terminal"`,
    `  activate`,
    `  do script "${asEscape(tailCommand())}"`,
    `  do script "${asEscape(inspectCommand())}"`,
    `  return "OK"`,
    `end tell`,
  ].join("\n");
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });

  if (!IS_MAC) {
    console.error("[observe] iTerm/Terminal is macOS-only. On Linux run, in two panes:");
    console.error(`  tail -n 60 -f ${join(LOG_DIR, `${id}.log`)}`);
    console.error(`  npm run inspect -- ${id}`);
    process.exit(1);
  }

  const wantTerminal = useTerminal || !existsSync("/Applications/iTerm.app");
  if (useTerminal === false && !existsSync("/Applications/iTerm.app")) {
    console.warn("[observe] iTerm.app not found — falling back to Terminal.app.");
  }
  const app: "iTerm" | "Terminal" = wantTerminal ? "Terminal" : "iTerm";
  const script = app === "iTerm" ? buildITermScript() : buildTerminalScript();
  await openWith(app, script);
}

async function openWith(app: "iTerm" | "Terminal", script: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 });
    if (stdout.trim() === "OK") {
      console.log(`[observe] opened ${app} ${app === "iTerm" ? "split window (tail | inspect)" : "two windows (tail + inspect)"} for ${id}.`);
      return;
    }
    console.error(`[observe] ${app} did not confirm the open (returned: ${stdout.trim() || "<empty>"}).`);
    process.exit(1);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const s = `${e?.stderr ?? ""} ${e?.message ?? ""}`.toLowerCase();
    if (s.includes("-1743") || s.includes("not authorized") || s.includes("not allowed") || s.includes("not permitted")) {
      console.error(`[observe] Automation permission needed — allow control of ${app} in System Settings → Privacy & Security → Automation, then re-run.`);
    } else if (app === "iTerm" && (s.includes("-600") || s.includes("isn't running") || s.includes("not running"))) {
      console.error("[observe] iTerm could not be driven. Re-run with --term to use Terminal.app instead.");
    } else {
      console.error(`[observe] could not open ${app}: ${e?.message ?? "unknown error"}. Re-run with --term to try Terminal.app.`);
    }
    process.exit(1);
  }
}

main();
