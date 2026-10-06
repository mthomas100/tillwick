// scripts/verify-s1-2.ts — GATED S1-2 zero-token e2e (role-specific tool sets + producer verbs). NO LLM is
// called — it asserts the per-role surface from roleToolNames() (pure, no sim) AND drives the sim's /act
// `produce` branch directly over HTTP (zero model tokens). It DOES boot a sim on :4042 for the routing half,
// so it is GATED on the team's single :4042 slot (coordinate through the lead before running).
//
// PROVES: (1) each role boots with its OWN producer verb + the shared core (baker has `bake` not `brew`,
// courier has `deliver` not `bake`); (2) a producer verb routes through /act and actually creates stock in the
// producer's own inventory, with NO money moved (no purchase/sale, no txHash). Bulletproof cleanup (verify-2c
// model).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { roleToolNames } from "../citizens/world-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const EVENTS = join(ROOT, "sim", "data", "events.jsonl");

// role → its expected producer verb + the good it makes (mirrors world.json + the PRODUCER map).
const ROLES: Record<string, { verb: string; good: string }> = {
  baker: { verb: "bake", good: "bread" },
  barista: { verb: "brew", good: "coffee" },
  grocer: { verb: "restock", good: "apple" },
  courier: { verb: "deliver", good: "delivery" },
  smith: { verb: "forge", good: "nail" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const counts = async (id: string): Promise<Record<string, number>> => (await get(`/inventory/${id}`))?.counts ?? {};

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

  // ── (1) PER-ROLE SURFACE — pure, no sim needed. Each role has its OWN verb + the core, not others' verbs. ──
  console.log("== (1) per-role tool surface (roleToolNames — pure) ==");
  const verbs = Object.values(ROLES).map((r) => r.verb);
  for (const [id, { verb }] of Object.entries(ROLES)) {
    const names = roleToolNames(id).map((n) => n.replace("mcp__world__", ""));
    names.includes(verb) ? ok(`${id} surfaces '${verb}'`) : fail(`${id} is MISSING its verb '${verb}'`);
    const intruders = verbs.filter((v) => v !== verb && names.includes(v));
    intruders.length === 0 ? ok(`${id} has no other role's verb`) : fail(`${id} wrongly has ${intruders.join("/")}`);
    ["look", "move", "buy", "talk", "give"].every((c) => names.includes(c)) ? ok(`${id} has the shared core`) : fail(`${id} is missing core tools`);
  }

  // ── (2) PRODUCE ROUTING — boot the sim, drive /act produce, assert stock grew + NO money. ──
  console.log("\n== (2) producer verb routes through /act + creates stock (sim) ==");
  await killStale();
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  await post("/control", { action: "start", duration: { kind: "minutes", value: 2 } });
  ok("sim up + viewer attached");

  const moneyBefore = lines(EVENTS).filter((l) => { try { const e = JSON.parse(l); return e.kind === "purchase" || e.kind === "sale"; } catch { return false; } }).length;
  for (const [id, { good }] of Object.entries(ROLES)) {
    const before = (await counts(id))[good] ?? 0;
    const r = await post("/act", { agent: id, action: "produce", good });
    await sleep(120);
    const after = (await counts(id))[good] ?? 0;
    r?.ok && r?.produced ? ok(`${id} produce routed (ok+produced)`) : fail(`${id} produce did NOT route — ${JSON.stringify(r)} (⚠ /act produce branch missing? = fall-through trap)`);
    after === before + 1 ? ok(`${id} now holds +1 ${good} (${before}→${after})`) : fail(`${id} stock did not grow (${before}→${after})`);
  }
  const produceEvents = lines(EVENTS).filter((l) => { try { return JSON.parse(l).kind === "produce"; } catch { return false; } }).length;
  produceEvents >= Object.keys(ROLES).length ? ok(`${produceEvents} 'produce' events recorded`) : fail(`only ${produceEvents} produce events (expected ≥${Object.keys(ROLES).length})`);
  const moneyAfter = lines(EVENTS).filter((l) => { try { const e = JSON.parse(l); return e.kind === "purchase" || e.kind === "sale"; } catch { return false; } }).length;
  moneyAfter === moneyBefore ? ok("NO money moved (no purchase/sale event) — producing is free ✓") : fail(`a purchase/sale appeared (${moneyBefore}→${moneyAfter}) — producing must not move money!`);

  console.log(`\n${pass ? "✅ S1-2 PASS" : "❌ S1-2 FAIL"} — role-specific tool sets ${pass ? "work: each role has its own producer verb + the core; producing creates stock with no money." : "NOT fully proven (see ✗ above)."}`);
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
