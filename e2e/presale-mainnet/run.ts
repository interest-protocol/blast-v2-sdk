import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beginEvidence } from "./chain.ts";
import { STATE_PATH } from "./sale.ts";
import { e042 } from "./scenarios/e042.ts";

const [scenario, phase, ...extra] = process.argv.slice(2);
if (scenario !== "e042" || extra.length)
  throw new Error(
    "Usage: node e2e/presale-mainnet/run.ts e042 [preflight|lp|setup|run|cleanup|record]",
  );
mkdirSync(dirname(STATE_PATH), { recursive: true });
const lock = `${STATE_PATH}.lock`;
try {
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
} catch {
  throw new Error(
    `Run already locked: ${lock}. Check its PID before removing a stale lock.`,
  );
}
try {
  beginEvidence("e042");
  await e042(phase);
} finally {
  unlinkSync(lock);
}
