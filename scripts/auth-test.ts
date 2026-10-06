import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkAuth } from "../citizens/auth.js";

// Keystone de-risk: does the Agent SDK authenticate (see citizens/auth.ts) and autonomously call a custom tool?
checkAuth("auth-test");

let called = false;
const report = tool("report", "Report your mood in one word.", { mood: z.string() }, async ({ mood }) => {
  called = true;
  console.log("  ✓ tool invoked, mood =", mood);
  return { content: [{ type: "text", text: "noted" }] };
});
const srv = createSdkMcpServer({ name: "t", version: "1.0.0", tools: [report] });

for await (const m of query({
  prompt: "Call the report tool with your mood in one word, then say 'done'.",
  options: { mcpServers: { t: srv }, allowedTools: ["mcp__t__report"], model: "claude-sonnet-4-6", maxTurns: 3 },
}) as AsyncIterable<any>) {
  if (m?.type === "assistant") for (const b of m.message?.content ?? []) if (b?.type === "text" && b.text?.trim()) console.log("  assistant:", b.text.trim());
  if (m?.type === "result") console.log("  RESULT:", m.subtype, "· metered cost_usd =", m.total_cost_usd);
}
console.log(called ? "✅ AUTH OK — the SDK authenticated and autonomously called the tool" : "⚠️ tool was not called");
