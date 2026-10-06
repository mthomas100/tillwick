import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadCitizens } from "../lib.js";
import { makeWorldServer, renderTick, priceOf, roleToolNames, takeTurnOutcome } from "./world-tools.js";
import { personaFor } from "./personas.js";
import { seedAgentMemories } from "./seed.js";
import { canBuy } from "./guard.js";
import { auditWrite, logPretty } from "./audit.js";
import { fetchDirective, extractUsage, reportUsage, sleep, type UsageSample } from "./runtime.js";
import { Mind } from "../cognition/mind.js";
import { makeClaudeComplete } from "./claude-complete.js";
import { agendaLines } from "./schedules.js";
import { embed } from "../cognition/embeddings.js";
import { SocialStep } from "./social-step.js";
import { RelationshipGraph } from "../cognition/relationships.js";
import { appendTrace, traceRetrieved } from "../cognition/trace.js";
import { checkAuth } from "./auth.js";

// One citizen = one process: `tsx citizens/citizen.ts <id>`.
// Each tick: OBEY the sim's run-state governor (the INC-2026-06-18 fix — never spend a token unless the
// sim says we're runnable), then perceive (renderTick) → Claude reasons → calls world tools → report usage.

// ---- Seam A: auth. ANTHROPIC_API_KEY by default; a subscription login only as an explicit opt-in. ----
checkAuth(process.argv[2] ?? "citizen");
// S0-1: stop the claude.ai cloud MCP connectors (Gmail/Calendar/Drive) from loading into the citizen session.
// They ride in via a subscription login and are NOT Claude-Code built-ins, so `tools:[]`/`settingSources:[]` miss
// them. The spawned CLI inherits process.env (options.env is omitted), so setting it here reaches the binary.
process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

const id = process.argv[2];
if (!id) throw new Error("usage: tsx citizens/citizen.ts <citizenId>");
const me = loadCitizens().find((c) => c.id === id);
if (!me) throw new Error(`unknown citizen "${id}" — not in citizens.local.json`);
process.env.BUYER_PRIVATE_KEY = me.privateKey; // this process holds ONLY its own key

const persona = personaFor(id);
const world = makeWorldServer(id);
const TICK_MS = Number(process.env.TICK_MS ?? 8000);
const FALLBACK_MODEL = process.env.CITIZEN_MODEL ?? "claude-haiku-4-5-20251001";
const SIM_URL = process.env.SIM_URL ?? "http://localhost:4042";

// Hard backstops BEHIND the sim's run-state governor (which is the PRIMARY bound: pause-on-no-viewer +
// duration + budget ceiling). These are pure runaway guards — the incident loop had NONE of them.
const MAX_TICKS = Number(process.env.MAX_TICKS ?? 0) || Infinity; // 0 ⇒ unbounded (the governor bounds it)
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS ?? 0) || Infinity;
const MAX_CONSEC_FAILURES = Number(process.env.MAX_CONSEC_FAILURES ?? 5); // circuit breaker
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? 2500); // poll cadence while paused / disabled
const startedAt = Date.now();

// S1-2: derive the citizen's allowed tools from its ROLE (core + this role's producer verb), so a courier's
// session can't call `bake`. roleToolNames is the single source shared with the world-tools factory (no drift).
const ALLOWED = roleToolNames(id);

let tick = 0;
let consecFailures = 0;
let gameMinutes = 0; // updated each tick from the sim run-state; feeds Mind.nowGameMin()
// W2b metering: accumulate ALL cognition burn this tick (mind reflection/summary/importance + the dialogue) so the
// fleet budget ceiling sees the WHOLE tick, not just the ACT turn. Reset each tick; reported with the ACT usage.
const zeroAcc = (): UsageSample => ({ apiEquivUsd: 0, tokensIn: 0, tokensOut: 0, cacheWrite: 0, cacheRead: 0 });
let cognitionUsage = zeroAcc();
const onCogUsage = (u: UsageSample) => {
  cognitionUsage.apiEquivUsd += u.apiEquivUsd; cognitionUsage.tokensIn += u.tokensIn; cognitionUsage.tokensOut += u.tokensOut;
  cognitionUsage.cacheWrite += u.cacheWrite; cognitionUsage.cacheRead += u.cacheRead;
};
// D28 NEVER-STUCK: consecutive ticks where NOTHING landed (all world-tool calls blocked, or the ACT turn
// spun out at max-turns with no success). At >=2 the next prompt's TOP branch is "do something different",
// a kind:"stuck" beat hits the tape (D32), and a forced replan runs. Cleared by any tick with a landed action.
let stuckTicks = 0;
let stuckNote: string | undefined;
// D32: emit the plan-step beat once per CHANGE of the schedule step (not per tick).
let lastPlanStepEmitted = "";

// The generative-agent mind for this citizen. Cognition's internal reasoning (importance, reflection,
// planning, summary) runs through the real Claude-backed Complete on the default model; the ACT turn below uses
// the per-agent directive.model. Memory persists per agent under sim/data/memory (resume-with-memory).
// T0 life-spine: the daily plan is seeded from the deterministic schedule template (schedules.ts) at ZERO
// token cost — PLAN_MODE=llm reverts to the paper's generated planDay. summaryEveryGameMin widens the
// summary rebuild from 3 to 6 game-hours: at the measured 2-3 game-hour tick gap (audit A4) the 3h cadence
// rebuilt the summary almost every tick — one more CLI spawn the tick budget can't afford.
const PLAN_MODE = (process.env.PLAN_MODE ?? "template").toLowerCase();
const mind = new Mind({
  agentId: id,
  persona: persona.system,
  traits: persona.traits.join(", "),
  complete: makeClaudeComplete(FALLBACK_MODEL, onCogUsage),
  nowGameMin: () => gameMinutes,
  summaryEveryGameMin: Number(process.env.SUMMARY_EVERY_GAMEMIN ?? 360),
  ...(PLAN_MODE === "llm" ? {} : { planTemplate: () => agendaLines(id) }),
});
// T0 cold-start warming: preload the local embeddings model NOW (token-free — transformers.js on-box), in
// parallel with boot, so the first retrieval doesn't pay the ~15s model load inside tick 1 (audit A4). The
// memoized extractor promise is shared, so the first contextFor() awaits the same load instead of re-running.
// D32: the warming is a tape beat with its MEASURED ms (fire-and-forget; a failed POST never blocks boot).
{
  const warmT0 = Date.now();
  void embed("warm up the retrieval pipeline")
    .then(() => fetch(`${SIM_URL}/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: id, kind: "warming", payload: { what: "embeddings", ms: Date.now() - warmT0 } }) }))
    .catch(() => {});
}
// S1-1: seed this citizen's persona memories into the stream ONCE (idempotent on resume; token-free —
// explicit importance ⇒ no model call) so retrieval/summary/dialogue are grounded from tick 1.
const seeded = seedAgentMemories(mind.stream, persona, { atGameMin: gameMinutes });
console.log(`[${id}] seed memories: ${seeded.seeded} written, ${seeded.skipped} already present`);
// W2b: this citizen's relationship graph (knows-each-other + trade edges). Persists to sim/data/relationships/<id>.jsonl.
const graph = new RelationshipGraph(id, { nowGameMin: () => gameMinutes });
// T0 social weave (socialweaver): the tested superset of the old inline social block — reply-mode dialogues
// (heardRecently → real turn-taking), windowed host election (no lower-id monopoly), relationship-conditioned
// engage, gossip with provenance, opinion drift, plus the trade/co-presence/reflection taps. Takes `graph` by
// reference; owns its own cooldowns/dedup (the old lastConversedWith/processed* locals are gone with it).
const social = new SocialStep({ agentId: id, mind, graph, nowGameMin: () => gameMinutes });
console.log(`[${id}] citizen up (cognition wired) — persona: ${persona.system.slice(0, 60)}…`);
// #16: announce this citizen is ONLINE in the activity feed (a status event — the talk-adjacency gate only gates
// kind:"say", so this status event flows through). Fire-and-forget; a failed POST never blocks boot.
fetch(`${SIM_URL}/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: id, kind: "online", payload: { name: persona.name } }) }).catch(() => {});

// S0-4 hardening: the in-flight tick's trace-flush, so a teardown signal records the cut-off tick before
// exit (forensic 2026-06-20: a duration-elapsed SIGTERM during a slow ~93s tick killed the process between
// reportUsage and the trace write → the slow tick we most want had no health line). `inFlight` is set at
// tick start (above) and cleared in the tick `finally`. Verified: run-all.ts SIGTERM/SIGINT just
// releaseLock()+exit(0) WITHOUT an immediate child SIGKILL, so this handler gets to flush first.
let inFlight: { tick: number; flush: () => void } | null = null;
let flushedOnSignal = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (!flushedOnSignal) { flushedOnSignal = true; try { inFlight?.flush(); } catch { /* never let the flush block exit */ } }
    console.log(`[${id}] ${sig} — flushed in-flight tick trace; exiting.`);
    process.exit(0); // clean exit ⇒ run-all does NOT respawn
  });
}

for (;;) {
  if (tick >= MAX_TICKS) { console.log(`[${id}] MAX_TICKS (${MAX_TICKS}) reached — exiting cleanly.`); break; }
  if (Date.now() - startedAt >= MAX_RUNTIME_MS) { console.log(`[${id}] MAX_RUNTIME reached — exiting cleanly.`); break; }

  // OBEY THE GOVERNOR: only spend a token when the sim says this citizen is runnable (running + enabled).
  // Paused / stopped / disabled / sim-unreachable ⇒ idle poll, ZERO token spend. This is the fleet half of
  // the INC-2026-06-18 fix: closing the GUI pauses the sim ⇒ citizens stop HERE and never call the model.
  const directive = await fetchDirective(id, FALLBACK_MODEL);
  gameMinutes = directive.gameMinutes; // keep cognition's game-clock current (even while paused/disabled)
  if (!directive.runnable) {
    await sleep(IDLE_POLL_MS);
    continue;
  }

  tick++;
  cognitionUsage = zeroAcc(); // reset BEFORE renderTick (which runs summary/contextFor/plan through the metered Complete)
  // A1: pass the sim game clock into renderTick so the prompt can state the time of day AND drive the daily
  // plan → role-location movement (the keystone wiring — the plan was generated then discarded at the prompt).
  // T0: planStep = the resolved schedule step ("HH:MM-HH:MM activity @building#station") for the trace;
  // stuckNote (D28) makes the prompt's top branch "do something different" after no-progress ticks; `social`
  // feeds the affordance menu's volition + answered-say predicates. Latency brackets feed the tape (H15).
  const tickT0 = Date.now();
  const { prompt, perceived, planStep, planMeta, menuCount } = await renderTick(id, persona, tick, mind, gameMinutes, stuckNote, social);
  const renderMs = Date.now() - tickT0;
  // D32: plan-step beat — once per CHANGE of the step, so the tape can answer "why did he go there".
  if (planStep && planStep !== lastPlanStepEmitted) {
    lastPlanStepEmitted = planStep;
    fetch(`${SIM_URL}/event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: id, kind: "plan-step", payload: planMeta ?? { step: planStep, until: "?" } }),
    }).catch(() => {});
  }

  // S0-4 hardening: tick-scoped so the `finally` (and the SIGTERM flush) can record the trace even when the
  // tick THROWS or is cut off mid-tick — the slow/cut-off tick is exactly the health line we most want
  // (forensic 2026-06-20: a duration-elapsed SIGTERM during smith's ~93s tick killed the process between
  // reportUsage and the old end-of-try trace write, so that tick wrote NO health line at all).
  let lastResult: unknown = null;
  let narration = "";
  let tickUsage: UsageSample = zeroAcc();
  const toolsUsed: Array<{ tool: string; input: unknown }> = []; // D32: the ACT turn's tool calls, in order
  const actT0 = Date.now(); // H15: ACT-turn latency bracket start
  let traced = false; // idempotency guard so {success-path, finally, signal-handler} write at most ONE line
  inFlight = { tick, flush: () => flushTickTrace() };
  // Flush ONE trace line for the current tick. Idempotent (traced guard). Best-effort (appendTrace itself
  // swallows). subtype "interrupted" when we never got a result (cut off mid-tick) → still surfaces in the
  // `jq 'select(.result.cost_usd==0)'` zombie query, but distinguishable from a true no-op by subtype.
  const flushTickTrace = () => {
    if (traced) return;
    traced = true;
    const r = (lastResult as { subtype?: string; num_turns?: number; is_error?: boolean } | null) ?? null;
    appendTrace(id, {
      id, tick, gameMin: gameMinutes,
      perceived: {
        at: { x: (perceived as any)?.self?.x, y: (perceived as any)?.self?.y },
        shop: (perceived as { currentShop?: { id?: string } }).currentShop?.id ?? null,
        adjacentTo: Array.isArray((perceived as { adjacentTo?: unknown }).adjacentTo) ? (perceived as { adjacentTo: string[] }).adjacentTo : [],
      },
      retrieved: traceRetrieved(mind.lastRetrieved()),
      ...(planStep ? { plan: planStep } : {}), // T0: the schedule step in play ("HH:MM-HH:MM activity @building#station")
      reasoning: narration.trim().slice(0, 400),
      actions: toolsUsed, // D32: the ACT turn's tool calls (was always [] — the §7 field finally populated)
      wrote: { observations: 0, reflections: 0 },
      result: { subtype: r?.subtype ?? "interrupted", cost_usd: tickUsage.apiEquivUsd, num_turns: r?.num_turns ?? 0, error: r?.is_error ? (r?.subtype ?? "error") : (r ? null : "interrupted") },
    });
  };

  try {
    for await (const msg of query({
      prompt,
      options: {
        mcpServers: { world },
        allowedTools: ALLOWED,
        disallowedTools: ["Bash", "Edit", "Write", "Read", "WebSearch", "WebFetch", "mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Google_Drive"],
        // S0-1: strip ALL inherited built-ins (Gmail/Calendar/Cron/Task/NotebookEdit/Glob/Grep/ToolSearch…) so the
        // citizen boots with ONLY its 8 `mcp__world__*` tools. Pairs with world-tools.ts `alwaysLoad:true` (which
        // makes those 8 load EAGERLY, no ToolSearch round-trip). MCP tools arrive via `mcpServers`+`allowedTools`,
        // NOT the built-in set, so `tools:[]` does not touch them. Together: 0 ToolSearch, ~2× fewer ACT round-trips.
        tools: [], // disable the built-in tool set (sdk.d.ts:1357-1366); keep `disallowedTools` as defense-in-depth
        systemPrompt: persona.system, // plain string — NOT the claude_code preset
        settingSources: [], // hermetic: don't inherit repo CLAUDE.md / settings / skills
        model: directive.model, // per-agent, hot-swappable from the sim roster (default Haiku)
        maxTurns: 8,
        // NO low maxBudgetUsd: total_cost_usd is NOTIONAL on a subscription (real spend with an API key). 2.0 is a pure per-tick runaway guard.
        maxBudgetUsd: 2.0,
        // Code-enforced GUARD: veto a `buy` even if the model skips evaluate_purchase.
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          if (toolName !== "mcp__world__buy") {
            return { behavior: "allow" as const, updatedInput: input };
          }
          const item = String(input.item ?? "");
          const g = await canBuy(id, item, priceOf(item), tick);
          return g.ok
            ? { behavior: "allow" as const, updatedInput: input }
            : { behavior: "deny" as const, message: g.why ?? "spend cap" };
        },
      },
    }) as AsyncIterable<unknown>) {
      auditWrite(id, tick, msg); // raw transcript → sim/data/agents/<id>.jsonl
      const line = logPretty(id, tick, msg); // human-readable line
      if (line) console.log(line);
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> } };
      if (m?.type === "result") lastResult = msg;
      else if (m?.type === "assistant" && m.message?.content) {
        for (const b of m.message.content) {
          if (b?.type === "text" && b.text) narration += b.text;
          // D32: collect the tools the ACT turn invoked, in order — feeds the choice beat + the trace actions.
          else if ((b as { type?: string }).type === "tool_use" && b.name) toolsUsed.push({ tool: String(b.name).replace(/^mcp__world__/, ""), input: b.input ?? {} });
        }
      }
    }
    consecFailures = 0; // success ⇒ reset the circuit breaker
    const actMs = Date.now() - actT0; // ACT-turn wall time (H15 latency bracket)
    // D32: the choice beat — what it PICKED from how many presented options (menu beat = the options; this
    // = the selection). chosen = the first world-tool call, rendered "tool:arg"; "none" = a talk-only/idle turn.
    {
      const first = toolsUsed[0];
      const arg = first ? String((first.input as { to?: unknown; spot?: unknown; toId?: unknown; item?: unknown }).to ?? (first.input as { spot?: unknown }).spot ?? (first.input as { toId?: unknown }).toId ?? (first.input as { item?: unknown }).item ?? "") : "";
      fetch(`${SIM_URL}/event`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: id, kind: "choice", payload: { chosen: first ? `${first.tool}${arg ? `:${arg}` : ""}` : "none", of: menuCount, tick } }),
      }).catch(() => {});
    }
    const actUsage = extractUsage(lastResult); // captured now; REPORTED at the end so the ceiling sees ACT + cognition + dialogue
    // COGNITION: remember what I just did, then reflect if enough importance has accrued (both best-effort).
    // T0: explicit importance (4) — the un-annotated form spent a CLI-spawned poignancy call EVERY tick on
    // scoring the agent's own routine narration (audit A4). Salient events still score via their channels.
    if (narration.trim()) await mind.observe(`I decided: ${narration.trim().slice(0, 280)}`, { importance: 4 });
    await mind.maybeReflect();
    // S0-3: react to what I just did + (if warranted) re-plan from now (paper §4.3.1). T0 THROUGHPUT GATE:
    // only consult the react model when something actually LANDED on this agent this tick — someone spoke TO
    // it, it overheard a conversation, or a dialogue/trade involved it. Reacting to one's own routine
    // narration was a per-tick LLM call that (measured) almost never triggered a replan. The reaction path +
    // its conservatism are unchanged; we just stop asking when there is nothing to react to.
    const heardCount = Array.isArray((perceived as { heardRecently?: unknown }).heardRecently) ? (perceived as { heardRecently: unknown[] }).heardRecently.length : 0;
    const overheardCount = Array.isArray((perceived as { overheard?: unknown }).overheard) ? (perceived as { overheard: unknown[] }).overheard.length : 0;
    const dialogueCount = Array.isArray((perceived as { recentDialogues?: unknown }).recentDialogues) ? (perceived as { recentDialogues: unknown[] }).recentDialogues.length : 0;
    const salient = heardCount + overheardCount + dialogueCount > 0;
    if (narration.trim() && salient) await mind.maybeReplan(`I decided: ${narration.trim().slice(0, 280)}`);
    // D32 suppressed beat: the replan trigger was evaluated and NOT consulted — silence must be explained
    // (flight-tape schema layer 6; "replan: not-due" is the schema's literal example).
    else if (narration.trim() && !salient) {
      fetch(`${SIM_URL}/event`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: id, kind: "suppressed", payload: { trigger: "replan", reason: "not-due:no-salient-input", tick } }),
      }).catch(() => {});
    }
    // SOCIAL (T0, socialweaver's SocialStep — the tested superset of the old inline blocks 1/2/3/3b/4):
    // reply-mode dialogues off heardRecently (closes #18 end-to-end), windowed host election (no lower-id
    // monopoly), relationship-conditioned engage, gossip with provenance, opinion drift, plus the old
    // trade/co-presence/reflection taps. Runs off the PRE-ACT perception; never throws (guarded inside).
    // tickId threads the tape's causal key into SocialStep's own ignition/suppression beats (D32).
    const socialRes = await social.run({ perceived, enabledIds: directive.enabledIds, complete: makeClaudeComplete(directive.model, onCogUsage), tickId: tick });
    for (const l of socialRes.log) console.log(`[${id}] ${l}`);

    // D28 NEVER-STUCK detector: a tick "landed" if any world tool succeeded; it "spun" if the ACT turn hit
    // max-turns or every tool call came back blocked. On >=2 consecutive spun ticks: tape beat (D32), a
    // forced replan (unconditional — the salience gate above is for routine ticks), and next tick's prompt
    // leads with the break-the-loop branch via stuckNote.
    {
      const outcome = takeTurnOutcome(id);
      const subtype = (lastResult as { subtype?: string } | null)?.subtype ?? "";
      const spun = subtype === "error_max_turns" || (outcome.blocked > 0 && outcome.ok === 0);
      if (spun) {
        stuckTicks++;
        const why = subtype === "error_max_turns"
          ? `your turn ran out of steps without completing anything (${outcome.blocked} blocked action${outcome.blocked === 1 ? "" : "s"})`
          : `all ${outcome.blocked} action${outcome.blocked === 1 ? "" : "s"} you tried came back blocked`;
        // D32 suppressed beat: the stuck-breaker was evaluated but is still below its 2-tick threshold —
        // the tape sees the precursor, not just the eventual stuck event.
        if (stuckTicks === 1) {
          fetch(`${SIM_URL}/event`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ actor: id, kind: "suppressed", payload: { trigger: "stuck-breaker", reason: "below-threshold:1-of-2", tick } }),
          }).catch(() => {});
        }
        if (stuckTicks >= 2) {
          stuckNote = `${why} — ${stuckTicks} ticks in a row now.`;
          fetch(`${SIM_URL}/event`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ actor: id, kind: "stuck", payload: { consecutive: stuckTicks, why, ok: outcome.ok, blocked: outcome.blocked, planStep } }),
          }).catch(() => {});
          await mind.maybeReplan(`I am stuck: ${why}. My plan step "${planStep}" is not working — I should change approach or destination.`);
        }
      } else {
        stuckTicks = 0;
        stuckNote = undefined;
      }
    }

    // METER the WHOLE tick (ACT turn + all cognition + the dialogue) as one tick → the GUI meter + the fleet budget
    // ceiling. Closes the gap where cognition/dialogue Completes were unmetered (incident-relevant).
    tickUsage = {
      apiEquivUsd: (actUsage?.apiEquivUsd ?? 0) + cognitionUsage.apiEquivUsd,
      tokensIn: (actUsage?.tokensIn ?? 0) + cognitionUsage.tokensIn,
      tokensOut: (actUsage?.tokensOut ?? 0) + cognitionUsage.tokensOut,
      cacheWrite: (actUsage?.cacheWrite ?? 0) + cognitionUsage.cacheWrite,
      cacheRead: (actUsage?.cacheRead ?? 0) + cognitionUsage.cacheRead,
    };
    await reportUsage(id, tick, tickUsage, { sdk: actMs, sim: renderMs, total: Date.now() - tickT0 }); // H15 latency on the tape
    // S0-4: trace this tick (success path). The `finally` below also calls flushTickTrace() — the `traced`
    // guard makes it idempotent, so a clean tick writes exactly one line here and the finally is a no-op.
    flushTickTrace();
  } catch (e) {
    consecFailures++;
    const backoff = Math.min(60_000, 1000 * 2 ** consecFailures); // 2s, 4s, 8s, … capped at 60s
    console.error(`[${id}] tick ${tick} error (${consecFailures}/${MAX_CONSEC_FAILURES}): ${(e as Error).message} — backing off ${backoff}ms`);
    if (consecFailures >= MAX_CONSEC_FAILURES) {
      console.error(`[${id}] circuit breaker OPEN — ${consecFailures} consecutive failures; halting to avoid an error-storm (INC-2026-06-18).`);
      flushTickTrace(); // record the cut-off/errored tick BEFORE breaking out of the loop
      break; // self-terminate cleanly; the supervisor will NOT respawn a clean (code-0) exit
    }
    await sleep(backoff);
    continue; // the backoff replaces the normal pacing wait this iteration
  } finally {
    flushTickTrace(); // an errored-but-recovered tick still gets its health line (idempotent via `traced`)
    inFlight = null;  // tick done — nothing in flight for the signal handler to flush
  }

  await sleep(TICK_MS + Math.random() * 2000); // pacing floor + jitter
}
console.log(`[${id}] citizen loop ended (clean exit).`);
process.exit(0);
