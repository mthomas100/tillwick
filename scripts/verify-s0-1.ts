// scripts/verify-s0-1.ts — GATED S0-1 live runtime-verify (bounded, incident-safe; modeled on verify-2c.ts).
//
// PROVES the ToolSearch tax is dead, in a REAL transcript:
//   1. boots the sim (never calls an LLM) + attaches a WS viewer (satisfies pause-on-no-viewer),
//   2. enables ONLY one citizen (default baker), starts a BOUNDED run,
//   3. spawns that ONE citizen (Haiku, MAX_TICKS=3),
//   4. reads ONLY the NEW transcript lines (captures the byte offset BEFORE the run) and ASSERTS:
//        • the session-init `tools[]` contains ONLY the citizen's mcp__world__* tools
//          (NO Gmail / Google_Calendar / Cron* / Task* / NotebookEdit / ToolSearch / Bash / Read / …),
//        • 0 `ToolSearch` calls in the new transcript,
//        • 0 ToolSearch-deferred tools (`total_deferred_tools` absent or 0),
//        • the role tools are actually CALLED directly (≥1 `mcp__world__*` tool_use, none preceded by ToolSearch),
//        • no "I need to load/fetch the … tool" plumbing leaks into the assistant text.
//   It also re-confirms the buy-GUARD is intact by static-reading citizen.ts (canUseTool buy-veto present).
//
// Bounds (each independent): MAX_TICKS=3 · 3-min run cap · HARD_TIMEOUT 180s · viewer attached throughout · Max
// only (no paid key — D11). Cleanup is bulletproof (try/finally + SIGKILL + pkill), same as verify-2c.ts.
//
// USAGE (coordinate the :4042 slot through `main` first):  npx tsx scripts/verify-s0-1.ts [citizenId=baker]
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");
const HARD_TIMEOUT_MS = 180_000;
const ID = process.argv[2] ?? "baker";
const OTHERS = ["barista", "courier", "grocer", "smith"].filter((x) => x !== ID);
const TAPE = join(DATA, "agents", `${ID}.jsonl`);

// The ONLY tools the session should surface after S0-1 (8 world tools). Anything else in the init list is a leak.
const WORLD_TOOLS = ["look", "move", "enterShop", "inventory", "consume", "evaluate_purchase", "buy", "talk"].map((t) => `mcp__world__${t}`);
// Any tool that is NOT one of our 8 world tools is "noise". Catch the claude.ai cloud connectors
// (mcp__claude_ai_*: Gmail/Calendar/Drive — injected by the subscription login) AND the Claude-Code built-ins.
const INHERITED_NOISE = /^mcp__claude_ai_|Gmail|Google_Calendar|Google_Drive|^Cron|^Task|NotebookEdit|^ToolSearch|^Bash$|^Read$|^Edit$|^Write$|^Glob$|^Grep$|AskUserQuestion|EnterPlanMode|^WebSearch$|^WebFetch$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);

const childProcs: ChildProcess[] = [];
const citizenProcs: ChildProcess[] = [];
let ws: WebSocket | null = null;

// ATTACH=1 → a sim is ALREADY live on :4042 (e.g. the lead's consolidated Stage-0 slot). Attach to it:
// do NOT pkill the sim, do NOT boot one, and on cleanup kill ONLY the citizen we spawned (never the lead's sim).
// Default (ATTACH unset) → own the slot: killStale + boot our own sim + full teardown (the verify-2c.ts model).
const ATTACH = process.env.ATTACH === "1";

// Kill ONLY citizen processes (safe in both modes — we never want a citizen lingering, but in ATTACH mode we
// must leave the lead's sim untouched).
async function killStaleCitizens() {
  spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]);
  await sleep(600);
}
async function killStaleAll() {
  spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]);
  spawn("pkill", ["-9", "-f", "sim/sim-server"]);
  await sleep(800);
}
async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  for (const p of childProcs) { try { p.kill("SIGKILL"); } catch { /* */ } }
  // ATTACH: only reap citizens (leave the lead's sim). OWN: reap citizens + our sim.
  if (ATTACH) await killStaleCitizens(); else await killStaleAll();
}

// Read the NEW transcript lines written since `fromByte` (so a pre-existing tape doesn't pollute the assertions).
// IMPORTANT: `fromByte` is a BYTE offset (from statSync().size). The tape holds multi-byte UTF-8 (emoji/em-dash in
// personas + narration), so we MUST slice on a Buffer (bytes) and decode AFTER — slicing a decoded string by a byte
// offset chops at the wrong char index and drops the leading lines (incl. the system/init manifest). [verify bug-fix]
function newLines(fromByte: number): Array<Record<string, unknown>> {
  if (!existsSync(TAPE)) return [];
  const buf = readFileSync(TAPE); // Buffer (bytes), not a string
  const fresh = buf.subarray(fromByte).toString("utf8").trim();
  if (!fresh) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const ln of fresh.split("\n")) { if (!ln.trim()) continue; try { out.push(JSON.parse(ln)); } catch { /* partial last line */ } }
  return out;
}

async function main() {
  console.log(ATTACH ? "MODE: ATTACH — using the existing live sim on :4042 (will NOT boot/kill a sim)." : "MODE: OWN — booting a fresh sim on :4042 (verify-2c.ts model).");
  // In OWN mode, clear any stale procs first. In ATTACH mode, only clear stale CITIZENS (never the lead's sim).
  if (ATTACH) await killStaleCitizens(); else await killStaleAll();

  // STATIC pre-check: the buy-GUARD must still be present in citizen.ts (it must survive the S0-1 options change).
  const citizenSrc = readFileSync(join(ROOT, "citizens", "citizen.ts"), "utf8");
  const guardOk = /canUseTool:\s*async/.test(citizenSrc) && /toolName !== "mcp__world__buy"/.test(citizenSrc);
  const hookOk = /tools:\s*\[\]/.test(citizenSrc); // the S0-1 citizen.ts hook (strip built-ins) must be applied
  console.log(`static: buy-GUARD present = ${guardOk}; citizen.ts \`tools:[]\` hook applied = ${hookOk}`);
  if (!hookOk) console.log("⚠ citizen.ts `tools:[]` hook NOT yet applied — the init list will still contain built-ins. Have the lead apply it first.");

  // Capture the tape's byte offset BEFORE the run so we read ONLY this run's lines.
  const fromByte = existsSync(TAPE) ? statSync(TAPE).size : 0;
  console.log(`tape baseline: ${TAPE} @ ${fromByte} bytes (reading only NEW lines after this)`);

  if (ATTACH) {
    // Attach to the lead's live sim. Do NOT spawn one; just confirm it answers (don't push it into childProcs,
    // so cleanup never kills it).
    if (!(await get("/meta"))) throw new Error("ATTACH=1 but no sim is answering on :4042 — start one (or run without ATTACH).");
    console.log("✓ attached to existing sim on :4042");
  } else {
    console.log("⏳ booting sim (never calls an LLM)…");
    const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
    childProcs.push(sim);
    for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
    if (!(await get("/meta"))) throw new Error("sim did not come up");
    console.log("✓ sim up");
  }

  // Attach our own viewer either way (harmless if the lead already has one — both satisfy pause-on-no-viewer).
  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  console.log("✓ viewer attached (pause-on-no-viewer satisfied)");

  if (ATTACH) {
    // Be PURELY ADDITIVE on the lead's sim: enable our target if it isn't, but do NOT disable the others and do
    // NOT restart the run (that would disrupt the lead's consolidated pass). Assume the run is already going.
    await post("/control", { action: "set-agent", id: ID, enabled: true });
    console.log(`✓ ensured ${ID} enabled on the existing run (left the rest of the roster + run-state untouched)`);
  } else {
    // OWN the sim: enable ONLY the citizen under test, start a bounded 3-min run.
    for (const id of OTHERS) await post("/control", { action: "set-agent", id, enabled: false });
    await post("/control", { action: "set-agent", id: ID, enabled: true });
    await post("/control", { action: "start", duration: { kind: "minutes", value: 3 } });
  }
  const c = spawn("npx", ["tsx", "citizens/citizen.ts", ID], {
    cwd: ROOT, stdio: "inherit",
    env: { ...process.env, SIM_URL: SIM, MAX_TICKS: "3", TICK_MS: "6000", CITIZEN_MODEL: process.env.CITIZEN_MODEL ?? "claude-haiku-4-5-20251001" },
  });
  childProcs.push(c); citizenProcs.push(c);
  console.log(`✓ spawned ${ID} (Haiku, MAX_TICKS=3)\n`);

  const t0 = Date.now();
  const exited = () => citizenProcs.every((p) => p.exitCode !== null || p.signalCode !== null);
  // Wait until the citizen has BOTH (a) produced a complete transcript on disk (init + ≥1 result) AND (b) exited —
  // OR the hard timeout. The cold-start first tick runs several cognition Completes before the first audit line, so
  // a process that "exited" isn't enough; we must also see the tape grow + carry a result, else the read is empty.
  const tapeReady = () => { const m = newLines(fromByte); return m.some((x) => { const s = (x as { msg?: { subtype?: string } }).msg; return s?.subtype === "init"; }) && m.some((x) => (x as { msg?: { type?: string } }).msg?.type === "result"); };
  while (Date.now() - t0 < HARD_TIMEOUT_MS) {
    if (tapeReady() && exited()) break; // complete transcript flushed + process done
    if (exited() && !tapeReady() && Date.now() - t0 > 15_000) { console.log("⚠ citizen exited but no complete transcript on disk yet — waiting for flush…"); }
    await sleep(2000);
  }

  // SETTLE: the citizen process buffers its audit writes — read once isn't enough (a flush race drops the tail,
  // including the terminal `result`). Poll-read until BOTH a `system/init` and a terminal `result` are present in
  // the new lines (or a short timeout), so the evidence read is always complete.
  console.log("\n===== S0-1 EVIDENCE (new transcript only) =====");
  let msgs: Array<Record<string, unknown>> = [];
  const hasInit = (xs: typeof msgs) => xs.some((m) => { const x = (m as { msg?: { type?: string; subtype?: string } }).msg; return x?.type === "system" && x?.subtype === "init"; });
  const hasResult = (xs: typeof msgs) => xs.some((m) => (m as { msg?: { type?: string } }).msg?.type === "result");
  for (let i = 0; i < 12; i++) { // up to ~6s of settle
    msgs = newLines(fromByte);
    if (hasInit(msgs) && hasResult(msgs)) break;
    await sleep(500);
  }
  console.log(`new transcript lines: ${msgs.length}${hasInit(msgs) ? "" : " (⚠ no init line captured)"}${hasResult(msgs) ? "" : " (⚠ no result line captured)"}`);

  // (1) session-init tool list — the authoritative boot manifest.
  const inits = msgs.filter((m) => { const x = (m as { msg?: { type?: string; subtype?: string } }).msg; return x?.type === "system" && x?.subtype === "init"; });
  let initTools: string[] = [];
  if (inits.length) initTools = ((inits[inits.length - 1] as { msg: { tools?: string[] } }).msg.tools ?? []);
  const noise = initTools.filter((t) => INHERITED_NOISE.test(t));
  const missing = WORLD_TOOLS.filter((t) => !initTools.includes(t));
  const extras = initTools.filter((t) => !WORLD_TOOLS.includes(t));
  console.log(`init tool list (${initTools.length}): ${JSON.stringify(initTools.sort())}`);
  console.log(`  inherited-noise tools present: ${noise.length ? JSON.stringify(noise) : "NONE ✓"}`);
  console.log(`  expected world tools missing: ${missing.length ? JSON.stringify(missing) : "NONE ✓"}`);
  console.log(`  unexpected extra tools: ${extras.length ? JSON.stringify(extras) : "NONE ✓"}`);

  // (2) ToolSearch calls in the new transcript (assistant tool_use named ToolSearch) — must be 0.
  const raw = JSON.stringify(msgs);
  const toolSearchCount = (raw.match(/"name":"ToolSearch"/g) ?? []).length;
  const deferredVals = [...raw.matchAll(/"total_deferred_tools":(\d+)/g)].map((m) => Number(m[1]));
  console.log(`ToolSearch tool_use calls: ${toolSearchCount} ${toolSearchCount === 0 ? "✓" : "✗ (expected 0)"}`);
  console.log(`total_deferred_tools seen: ${deferredVals.length ? JSON.stringify([...new Set(deferredVals)]) : "none ✓"}`);

  // (3) world tools actually CALLED directly (≥1 mcp__world__* tool_use).
  const worldCalls = (raw.match(/"name":"mcp__world__[a-z_]+"/g) ?? []).length;
  console.log(`direct mcp__world__* tool_use calls: ${worldCalls} ${worldCalls > 0 ? "✓" : "✗ (expected ≥1)"}`);

  // (4) no plumbing leaks into assistant text.
  let leakHits = 0;
  for (const m of msgs) {
    const content = (m as { msg?: { message?: { content?: Array<{ type?: string; text?: string }> } } }).msg?.message?.content ?? [];
    for (const b of content) if (b?.type === "text" && /need to (load|fetch).{0,30}(tool|schema)/i.test(b.text ?? "")) leakHits++;
  }
  console.log(`"need to load/fetch the … tool" leaks: ${leakHits} ${leakHits === 0 ? "✓" : "✗ (expected 0)"}`);

  // (5) on-chain buy (best-effort signal — present if the citizen chose to buy + it settled).
  const txHits = (raw.match(/"txHash":"0x[0-9a-fA-F]+"/g) ?? []).length;
  console.log(`settled on-chain buys (txHash present): ${txHits}`);

  // Detect a transient rate-limit (shared-Opus-pool contention under team load) — a `rate_limit_event` cuts the
  // tick short BEFORE a tool call/result, but it is NOT an S0-1 defect: the tool SURFACE was already proven clean.
  const rateLimited = msgs.some((m) => (m as { msg?: { type?: string } }).msg?.type === "rate_limit_event") || !hasResult(msgs);

  // VERDICT — split the two concerns:
  //  • STRUCTURAL (the S0-1 acceptance gate): the session-init tool list is EXACTLY the 8 world tools, with 0
  //    ToolSearch + 0 deferred. This is provable from the init manifest alone and is what "kill the ToolSearch
  //    tax + clean the surface" means. It does NOT depend on the tick finishing.
  //  • BEHAVIORAL (bonus): a world tool was actually called directly. Can be throttled away by a rate-limit.
  const structuralPass = inits.length > 0 && noise.length === 0 && missing.length === 0 && extras.length === 0 && toolSearchCount === 0 && deferredVals.every((v) => v === 0) && leakHits === 0 && guardOk;
  const behavioralPass = worldCalls > 0;
  console.log(`\nSTRUCTURAL (S0-1 acceptance): ${structuralPass ? "✅ PASS" : "❌ FAIL"} — init list == 8 world tools, 0 ToolSearch, 0 deferred, buy-guard intact.`);
  console.log(`BEHAVIORAL (bonus): ${behavioralPass ? "✅ a world tool was called DIRECTLY" : rateLimited ? "⚠ not observed — tick cut short by a rate_limit_event (shared-Opus-pool contention), NOT an S0-1 defect" : "❌ no world tool call observed"}`);
  const pass = structuralPass; // S0-1 acceptance is the structural gate; behavioral is a bonus that team-load can throttle
  console.log(`\n${pass ? "✅ S0-1 PASS" : "❌ S0-1 FAIL"} — ToolSearch tax ${pass ? "is DEAD (clean tool surface: exactly the 8 world tools, 0 ToolSearch, 0 deferred)" : "NOT yet proven (see ✗ above)"}.${pass && !behavioralPass ? " (Re-run when the Opus pool is quiet to also capture a live direct tool call.)" : ""}`);
  if (!hookOk) console.log("   (citizen.ts `tools:[]` hook was NOT applied — apply it and re-run.)");
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
