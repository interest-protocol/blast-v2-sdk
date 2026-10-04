/**
 * Runs one presale mainnet end-to-end scenario: `node e2e/presale-mainnet/run.ts <name>`.
 * Every transaction is real and spends mainnet gas.
 */
import { beginEvidence, record, spent } from "./chain.ts";
import { assertMainnet } from "./env.ts";
import { scenarios } from "./scenarios/index.ts";

const name = process.argv[2];
const scenario = name ? scenarios[name] : undefined;
if (!name || !scenario) {
  console.error(`usage: run.ts <${Object.keys(scenarios).join("|")}> [phase]`);
  process.exit(2);
}

await assertMainnet();
beginEvidence(name);
console.log(`▶ ${name}`);
try {
  await scenario(process.argv[3]);
  record({ kind: "end", pass: true, spentMist: spent() });
  console.log(`✔ ${name} passed; spent ${Number(spent()) / 1e9} SUI`);
} catch (error) {
  record({
    kind: "end",
    pass: false,
    error: String(error),
    spentMist: spent(),
  });
  console.error(`✘ ${name} failed; spent ${Number(spent()) / 1e9} SUI`);
  throw error;
}
