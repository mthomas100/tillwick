import "dotenv/config";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCitizens } from "../lib.js";
import { PERSONAS } from "../citizens/personas.js";

// ── npm run inspect [-- <id|all>] ───────────────────────────────────────────────────────────────────────
// FULL INNER-LIFE INSPECTION of a citizen (or `all`) — read straight off sim/data, ZERO tokens. Answers
// "aren't they complex? show me their memory + quirks + the config that makes each who they are." For each
// citizen it prints: IDENTITY (id/address/wallet/model/enabled), PERSONA (the systemPrompt + economic needs
// = the config that defines them), MEMORY STREAM (counts + the highest-poignancy observations, the reflection
// TREE with inline citations, today's PLAN), RELATIONSHIPS (the social graph edges), ECONOMY (spent/earned/
// trades), and where its LIVE SDK session files are. NEVER prints private keys.
//
// Usage:
//   npm run inspect                 # one-screen summary of ALL citizens
//   npm run inspect -- grocer       # deep dive on one citizen
//   npm run inspect -- all --full   # every citizen, full memory dump

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/
const ROOT = dirname(HERE); // repo root
const DATA = join(ROOT, "sim", "data");
const MEM_DIR = join(DATA, "memory");
const REL_DIR = join(DATA, "relationships");
const AGENT_DIR = join(DATA, "agents");
const EVENTS = join(DATA, "events.jsonl");
const ROSTER = join(DATA, "roster-state.json");
const SESS_DIR = join(
  process.env.HOME ?? "",
  ".claude",
  "projects",
  // Claude Code names a project dir after its absolute cwd, every non-alphanumeric char -> "-".
  ROOT.replace(/[^A-Za-z0-9]/g, "-"),
);

const argv = process.argv.slice(2);
const full = argv.includes("--full");
const target = argv.find((a) => !a.startsWith("--")) ?? "all";

type Mem = { id: string; kind: string; text: string; createdAt: number; lastAccess: number; importance: number; citations?: string[] };
type Rel = { other: string; familiarity: number; dialogues: number; coPresences: number; tradesAsBuyer: number; tradesAsSeller: number; usdcBought: number; usdcSold: number; topics?: string[] };

const C = { dim: "\x1b[2m", b: "\x1b[1m", cyan: "\x1b[36m", yel: "\x1b[33m", grn: "\x1b[32m", mag: "\x1b[35m", red: "\x1b[31m", off: "\x1b[0m" };
const h = (s: string) => `\n${C.b}${C.cyan}━━ ${s} ━━${C.off}`;
const sub = (s: string) => `${C.b}${s}${C.off}`;

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function roster(): Record<string, { enabled?: boolean; model?: string }> {
  try {
    return JSON.parse(readFileSync(ROSTER, "utf8"));
  } catch {
    return {};
  }
}

// Which ~/.claude SDK session files belong to this citizen? (grep the persona marker — each tick is a fresh
// session file, so we report the count + newest.) Cheap heuristic; bounded to the last ~200 files by mtime.
function sessionFilesFor(id: string): { count: number; newest: string | null; newestMtime: number } {
  if (!existsSync(SESS_DIR)) return { count: 0, newest: null, newestMtime: 0 };
  const marker = PERSONAS[id]?.system.slice(0, 28); // e.g. "You are the town baker" prefix
  if (!marker) return { count: 0, newest: null, newestMtime: 0 };
  let files: { f: string; m: number }[];
  try {
    files = readdirSync(SESS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: join(SESS_DIR, f), m: statSync(join(SESS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 200); // only the most-recent 200 — enough to find the live ones; avoids scanning 7k files
  } catch {
    return { count: 0, newest: null, newestMtime: 0 };
  }
  let count = 0;
  let newest: string | null = null;
  let newestMtime = 0;
  for (const { f, m } of files) {
    try {
      // read a small head — the persona is in an early prompt; avoids slurping a 90KB file
      const head = readFileSync(f, "utf8").slice(0, 60_000);
      if (head.includes(marker)) {
        count++;
        if (m > newestMtime) {
          newestMtime = m;
          newest = f;
        }
      }
    } catch {
      /* skip */
    }
  }
  return { count, newest, newestMtime };
}

function economyFor(id: string): { spent: number; earned: number; buys: number; consumes: number; moves: number; says: number; topPartners: string[] } {
  const ev = readJsonl<{ actor?: string; kind?: string; payload?: Record<string, unknown> }>(EVENTS);
  let spent = 0,
    earned = 0,
    buys = 0,
    consumes = 0,
    moves = 0,
    says = 0;
  const partners: Record<string, number> = {};
  for (const e of ev) {
    const p = e.payload ?? {};
    if (e.kind === "purchase" && e.actor === id) {
      spent += Number(p.price_usdc ?? 0);
      buys++;
      const cp = String(p.counterparty ?? "");
      if (cp) partners[cp] = (partners[cp] ?? 0) + 1;
    }
    if (e.kind === "purchase" && p.counterparty === id) {
      earned += Number(p.price_usdc ?? 0);
      const cp = String(e.actor ?? "");
      if (cp) partners[cp] = (partners[cp] ?? 0) + 1;
    }
    if (e.actor === id && e.kind === "consume") consumes++;
    if (e.actor === id && e.kind === "move") moves++;
    if (e.actor === id && e.kind === "say") says++;
  }
  const topPartners = Object.entries(partners)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}×${v}`);
  return { spent: +spent.toFixed(4), earned: +earned.toFixed(4), buys, consumes, moves, says, topPartners };
}

function inspectOne(id: string): void {
  const cz = loadCitizens().find((c) => c.id === id);
  const persona = PERSONAS[id];
  const r = roster()[id] ?? {};
  const mems = readJsonl<Mem>(join(MEM_DIR, `${id}.jsonl`));
  const rels = readJsonl<Rel>(join(REL_DIR, `${id}.jsonl`));
  const sess = sessionFilesFor(id);
  const econ = economyFor(id);

  console.log(`\n${C.b}${C.mag}╔══ CITIZEN: ${id.toUpperCase()} ══╗${C.off}`);

  // IDENTITY + CONFIG (the files that make them who they are)
  console.log(h("IDENTITY & CONFIG"));
  console.log(`  ${sub("wallet")}    ${cz?.address ?? "?"}  ${C.dim}(privateKey in citizens.local.json — never shown)${C.off}`);
  console.log(`  ${sub("model")}     ${r.model ?? "(default)"}   ${sub("enabled")} ${r.enabled === false ? `${C.red}no${C.off}` : `${C.grn}yes${C.off}`}`);
  if (persona) {
    console.log(`  ${sub("persona")}   ${C.yel}${persona.system}${C.off}`);
    console.log(`  ${sub("shop")}      ${persona.shopId}    ${sub("tends to buy")} ${persona.buys.join(", ")}`);
    console.log(`  ${C.dim}↳ defined in citizens/personas.ts (the systemPrompt = this agent's character)${C.off}`);
  }

  // MEMORY STREAM (the mind)
  const byKind = (k: string) => mems.filter((m) => m.kind === k);
  const obs = byKind("observation"),
    refl = byKind("reflection"),
    plans = byKind("plan");
  console.log(h(`MEMORY STREAM — ${mems.length} memories (${obs.length} obs · ${refl.length} reflections · ${plans.length} plans)`));
  console.log(`  ${C.dim}sim/data/memory/${id}.jsonl — observation|reflection|plan, importance 1–10, game-min timestamps${C.off}`);

  if (refl.length) {
    console.log(`\n  ${sub("REFLECTIONS")} ${C.dim}(synthesized higher-level beliefs; "(because of N…)" cites the source memory _seq)${C.off}`);
    for (const m of refl) console.log(`    ${C.grn}⟐${C.off} [imp ${m.importance}] ${m.text}`);
  }
  const todayPlans = plans.slice(-6);
  if (todayPlans.length) {
    console.log(`\n  ${sub("PLAN")} ${C.dim}(daily plan — broad strokes; paper §4.3)${C.off}`);
    for (const m of todayPlans) console.log(`    ${C.cyan}▸${C.off} ${m.text}`);
  }
  const topObs = [...obs].sort((a, b) => b.importance - a.importance).slice(0, full ? obs.length : 6);
  if (topObs.length) {
    console.log(`\n  ${sub(full ? "OBSERVATIONS (all)" : "TOP OBSERVATIONS by poignancy")}`);
    for (const m of topObs) console.log(`    ${C.dim}[imp ${m.importance} @${m.createdAt}m]${C.off} ${m.text.slice(0, full ? 400 : 160)}`);
  }

  // RELATIONSHIPS (the social graph)
  console.log(h(`RELATIONSHIPS — ${rels.length} edge(s)`));
  console.log(`  ${C.dim}sim/data/relationships/${id}.jsonl — familiarity, dialogues, co-presence, trade volume, topics${C.off}`);
  if (rels.length === 0) console.log(`  ${C.dim}(none recorded — W2b walk-up-and-talk under-fired this run; see OBSERVABILITY.md)${C.off}`);
  for (const e of rels.sort((a, b) => b.familiarity - a.familiarity)) {
    console.log(
      `  ${C.mag}↔ ${e.other}${C.off}  familiarity ${e.familiarity.toFixed(2)} · dialogues ${e.dialogues} · co-present ${e.coPresences} · trades ${e.tradesAsBuyer}b/${e.tradesAsSeller}s` +
        (e.topics?.length ? `\n      ${C.dim}topics: ${e.topics.slice(0, 2).join(" | ")}${C.off}` : ""),
    );
  }

  // ECONOMY
  console.log(h("ECONOMY (from events.jsonl)"));
  console.log(
    `  spent ${C.red}$${econ.spent}${C.off} · earned ${C.grn}$${econ.earned}${C.off} · buys ${econ.buys} · consumes ${econ.consumes} · moves ${econ.moves} · says ${econ.says}`,
  );
  if (econ.topPartners.length) console.log(`  ${sub("trade partners")} ${econ.topPartners.join(", ")}`);

  // LIVE SESSION FILES
  console.log(h("LIVE CLAUDE SESSIONS (the SDK query() transcripts)"));
  console.log(`  ${sub("per-tick transcript")} sim/data/agents/${id}.jsonl   ${sub("pretty stream")} sim/data/agents/${id}.log`);
  console.log(
    `  ${sub("~/.claude SDK sessions")} ${sess.count} recent file(s) ${C.dim}(one per TICK — ephemeral; not resumable as a live convo)${C.off}`,
  );
  if (sess.newest) console.log(`    ${C.dim}newest: ${sess.newest.replace(process.env.HOME ?? "", "~")}${C.off}`);
  console.log(`  ${C.dim}↳ watch it live:  npm run observe -- tail --only=${id}${C.off}`);
}

function summaryAll(): void {
  const ids = loadCitizens().map((c) => c.id);
  console.log(`\n${C.b}${C.cyan}CITIZEN ROSTER — inner-life summary${C.off}  ${C.dim}(npm run inspect -- <id> for the deep dive)${C.off}`);
  const r = roster();
  for (const id of ids) {
    const mems = readJsonl<Mem>(join(MEM_DIR, `${id}.jsonl`));
    const rels = readJsonl<Rel>(join(REL_DIR, `${id}.jsonl`));
    const econ = economyFor(id);
    const obs = mems.filter((m) => m.kind === "observation").length;
    const refl = mems.filter((m) => m.kind === "reflection").length;
    const plans = mems.filter((m) => m.kind === "plan").length;
    const persona = PERSONAS[id];
    const oneLiner = persona ? persona.system.replace(/^You are the (town )?/, "").split(".")[0] : "";
    console.log(
      `\n  ${C.b}${C.mag}${id.padEnd(8)}${C.off} ${C.dim}${(r[id]?.model ?? "").replace("claude-", "")}${C.off}  ${oneLiner}`,
    );
    console.log(
      `    mind: ${obs} obs · ${C.grn}${refl} refl${C.off} · ${plans} plans   social: ${rels.length} ties   econ: $${econ.spent} spent / $${econ.earned} earned · ${econ.buys} buys · ${econ.moves} moves`,
    );
  }
  console.log(`\n  ${C.dim}Watch them ALL live in their own windows:  npm run observe -- tail${C.off}`);
}

if (target === "all") {
  summaryAll();
  if (full) for (const c of loadCitizens()) inspectOne(c.id);
} else {
  if (!PERSONAS[target]) {
    console.error(`[inspect] unknown citizen "${target}". Known: ${Object.keys(PERSONAS).join(", ")}, or "all".`);
    process.exit(1);
  }
  inspectOne(target);
}
