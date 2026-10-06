import "dotenv/config";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { loadCitizens, treasuryKey, usdc } from "../lib.js";

// Treasury fan-out: disperse USDC from the treasury to every citizen, GASLESS, over x402.
// Requires the stipend window running:  npm run stipend   (in another terminal)
//   npm run fund-agents            -> pay each citizen the STIPEND
//   npm run fund-agents -- --dry-run
const STIPEND = process.env.STIPEND ?? "$0.02";
const DRY = process.argv.includes("--dry-run");
const STIPEND_URL = process.env.STIPEND_URL ?? "http://localhost:4040";

const citizens = loadCitizens();
const account = privateKeyToAccount(treasuryKey());

console.log(
  `Treasury ${account.address} dispersing ${STIPEND} to ${citizens.length} citizens (gasless x402)${DRY ? "  [DRY RUN]" : ""}`,
);
const before = await usdc(account.address);
console.log(`Treasury USDC before: ${before}`);

if (DRY) {
  for (const c of citizens) console.log(`  would pay ${STIPEND} -> ${c.id} (${c.address})`);
  console.log("Dry run — nothing sent.");
  process.exit(0);
}

const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
const pay = wrapFetchWithPayment(fetch, client);

let ok = 0;
for (const c of citizens) {
  try {
    const res = await pay(`${STIPEND_URL}/stipend/${c.id}`);
    const settled = !!res.headers.get("PAYMENT-RESPONSE");
    console.log(`  ${settled ? "✓" : "?"} ${c.id.padEnd(8)} <- ${STIPEND}  HTTP ${res.status}`);
    if (settled) ok++;
  } catch (e) {
    console.log(`  ✗ ${c.id.padEnd(8)} FAILED: ${(e as Error).message}`);
  }
}

const after = await usdc(account.address);
console.log(`Treasury USDC after: ${after}  (dispersed ${(before - after).toFixed(6)} to ${ok}/${citizens.length})`);
console.log("→ `npm run balances` to see citizen balances.");
