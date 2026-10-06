import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCitizens } from "../lib.js";

// ── npm run observe ───────────────────────────────────────────────────────────────────────────────────
// Open EACH citizen's live session in its OWN iTerm window — the headline observability surface. You watch
// every agent tick in real time (its 🗣 reasoning + 🔧 tool calls stream as they happen) AND, in --spawn
// mode, you can Ctrl-C any window to jump into that agent's terminal.
//
// WHY WINDOWS-TAILING-A-STREAM AND NOT `claude --resume`:
//   Each citizen is an SDK `query()` loop (citizens/citizen.ts). Empirically every TICK spawns a FRESH,
//   ephemeral SDK session (a new ~/.claude/projects/.../<uuid>.jsonl per tick — verified: one file = one
//   TICK). There is therefore NO single long-lived "grocer conversation" to attach to, and `claude --resume`
//   would re-open a DEAD single-tick session as a NEW instance (exactly what we DON'T want). The genuine,
//   continuous "live conversation" of a citizen is its PROCESS STREAM: logPretty → stdout → <id>.log, which
//   spans ALL ticks. So we put each citizen's stream in its own window. (See docs/design/observability.md.)
//
// TWO MODES (pick with the first arg; default = tail):
//   tail   — `tail -f sim/data/agents/<id>.log` per window. Pure OBSERVER of a fleet started elsewhere
//            (e.g. `npm run citizens`). Spawns NOTHING — zero token risk, respects the single-writer lock.
//   spawn  — each window runs `tsx citizens/citizen.ts <id>` directly: the LITERAL live process, jump-in-able.
//            INCIDENT DISCIPLINE (INC-2026-06-18): spawn mode is gated — it refuses unless either MAX_TICKS
//            is set (a hard stop) or OBSERVE_SPAWN_OK=1 is exported (you accept the governor is the only bound).
//            The sim governor still applies (citizens idle-poll at 0 tokens until the GUI/control says running).
//
// Usage:
//   npm run observe                         # tail mode (safe; observe a running/finished fleet)
//   npm run observe -- tail                 # explicit tail
//   npm run observe -- tail --term          # use Terminal.app instead of iTerm
//   npm run observe -- tail --only=grocer,courier
//   MAX_TICKS=2 npm run observe -- spawn    # spawn each citizen (bounded) — a tiny live run, each in a window
//
// Every external call (osascript) degrades: on any failure (iTerm absent, Automation denied) it prints the
// exact remediation and, for iTerm, you can re-run with --term to fall back to Terminal.app. Never throws.

const execFileAsync = promisify(execFile);
const IS_MAC = process.platform === "darwin";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root
const LOG_DIR = join(ROOT, "sim", "data", "agents");

// ── args ──────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = (argv.find((a) => a === "spawn" || a === "tail") ?? "tail") as "spawn" | "tail";
const useTerminal = argv.includes("--term") || argv.includes("--terminal");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;

const ids = loadCitizens()
  .map((c) => c.id)
  .filter((id) => !only || only.includes(id));

if (ids.length === 0) {
  console.error(`[observe] no citizens to open (filter --only=${only?.join(",")} matched nothing).`);
  process.exit(1);
}

// ── incident gate for spawn mode ────────────────────────────────────────────────────────────────────────
const MAX_TICKS = process.env.MAX_TICKS;
if (mode === "spawn" && !MAX_TICKS && process.env.OBSERVE_SPAWN_OK !== "1") {
  console.error(
    [
      "[observe] REFUSING to spawn an UNBOUNDED fleet (INC-2026-06-18 token-drain hazard).",
      "  Spawn mode runs the real citizen processes. Bound it, or opt in explicitly:",
      "    MAX_TICKS=2 npm run observe -- spawn      # each citizen runs 2 ticks then exits cleanly",
      "    OBSERVE_SPAWN_OK=1 npm run observe -- spawn  # I accept the sim governor is the only bound",
      "  Or just observe a fleet started elsewhere (safe):  npm run observe -- tail",
    ].join("\n"),
  );
  process.exit(1);
}

// ── per-window shell command ──────────────────────────────────────────────────────────────────────────
// Each window runs a clean login shell. We unset the Claude nesting guards (belt-and-suspenders)
// so a spawned citizen's own SDK session isn't seen as nested inside this agent.
function commandFor(id: string): string {
  const logFile = join(LOG_DIR, `${id}.log`);
  const banner = (s: string) => `printf '\\033]0;${id}\\007'; echo '── ${s} ──';`; // also sets the window/tab title
  if (mode === "spawn") {
    const envPrefix = MAX_TICKS ? `MAX_TICKS=${MAX_TICKS} ` : "";
    // The citizen tees its own stdout; we don't redirect so the window shows the live stream directly.
    return (
      `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT TMUX TMUX_PANE; cd ${shQuote(ROOT)} && ` +
      `${banner(`citizen ${id} (spawn · MAX_TICKS=${MAX_TICKS ?? "∞ governed"})`)} ` +
      `${envPrefix}npx tsx citizens/citizen.ts ${id}`
    );
  }
  // tail mode: ensure the file exists (touch via : >> is append-create) so tail -f doesn't error on a cold fleet.
  return (
    `cd ${shQuote(ROOT)} && ${banner(`tail ${id}.log (observer)`)} ` +
    `touch ${shQuote(logFile)} && tail -n 40 -f ${shQuote(logFile)}`
  );
}

// ── AppleScript escaping ──────────────────────────────────
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function asEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── iTerm: one WINDOW per citizen (not tabs — each citizen gets its OWN window) ─────────────────────
function buildITermScript(cmds: string[]): string {
  const lines: string[] = [`tell application "iTerm"`, `  activate`];
  for (const cmd of cmds) {
    lines.push(`  set w to (create window with default profile)`);
    lines.push(`  tell current session of w to write text "${asEscape(cmd)}"`);
  }
  lines.push(`  return "OK"`);
  lines.push(`end tell`);
  return lines.join("\n");
}

// ── Terminal.app fallback: `do script` opens a NEW window per call ──────────────────────────────────────
function buildTerminalScript(cmds: string[]): string {
  const lines: string[] = [`tell application "Terminal"`, `  activate`];
  for (const cmd of cmds) lines.push(`  do script "${asEscape(cmd)}"`);
  lines.push(`  return "OK"`);
  lines.push(`end tell`);
  return lines.join("\n");
}

async function openWindows(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const cmds = ids.map(commandFor);

  if (!IS_MAC) {
    console.error("[observe] iTerm/Terminal windows are macOS-only. On Linux, in N panes run:");
    for (const id of ids) console.error(`  tail -n 40 -f ${join(LOG_DIR, `${id}.log`)}`);
    process.exit(1);
  }

  const app = useTerminal ? "Terminal" : "iTerm";
  if (app === "iTerm" && !existsSync("/Applications/iTerm.app")) {
    console.warn("[observe] iTerm.app not found — falling back to Terminal.app. (Pass --term to silence this.)");
    return openWith("Terminal", buildTerminalScript(cmds));
  }
  return openWith(app, app === "iTerm" ? buildITermScript(cmds) : buildTerminalScript(cmds));
}

async function openWith(app: "iTerm" | "Terminal", script: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 });
    if (stdout.trim() === "OK") {
      console.log(`[observe] opened ${ids.length} ${app} window(s) [${mode}]: ${ids.join(", ")}`);
      if (mode === "tail") console.log(`[observe] each window tails sim/data/agents/<id>.log. Start a fleet to see live ticks (e.g. via the GUI control / npm run citizens).`);
      else console.log(`[observe] each window is running the live citizen process. Ctrl-C a window to jump into that agent's terminal. The sim governor still gates token spend.`);
      return;
    }
    console.error(`[observe] ${app} did not confirm the open (returned: ${stdout.trim() || "<empty>"}).`);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const s = `${e?.stderr ?? ""} ${e?.message ?? ""}`.toLowerCase();
    if (s.includes("-1743") || s.includes("not authorized") || s.includes("not allowed") || s.includes("not permitted")) {
      console.error(`[observe] Automation permission needed — allow control of ${app} in System Settings → Privacy & Security → Automation, then re-run.`);
    } else if (app === "iTerm" && (s.includes("-600") || s.includes("isn't running") || s.includes("not running"))) {
      console.error("[observe] iTerm could not be driven. Re-run with --term to use Terminal.app instead.");
    } else {
      console.error(`[observe] could not open ${app} windows: ${e?.message ?? "unknown error"}. Re-run with --term to try Terminal.app.`);
    }
    process.exit(1);
  }
}

openWindows();
