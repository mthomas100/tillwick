import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Per-citizen audit. Two outputs:
//   <id>.jsonl  — the RAW SDK message stream, one JSON line per message (the deep, replayable transcript).
//   stdout/log  — a human-readable one-liner per interesting message (logPretty), so `tail -f <id>.log`
//                 (run-all.ts pipes each child's stdout here) reads like a story.
//
// SDK message shapes (verified in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):
//   assistant: { type:'assistant', message:{ content:[{type:'text',text}|{type:'tool_use',name,input}] } }
//   result:    { type:'result', subtype, total_cost_usd, num_turns, permission_denials, terminal_reason }
//   user:      { type:'user', message:{...} }  (tick prompt + tool_result echoes)

const HERE = dirname(fileURLToPath(import.meta.url)); // citizens/
const ROOT = dirname(HERE); // repo root
const AGENT_DIR = join(ROOT, "sim", "data", "agents");
mkdirSync(AGENT_DIR, { recursive: true });

export function auditWrite(id: string, tick: number, msg: unknown): void {
  const m = msg as { type?: string };
  const rec = { ts: new Date().toISOString(), id, tick, type: m?.type, msg };
  appendFileSync(join(AGENT_DIR, `${id}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
}

const short = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s);

// Emit a readable line for the interesting messages (returns null for ones we don't surface).
// citizen.ts console.log()s the return; run-all.ts captures stdout into <id>.log.
export function logPretty(id: string, tick: number, msg: unknown): string | null {
  const m = msg as any;
  const tag = `${id} t${tick}`;
  if (m?.type === "assistant") {
    const lines: string[] = [];
    for (const b of m.message?.content ?? []) {
      if (b?.type === "text" && b.text?.trim()) {
        lines.push(`  [${tag}] 🗣  ${short(b.text.trim())}`);
      } else if (b?.type === "tool_use") {
        const name = String(b.name ?? "").replace(/^mcp__world__/, "");
        lines.push(`  [${tag}] 🔧 ${name}(${short(JSON.stringify(b.input ?? {}), 160)})`);
      }
    }
    return lines.length ? lines.join("\n") : null;
  }
  if (m?.type === "result") {
    const cost = m.total_cost_usd;
    const denied = (m.permission_denials ?? []).length;
    const note = denied ? ` · ${denied} GUARD veto(es)` : "";
    // cost_usd is an API list-price figure: real spend with an API key, notional on a subscription. Shown for info.
    return `  [${tag}] ✓ ${m.subtype}${cost != null ? ` (notional cost_usd=${cost})` : ""}${note}`;
  }
  return null;
}
