import "dotenv/config";
import { loadCitizens, treasuryAccount, usdc } from "./lib.js";

// The money-supply view: treasury (central bank) + every citizen's USDC, and the total in the economy.
const treasury = treasuryAccount();
const citizens = loadCitizens();

const tBal = await usdc(treasury.address);
console.log(`TREASURY ${treasury.address} = ${tBal} USDC   (money supply / central bank)`);
console.log("CITIZENS:");
let total = tBal;
for (const c of citizens) {
  const b = await usdc(c.address);
  total += b;
  console.log(`  ${c.id.padEnd(8)} ${c.address} = ${b} USDC`);
}
console.log(`TOTAL across economy = ${total.toFixed(6)} USDC`);
