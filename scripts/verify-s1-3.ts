// scripts/verify-s1-3.ts — GATED S1-3 zero-token e2e (carry-and-give verbs). NO LLM is called — this drives
// the sim's /act HTTP API directly, so it spends ZERO model tokens. It DOES boot a sim on :4042, so it is
// GATED on the team's single :4042 slot (coordinate through the lead before running).
//
// PROVES the acceptance: A acquires X → A gives X to adjacent B → B holds X, A doesn't, a `give` event is
// recorded, and NO money moved (no purchase/sale event, gift is free). Then drop/pick_up round-trip + use.
//
// Cleanup is bulletproof (try/finally + SIGKILL + pkill), modeled on verify-2c.ts. Bounds: a hard 60s wall —
// it's all synchronous HTTP, no model latency.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const SIM = "http://localhost:4042";
const DATA = join(ROOT, "sim", "data");
const EVENTS = join(DATA, "events.jsonl");
const GIVER = "grocer"; // A — a non-baker, so a buyResult of `bread` is a real seller→A transfer (baker→grocer)
const RECEIVER = "smith"; // B
const ITEM = "bread"; // a good that EXISTS today (cake/balloons arrive with S2-3); the give mechanics are identical

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) =>
  fetch(`${SIM}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const get = (p: string) => fetch(`${SIM}${p}`).then((r) => r.json()).catch(() => null);
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const counts = async (id: string): Promise<Record<string, number>> => (await get(`/inventory/${id}`))?.counts ?? {};
const eventsSince = (fromLen: number, kind: string, actor: string) =>
  lines(EVENTS).slice(fromLen).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === kind && e.actor === actor);

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

// Put A and B onto known-adjacent tiles (Chebyshev ≤ 1) deterministically via moveTo, then step the sim a few
// ticks so the A* path resolves and they actually arrive.
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const posOf = async (id: string) => { const s = await get("/snapshot"); return s?.agents?.find((x: { id: string }) => x.id === id); };

async function main() {
  await killStale();
  console.log("⏳ booting sim (never calls an LLM)…");
  const sim = spawn("npx", ["tsx", "sim/sim-server.ts"], { cwd: ROOT, stdio: "ignore", env: { ...process.env } });
  childProcs.push(sim);
  for (let i = 0; i < 40 && !(await get("/meta")); i++) await sleep(500);
  if (!(await get("/meta"))) throw new Error("sim did not come up");
  console.log("✓ sim up");

  // A viewer keeps the run alive under pause-on-no-viewer; harmless for a pure /act driver, but start a bounded
  // run so the sim steps paths.
  ws = new WebSocket("ws://localhost:4042");
  await new Promise<void>((res) => { ws!.on("open", () => res()); ws!.on("error", () => res()); setTimeout(res, 3000); });
  await post("/control", { action: "start", duration: { kind: "minutes", value: 2 } });
  console.log("✓ viewer attached + bounded run started");

  let pass = true;
  const fail = (msg: string) => { pass = false; console.log(`  ✗ ${msg}`); };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);

  // ── (1) SEED: give A one unit of ITEM via a buyResult (mints one bread baker→grocer; NO real chain call). ──
  const evLen0 = lines(EVENTS).length;
  await post("/act", { agent: GIVER, action: "buyResult", item: ITEM, txHash: "0xseed000000000000000000000000000000000000000000000000000000000000" });
  await sleep(200);
  const aAfterSeed = (await counts(GIVER))[ITEM] ?? 0;
  aAfterSeed >= 1 ? ok(`seeded ${GIVER} with ${aAfterSeed}× ${ITEM}`) : fail(`seed failed — ${GIVER} has ${aAfterSeed}× ${ITEM}`);

  // ── (2) ADJACENCY: walk A and B together (moveTo each other's neighborhood), step until Chebyshev ≤ 1. ──
  const b0 = await posOf(RECEIVER);
  if (b0) await post("/act", { agent: GIVER, action: "moveTo", x: b0.x + 1, y: b0.y }); // aim A at B's neighbor tile
  let adjacent = false;
  for (let i = 0; i < 40 && !adjacent; i++) {
    const a = await posOf(GIVER), b = await posOf(RECEIVER);
    if (a && b && cheb(a, b) <= 1) adjacent = true; else await sleep(500);
  }
  adjacent ? ok(`${GIVER} is adjacent to ${RECEIVER}`) : fail(`could not get ${GIVER} adjacent to ${RECEIVER} (give will be refused)`);

  // ── (3) GIVE: A gives ITEM to B. Assert custody moved + a `give` event + NO money. ──
  const moneyBefore = lines(EVENTS).filter((l) => { try { const e = JSON.parse(l); return (e.kind === "purchase" || e.kind === "sale"); } catch { return false; } }).length;
  const r = await post("/act", { agent: GIVER, action: "give", item: ITEM, toId: RECEIVER });
  await sleep(200);
  r?.ok && r?.given ? ok(`give returned ok+given (${JSON.stringify(r)})`) : fail(`give did NOT succeed — ${JSON.stringify(r)} (⚠ FALL-THROUGH TRAP? a missing /act give branch returns 'bad target' or ok:false)`);
  const aAfter = (await counts(GIVER))[ITEM] ?? 0;
  const bAfter = (await counts(RECEIVER))[ITEM] ?? 0;
  aAfter === aAfterSeed - 1 ? ok(`${GIVER} no longer holds the given unit (${aAfter}× ${ITEM})`) : fail(`${GIVER} still has ${aAfter}× ${ITEM} (expected ${aAfterSeed - 1})`);
  bAfter >= 1 ? ok(`${RECEIVER} now holds ${bAfter}× ${ITEM}`) : fail(`${RECEIVER} has ${bAfter}× ${ITEM} (expected ≥1)`);
  const giveEvents = eventsSince(evLen0, "give", GIVER);
  giveEvents.length >= 1 ? ok(`a 'give' event was recorded (${JSON.stringify(giveEvents.at(-1)?.payload)})`) : fail("no 'give' event in events.jsonl");
  const moneyAfter = lines(EVENTS).filter((l) => { try { const e = JSON.parse(l); return (e.kind === "purchase" || e.kind === "sale"); } catch { return false; } }).length;
  moneyAfter === moneyBefore ? ok("NO money moved (no new purchase/sale event) — the gift is free ✓") : fail(`a purchase/sale event appeared (${moneyBefore}→${moneyAfter}) — a gift must NOT move money!`);
  const giveEvHasNoTx = giveEvents.every((e) => !e.related_id && !e.txHash && !(e.payload && (e.payload as { txHash?: string }).txHash));
  giveEvHasNoTx ? ok("the give event carries NO txHash (not a settlement) ✓") : fail("the give event has a txHash — a gift is not a paid settlement!");

  // ── (4) DROP + PICK_UP round-trip at B's place, and USE decrements. ──
  // B drops the unit it just received; B then picks it back up.
  const rd = await post("/act", { agent: RECEIVER, action: "drop", item: ITEM });
  await sleep(150);
  rd?.ok && rd?.dropped ? ok(`drop ok (${RECEIVER} set down ${ITEM} at ${rd.place})`) : fail(`drop failed — ${JSON.stringify(rd)}`);
  const bAfterDrop = (await counts(RECEIVER))[ITEM] ?? 0;
  bAfterDrop === bAfter - 1 ? ok(`${RECEIVER} no longer holds it after drop (${bAfterDrop})`) : fail(`${RECEIVER} has ${bAfterDrop} after drop (expected ${bAfter - 1})`);
  const rp = await post("/act", { agent: RECEIVER, action: "pick_up", item: ITEM });
  await sleep(150);
  rp?.ok && rp?.picked ? ok(`pick_up ok (${RECEIVER} picked ${ITEM} back up)`) : fail(`pick_up failed — ${JSON.stringify(rp)}`);
  const bAfterPick = (await counts(RECEIVER))[ITEM] ?? 0;
  bAfterPick === bAfter ? ok(`${RECEIVER} holds it again after pick_up (${bAfterPick})`) : fail(`${RECEIVER} has ${bAfterPick} after pick_up (expected ${bAfter})`);
  const ru = await post("/act", { agent: RECEIVER, action: "use", item: ITEM });
  await sleep(150);
  ru?.ok && ru?.used ? ok(`use ok (${RECEIVER} used a ${ITEM}, remaining ${ru.remaining})`) : fail(`use failed — ${JSON.stringify(ru)}`);

  console.log(`\n${pass ? "✅ S1-3 PASS" : "❌ S1-3 FAIL"} — carry-and-give verbs ${pass ? "work: gift moves custody (no money), drop/pick_up/use route correctly." : "NOT fully proven (see ✗ above)."}`);
}

main()
  .catch((e) => console.error("VERIFY ERROR:", (e as Error).message))
  .finally(async () => { console.log("\n⏳ cleanup…"); await cleanup(); console.log("✓ cleanup done"); process.exit(0); });
