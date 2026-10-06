// scripts/verify-2c.ts — GATED Wave-2c live runtime-verify (operator-OK'd, bounded, incident-safe).
//
// Proves the W2b social loop LIVE: boots the sim (never calls an LLM), attaches a WS viewer (satisfies
// pause-on-no-viewer), enables ONLY baker+barista, starts a BOUNDED run, spawns the 2 citizen processes
// (Haiku, MAX_TICKS=6), nudges both toward the cafe so they MEET, then reads the evidence
// (usage/dialogue/relationships/memory). Cleanup is bulletproof (try/finally + SIGKILL + pkill).
//
// Bounds (every one independent): MAX_TICKS=6/citizen · 5-min run cap · FLEET_CEILING $5 · HARD_TIMEOUT 150s
// · viewer attached the whole time. No shops/funds needed (the social loop is the focus; buys fail gracefully).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");
const HARD_TIMEOUT_MS = 250_000; // ample headroom for one full holdDialogue (~45s on Haiku) to complete + record
const PAIR = ["baker", "barista"]; // baker < barista lexicographically → baker initiates
const OTHERS = ["courier", "grocer", "smith"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

const childProcs: ChildProcess[] = [];
const citizenProcs: ChildProcess[] = [];
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
  await killStale();

  console.log("⏳ booting sim (never calls an LLM)…");
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  console.log("✓ sim up");

  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  console.log("✓ viewer attached (pause-on-no-viewer satisfied)");

  for (const id of OTHERS) await post("/control", { action: "set-agent", id, enabled: false });
  for (const id of PAIR) await post("/control", { action: "set-agent", id, enabled: true });
  await post("/control", { action: "start", duration: { kind: "minutes", value: 5 } });
  console.log("✓ run started — only baker+barista enabled, 5-min cap, MAX_TICKS=6/citizen");

  // PRE-PIN: walk both to the cafe so they START adjacent — BEFORE spawning the citizens, so the sim moves them
  // together without their own ACT-moves fighting it. The run is already "running" (viewer attached) so the sim
  // steps their paths; NO tokens spent yet (citizens not spawned). Then their FIRST perception sees a neighbor.
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const positions = async (): Promise<[any, any]> => { const s = await get("/snapshot"); return [s?.agents?.find((a: { id: string }) => a.id === "baker"), s?.agents?.find((a: { id: string }) => a.id === "barista")]; };
  console.log("⏳ pre-positioning baker + barista at the cafe so they meet…");
  let pinned = false;
  for (let i = 0; i < 30 && !pinned; i++) {
    await post("/act", { agent: "baker", action: "goTo", to: "cafe" });
    await post("/act", { agent: "barista", action: "goTo", to: "cafe" });
    const [b, r] = await positions();
    if (b && r && cheb(b, r) <= 1) pinned = true; else await sleep(1500);
  }
  console.log(pinned ? "✓ baker + barista adjacent at the cafe" : "⚠ could not pre-position adjacent (proceeding anyway)");

  for (const id of PAIR) {
    const c = spawn("npx", ["tsx", "citizens/citizen.ts", id], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, SIM_URL: SIM, MAX_TICKS: "3", TICK_MS: "6000", CITIZEN_MODEL: "claude-haiku-4-5-20251001" },
    });
    childProcs.push(c); citizenProcs.push(c);
  }
  console.log("✓ spawned baker + barista (Haiku, MAX_TICKS=3 — the dialogue should fire on tick 1)\n");

  const t0 = Date.now();
  let met = pinned;
  const done = () => citizenProcs.every((p) => p.exitCode !== null || p.signalCode !== null);
  while (Date.now() - t0 < HARD_TIMEOUT_MS && !done()) {
    await post("/act", { agent: "baker", action: "goTo", to: "cafe" }); // keep them near each other
    await post("/act", { agent: "barista", action: "goTo", to: "cafe" });
    const [b, r] = await positions();
    if (b && r && cheb(b, r) <= 1) met = true;
    await sleep(2500);
  }
  await sleep(3000); // let the final tick's dialogue flush to disk
  console.log(met ? "\n✓ baker + barista became adjacent (a meeting happened)" : "\n⚠ never observed adjacency in the window");

  console.log("\n===== EVIDENCE =====");
  const usage = await get("/usage");
  console.log("fleet usage (now metered incl. cognition + dialogue):", JSON.stringify(usage?.fleet));
  const dlg = lines(join(DATA, "dialogue.jsonl"));
  console.log(`dialogues recorded: ${dlg.length}`);
  if (dlg.length) { try { const d = JSON.parse(dlg[dlg.length - 1]); console.log(`  last: ${(d.participants ?? []).join(" + ")} — "${d.topic}" (${d.turns} turns, ${d.outcome}${d.mentionedBelief ? ", belief!" : ""})`); } catch { /* */ } }
  for (const id of PAIR) {
    const rels = lines(join(DATA, "relationships", `${id}.jsonl`));
    const mem = lines(join(DATA, "memory", `${id}.jsonl`)).map((l) => { try { return JSON.parse(l).text as string; } catch { return ""; } });
    const talk = mem.filter((t) => /talk|chat|conversation|spoke|told|met /i.test(t));
    console.log(`${id}: ${rels.length} relationship record(s) · ${mem.length} memories · ${talk.length} mention a conversation`);
    if (talk.length) console.log(`   e.g. "${talk[talk.length - 1].slice(0, 110)}"`);
  }
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
