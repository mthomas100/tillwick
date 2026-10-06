// scripts/verify-task-13.ts — GATED zero-token e2e for the talk()-adjacency gate (task #13). NO LLM — it
// drives the sim's HTTP API directly (POST /event, /act). It boots a sim on :4042, so it is GATED on the
// team's single slot (coordinate through the lead — a demo may be live).
//
// PROVES the bug is fixed AT THE AUTHORITATIVE SERVER GATE (POST /event, the single writer + feed broadcaster
// — NOT just /act, since the visible "X → Y" feed entry comes from /event):
//   (1) reproduce the exact bug: a FAR / disabled target `say` is REJECTED and no `say` event lands on the feed;
//   (2) an ADJACENT `say` is ACCEPTED and recorded (legit talk + feed still work);
//   (3) the W2b /dialogue path is UNAFFECTED (not gated).
// Bulletproof cleanup (verify-2c model).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const EVENTS = join(ROOT, "sim", "data", "events.jsonl");
const A = "barista"; // the speaker (the operator's exact case)
const B = "courier"; // the FAR / disabled target

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const sayEvents = () => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean) : [])
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.kind === "say");
const posOf = async (id: string) => { const s = await get("/snapshot"); return s?.agents?.find((x: { id: string }) => x.id === id); };
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const childProcs: ChildProcess[] = [];
let ws: WebSocket | null = null;
async function killStale() {
  spawn("pkill", ["-9", "-f", "citizens/citizen.ts"]);
  spawn("pkill", ["-9", "-f", "sim/sim-server"]);
  await sleep(800);
}
async function cleanup() {
  try { ws?.close(); } catch { /* */ }
  for (const p of childProcs) { try { p.kill("SIGKILL"); } catch { /* */ } }
  await killStale();
}

async function main() {
  let pass = true;
  const fail = (m: string) => { pass = false; console.log(`  ✗ ${m}`); };
  const ok = (m: string) => console.log(`  ✓ ${m}`);

  await killStale();
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  await post("/control", { action: "start", duration: { kind: "minutes", value: 2 } });
  // Reproduce the operator's exact scenario: disable B (courier), like the demo run.
  await post("/control", { action: "set-agent", id: B, enabled: false });
  ok(`sim up; ${B} disabled (the operator's case)`);

  // ── (1) THE BUG: A (barista) far from B (courier, disabled) → say must be REJECTED + NOT on the feed. ──
  console.log("\n== (1) cross-map say is rejected at the single writer (/event) ==");
  const a0 = await posOf(A), b0 = await posOf(B);
  const farEnough = a0 && b0 && cheb(a0, b0) > 1;
  farEnough ? ok(`${A} and ${B} start non-adjacent (Cheb ${cheb(a0, b0)})`) : fail(`${A}/${B} unexpectedly adjacent at spawn — test needs them apart`);
  const saysBefore = sayEvents().length;
  const r1 = await post("/event", { actor: A, kind: "say", payload: { to: B, text: "Spill it, courier.", turn: 1 } });
  await sleep(200);
  r1 && r1.ok === false && r1.rejected === "not_adjacent"
    ? ok(`/event say ${A}→${B} REJECTED (not_adjacent): "${r1.note}"`)
    : fail(`/event say ${A}→${B} was NOT rejected — ${JSON.stringify(r1)} (⚠ the gate is missing or only on /act, not /event — the feed bug persists!)`);
  const saysAfter = sayEvents().length;
  saysAfter === saysBefore ? ok("no `say` event landed on the feed (the visible bug is gone) ✓") : fail(`a say event WAS recorded (${saysBefore}→${saysAfter}) — barista→courier would still show on the feed!`);

  // ── (2) ADJACENT say still works (don't break legit talk + the feed). Use two ENABLED, co-located agents. ──
  console.log("\n== (2) an adjacent say is accepted + recorded (legit talk still works) ==");
  const C = "baker", D = "grocer"; // both enabled by default; walk them together
  const dPos = await posOf(D);
  if (dPos) await post("/act", { agent: C, action: "moveTo", x: dPos.x + 1, y: dPos.y });
  let adj = false;
  for (let i = 0; i < 40 && !adj; i++) { const c = await posOf(C), d = await posOf(D); if (c && d && cheb(c, d) <= 1) adj = true; else await sleep(500); }
  adj ? ok(`${C} is adjacent to ${D}`) : fail(`could not get ${C} adjacent to ${D}`);
  const saysBefore2 = sayEvents().length;
  const r2 = await post("/event", { actor: C, kind: "say", payload: { to: D, text: "Morning! Fresh bread's up.", turn: 2 } });
  await sleep(200);
  r2 && r2.ok !== false ? ok(`/event say ${C}→${D} ACCEPTED (adjacent)`) : fail(`/event say ${C}→${D} was wrongly rejected — ${JSON.stringify(r2)} (the gate is too strict; it broke legit talk!)`);
  sayEvents().length === saysBefore2 + 1 ? ok("the adjacent say WAS recorded (feed still works) ✓") : fail("the adjacent say was not recorded — the gate broke legit talk");

  // ── (3) W2b /dialogue is unaffected (not gated). ──
  console.log("\n== (3) W2b /dialogue path is untouched ==");
  const r3 = await post("/dialogue", { op: "record", summary: { id: "t13-probe", participants: [C, D], topic: "bread", turns: 2, outcome: "conversed" } });
  r3 && r3.ok ? ok("/dialogue record still accepted (W2b walk-up-and-talk untouched) ✓") : fail(`/dialogue was affected — ${JSON.stringify(r3)} (must NOT touch the W2b path!)`);

  console.log(`\n${pass ? "✅ TASK-13 PASS" : "❌ TASK-13 FAIL"} — talk() ${pass ? "is grounded in proximity: cross-map say rejected at /event (off the feed); adjacent say works; W2b untouched." : "NOT fully fixed (see ✗ above)."}`);
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
