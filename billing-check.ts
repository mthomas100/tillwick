import "dotenv/config";
import { createPublicClient, http, getAddress, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Run BEFORE and AFTER the citizen to prove USDC moved buyer -> seller on Base Sepolia.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const erc20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const client = createPublicClient({ chain: baseSepolia, transport: http() });

async function bal(addr: `0x${string}`): Promise<string> {
  const raw = (await client.readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
  return formatUnits(raw, 6);
}

const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`).address;
const seller = getAddress(process.env.SELLER_ADDRESS as `0x${string}`);

console.log("Base Sepolia USDC balances (run before AND after the citizen):");
console.log(`  BUYER  ${buyer} = ${await bal(buyer)} USDC`);
console.log(`  SELLER ${seller} = ${await bal(seller)} USDC`);
console.log("\nExplorer:");
console.log(`  buyer : https://sepolia.basescan.org/address/${buyer}`);
console.log(`  seller: https://sepolia.basescan.org/address/${seller}`);
