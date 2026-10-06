import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Generate N throwaway Base Sepolia citizen wallets for the agent economy.
// Keys -> citizens.local.json (GITIGNORED). Addresses -> CITIZEN-WALLETS.local.md (also gitignored).
// Fund them via the treasury fan-out (`npm run fund-agents`), not individual faucet hits.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const N = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.CITIZENS ?? 8);
const KEYSTORE = join(ROOT, "citizens.local.json");
const DOC = join(ROOT, "CITIZEN-WALLETS.local.md"); // addresses only, but still a linkable identifier: gitignored

// the ids citizens/personas.ts knows (order = roster order = sprite colours)
const ROLES = ["baker", "courier", "barista", "grocer", "smith", "student", "musician", "regular"];

// Footgun guard: regenerating orphans every funded wallet (their keys exist nowhere else).
if (existsSync(KEYSTORE) && !process.argv.includes("--force")) {
  console.error(`${KEYSTORE} already exists: refusing to overwrite funded wallets. Pass --force to really regenerate.`);
  process.exit(1);
}

const citizens = Array.from({ length: N }, (_, i) => {
  const privateKey = generatePrivateKey();
  return { id: ROLES[i] ?? `citizen${i}`, address: privateKeyToAccount(privateKey).address, privateKey };
});

writeFileSync(KEYSTORE, JSON.stringify(citizens, null, 2));
console.log(`wrote ${KEYSTORE} (gitignored) — ${N} citizens`);

const md = [
  "# Citizen wallets (Base Sepolia testnet)",
  "",
  "Addresses only. Private keys live in `citizens.local.json` (gitignored — never committed).",
  "Fund via the **treasury fan-out** (`npm run fund-agents`), not individual faucet hits.",
  "",
  "| Citizen | Address |",
  "|---|---|",
  ...citizens.map((c) => `| ${c.id} | \`${c.address}\` |`),
  "",
].join("\n");
writeFileSync(DOC, md);
console.log(`wrote ${DOC}`);
for (const c of citizens) console.log(`  ${c.id.padEnd(8)} ${c.address}`);
