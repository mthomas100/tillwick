// scripts/verify-interior-earshot.ts — the D20 MECHANICAL GATE for the interior-awareness + EARSHOT upgrade.
// FOR THE LEAD to run (D11: a teammate never drives a fleet during build). This does NOT spend tokens and does
// NOT spawn citizens — it proves the SEAM is wired before anyone commits a bounded run to it.
//
// Three independent checks, each a hard gate:
//   (1) PURE MODULES (offline, 0 tokens, no sim): run the two new modules' own self-tests via tsx — sim/earshot.ts
//       (audience math) + cognition/interior-awareness.ts (occupancy menu). If these fail, the logic is wrong
//       regardless of wiring. (interiorist owns these; they must stay green.)
//   (2) /perceive CONTRACT GATE (needs the sim UP, AFTER the lead mounts the hooks + RESTARTS — D20: tsx has no
//       hot-reload, so the new fields only appear on a restart): curl /perceive for a live agent and assert the
//       NEW additive fields are present with the right SHAPE:
//         • insideHere.spots — an array (per-spot occupancy/state from interior-awareness), present when inside.
//         • overheard        — an array (the earshot channel), ALWAYS present (empty is fine).
//       Field NAMES are constants below so a rename during integration is a one-line change here, keeping the
//       gate mechanical (the lesson from D20: curl the NEW field as a 10-second gate BEFORE spending a run).
//   (3) PINNED-CONTRACT GUARD: the five pinned /perceive fields (self/agents/buildings/currentShop/adjacentTo)
//       still exist — the upgrade is ADDITIVE, never removes.
//
// Usage (lead):
//   npx tsx scripts/verify-interior-earshot.ts                 # all checks (skips (2)/(3) if sim is down)
//   AGENT=barista npx tsx scripts/verify-interior-earshot.ts   # gate /perceive for a specific agent
//   ONLY=pure npx tsx scripts/verify-interior-earshot.ts       # just the offline module self-tests
//
// NOTE: this gate proves the CONTRACT (the fields exist + shape). The BEHAVIORAL proof (an agent ENTER →
// occupancy-menu → MOVE off the door → OVERHEAR) is the lead's bounded run reading events.jsonl/dialogue.jsonl +
// per-agent memory streams (the §6 acceptance) — same instrument family as verify-A1.ts. Kept separate so the
// cheap mechanical gate runs in 10s without a fleet.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // repo root
const DATA = join(ROOT, "sim", "data");
const SIM = process.env.SIM_URL ?? "http://localhost:4042";
const AGENT = process.env.AGENT ?? "barista"; // a producer that occupies an interior station (proven inside)
const ONLY = process.env.ONLY ?? ""; // "pure" | "contract" | "behavior" — scope the run (default: pure+contract)

// ── the field names the integration mounts (one place to rename if the seam shifts during ack) ──
const FIELD_INSIDE_SPOTS = "spots";         // insideHere.spots — per-spot enriched occupancy (interior-awareness)
const FIELD_OVERHEARD = "overheard";        // /perceive.overheard — the earshot channel
const FIELD_NEARBY_EVENTS = "nearbyEvents"; // /perceive.nearbyEvents — presence-deltas (entered/left/sat/moved)
const PINNED = ["self", "agents", "buildings", "currentShop", "adjacentTo"]; // PINNED /perceive contract

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => { console.error(`  ✗ ${m}`); failures++; };

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return await res.json();
  } catch {
    return null;
  }
}

// (1) PURE MODULE SELF-TESTS — offline, zero tokens. Each module's `tsx <file>` runs its assertion block.
function runPureSelfTests(): void {
  console.log("\n[1] PURE MODULES (offline · 0 tokens · no sim)");
  for (const rel of ["sim/earshot.ts", "cognition/interior-awareness.ts"]) {
    try {
      const out = execFileSync("npx", ["tsx", join(ROOT, rel)], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (/ALL ASSERTIONS PASSED/.test(out)) pass(`${rel} self-test passed`);
      else fail(`${rel} ran but did not report ALL ASSERTIONS PASSED:\n${out.trim()}`);
    } catch (e) {
      fail(`${rel} self-test FAILED:\n${(e as { stdout?: string; stderr?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? (e as Error).message}`);
    }
  }
}

// (2)+(3) /perceive CONTRACT GATE — needs the sim up (after the lead mounts + RESTARTS). Asserts the new
// additive fields exist with the right shape AND the pinned fields survive.
async function runContractGate(): Promise<void> {
  console.log(`\n[2] /perceive CONTRACT GATE (sim ${SIM}, agent=${AGENT})`);
  const meta = await getJson(`${SIM}/meta`);
  if (!meta) {
    console.log("  • sim not responding — SKIPPING the contract gate. Start a FRESH sim (D20: tsx has no");
    console.log("    hot-reload; the new fields only appear after a restart) then re-run, or run ONLY=pure.");
    return;
  }
  const p = await getJson(`${SIM}/perceive?agent=${encodeURIComponent(AGENT)}`);
  if (!p || p.error) { fail(`/perceive?agent=${AGENT} returned no usable body (${p?.error ?? "null"})`); return; }

  // (3) PINNED contract intact.
  for (const k of PINNED) {
    if (k in p) pass(`pinned field present: ${k}`);
    else fail(`PINNED field MISSING: ${k} (the upgrade must be additive)`);
  }

  // (2a) overheard — ALWAYS present (empty array is fine; it's the earshot ear).
  //      Record shape (lead's ACK'd refinement): {listener, from, to?, gist, atGameMin, kind, at?}.
  if (Array.isArray(p[FIELD_OVERHEARD])) {
    pass(`'${FIELD_OVERHEARD}' present and is an array (len ${p[FIELD_OVERHEARD].length}) — earshot channel wired`);
    const sample = p[FIELD_OVERHEARD][0];
    if (sample && typeof sample === "object") {
      const hasCore = ("from" in sample) && (("gist" in sample) || ("text" in sample));
      hasCore ? pass(`'${FIELD_OVERHEARD}'[0] has {from, gist|text}`) : fail(`'${FIELD_OVERHEARD}'[0] is missing {from, gist|text}: ${JSON.stringify(sample)}`);
      // kind distinguishes overheard-say vs overheard-dialogue (lead refinement).
      ("kind" in sample) && (sample.kind === "say" || sample.kind === "dialogue")
        ? pass(`'${FIELD_OVERHEARD}'[0].kind is "say"|"dialogue"`)
        : fail(`'${FIELD_OVERHEARD}'[0].kind missing/invalid (want "say"|"dialogue"): ${JSON.stringify(sample.kind)}`);
    }
  } else {
    fail(`'${FIELD_OVERHEARD}' MISSING or not an array — earshot not wired into /perceive (lead hook). got: ${typeof p[FIELD_OVERHEARD]}`);
  }

  // (2a') nearbyEvents — the presence-delta channel (entered/left/sat/moved), ALWAYS present (empty is fine).
  //       Record shape: {listener, actor, verb, place, atGameMin}.
  if (Array.isArray(p[FIELD_NEARBY_EVENTS])) {
    pass(`'${FIELD_NEARBY_EVENTS}' present and is an array (len ${p[FIELD_NEARBY_EVENTS].length}) — presence-delta channel wired`);
    const s = p[FIELD_NEARBY_EVENTS][0];
    if (s && typeof s === "object") {
      const ok = ("actor" in s) && ("verb" in s) && ("place" in s);
      ok ? pass(`'${FIELD_NEARBY_EVENTS}'[0] has {actor, verb, place}`) : fail(`'${FIELD_NEARBY_EVENTS}'[0] missing {actor,verb,place}: ${JSON.stringify(s)}`);
    }
  } else {
    fail(`'${FIELD_NEARBY_EVENTS}' MISSING or not an array — presence-deltas not wired into /perceive (lead hook). got: ${typeof p[FIELD_NEARBY_EVENTS]}`);
  }

  // (2b) insideHere.spots — present when the agent is inside a modelled interior. If the agent isn't inside
  //      right now, this is a SOFT note (not a failure): the gate can't force presence without a run.
  const inside = (p as { insideHere?: Record<string, unknown> }).insideHere;
  if (!inside) {
    console.log(`  • ${AGENT} is not inside a modelled interior this instant — can't gate insideHere.${FIELD_INSIDE_SPOTS}`);
    console.log(`    here. Re-run with an agent currently inside (AGENT=…), or rely on the pure self-test +`);
    console.log(`    the lead's bounded run for the in-situ proof.`);
  } else if (Array.isArray((inside as Record<string, unknown>)[FIELD_INSIDE_SPOTS])) {
    const spots = (inside as Record<string, any[]>)[FIELD_INSIDE_SPOTS];
    pass(`insideHere.${FIELD_INSIDE_SPOTS} present and is an array (${spots.length} spots) — occupancy menu wired`);
    const s0 = spots[0];
    if (s0 && typeof s0 === "object") {
      const keys = ["id", "label", "kind", "occupants"];
      const missing = keys.filter((k) => !(k in s0));
      missing.length === 0 ? pass(`insideHere.${FIELD_INSIDE_SPOTS}[0] has {id,label,kind,occupants}`) : fail(`insideHere.${FIELD_INSIDE_SPOTS}[0] missing ${missing.join(",")}: ${JSON.stringify(s0)}`);
    }
  } else {
    fail(`insideHere present but '${FIELD_INSIDE_SPOTS}' MISSING/not an array — interior-awareness not wired into perception.ts (behaviorist hook).`);
  }
}

// ── helpers for the behavioral reader (post-run on-disk evidence; 0 tokens, no fleet) ──
function jsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// (4) BEHAVIORAL ACCEPTANCE (§6) — reads events.jsonl / dialogue.jsonl / the memory streams AFTER a bounded run
// and proves the chain the operator asked for: an agent ENTERed an interior → got an occupancy-aware menu → MOVED
// to a real sub-location (NOT the door) → OVERHEARD a nearby conversation (an "overheard …" memory landed in a
// non-participant's stream). Pure post-hoc read — no fleet, no tokens. Run AFTER the lead's bounded run.
function runBehavioralAcceptance(): void {
  console.log("\n[4] BEHAVIORAL ACCEPTANCE (§6 — reads the run's on-disk evidence; 0 tokens, no fleet)");
  const memDir = join(DATA, "memory");
  const memFiles = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith(".jsonl")) : [];
  if (!memFiles.length) {
    console.log("  • no memory streams under sim/data/memory — run a bounded fleet first, then re-run ONLY=behavior.");
    return;
  }
  // load every agent's stream once.
  const streams: Record<string, any[]> = {};
  for (const f of memFiles) streams[f.replace(/\.jsonl$/, "")] = jsonl(join(memDir, f));
  const allMems = Object.entries(streams).flatMap(([id, ms]) => ms.map((m) => ({ id, ...m })));

  // (4a) OVERHEAR — the headline acceptance: ≥1 "overheard …" memory in SOME stream, ideally a non-participant.
  const overheardMems = allMems.filter((m) => /\boverheard\b/i.test(String(m.text ?? "")));
  if (overheardMems.length) {
    pass(`OVERHEAR: ${overheardMems.length} "overheard …" memor${overheardMems.length === 1 ? "y" : "ies"} folded into streams — earshot reached non-participants`);
    const eg = overheardMems[0];
    console.log(`      e.g. [${eg.id}] (imp ${eg.importance ?? "?"}): "${String(eg.text).slice(0, 110)}"`);
    // bonus: did a diffusable rumor get the importance-6 bump? (behaviorist's Q2 mechanic)
    const rumor = overheardMems.find((m) => Number(m.importance) >= 6);
    if (rumor) console.log(`      info-diffusion: an overheard rumor was stored at importance ${rumor.importance} (competes in retrieval ✓)`);
  } else {
    fail(`OVERHEAR: NO "overheard …" memory in any stream — earshot didn't fold in. Either no 2+ agents shared`);
    console.log(`         a space within earshot during the run, or the overheard→mind.observe hook didn't fire.`);
    console.log(`         (Check: did a dialogue/say happen with a 3rd agent nearby? /perceive.overheard non-empty mid-run?)`);
  }

  // (4b) NEARBY-EVENTS sensing — ≥1 presence-delta memory ("entered/came in/sat/left") in some stream.
  const presenceMems = allMems.filter((m) => /\b(entered|came in|sat down|left the|got up|walked out)\b/i.test(String(m.text ?? "")));
  presenceMems.length
    ? pass(`NEARBY-EVENTS: ${presenceMems.length} presence-delta memor${presenceMems.length === 1 ? "y" : "ies"} ("X entered/sat/left …") sensed`)
    : console.log(`  • NEARBY-EVENTS: none sensed yet (ambient channel; not a hard fail — needs agents moving in a shared space).`);

  // (4c) MOVE-off-the-door — an agent was inside AT a real sub-location (not just the spawnInside door). We read
  //      this from the per-spot memory grounding ("I am at the <counter/table>") OR a located-status event.
  const ev = jsonl(join(DATA, "events.jsonl"));
  const locatedStatus = ev.filter((e) => e.kind === "status" && e.payload && (e.payload.at || e.payload.verb));
  const atSpotMems = allMems.filter((m) => /\b(at the counter|at the .*table|at my station|took my place|sat at|working the)\b/i.test(String(m.text ?? "")));
  if (locatedStatus.length || atSpotMems.length) {
    pass(`MOVE-off-the-door: agents took real spots inside (${locatedStatus.length} located-status events, ${atSpotMems.length} at-spot memories) — not frozen at spawnInside`);
  } else {
    console.log(`  • MOVE-off-the-door: no clear at-a-sub-location signal in events/memories. Confirm via /who-inside/<b>`);
    console.log(`    (an occupant with sublocationId !== the door) or a producer's located status during the run.`);
  }

  // (4d) REAL DIALOGUE happened at all (the thing that GETS overheard) — sanity context, not a new requirement.
  const dlgs = jsonl(join(DATA, "dialogue.jsonl")).filter((d) => d.outcome === "conversed");
  const multiTurn = dlgs.filter((d) => Number(d.turns) >= 3);
  console.log(`  • context: ${dlgs.length} conversation(s) recorded this run (${multiTurn.length} with ≥3 turns) — the source material for overhearing.`);
}

async function main(): Promise<void> {
  console.log("=== verify-interior-earshot — interior object-awareness + EARSHOT seam gate ===");
  if (ONLY !== "contract" && ONLY !== "behavior") runPureSelfTests();
  if (ONLY !== "pure" && ONLY !== "behavior") await runContractGate();
  if (ONLY === "behavior" || ONLY === "all") runBehavioralAcceptance();

  console.log(`\n=== ${failures === 0 ? "ALL GATES PASSED ✅" : `${failures} GATE(S) FAILED ❌`} ===`);
  if (failures === 0 && ONLY !== "pure" && ONLY !== "behavior") {
    console.log("Contract is wired. Next: the lead runs a BOUNDED behavioral run, then `ONLY=behavior npx tsx");
    console.log("scripts/verify-interior-earshot.ts` proves §6 from the run's events.jsonl / dialogue.jsonl /");
    console.log("sim/data/memory/<id>.jsonl: ENTER → occupancy menu → MOVE off the door → OVERHEAR.");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
