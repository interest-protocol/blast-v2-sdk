import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

type GasReceipt = {
  effects: { gasUsed: { computationCost: string; storageCost: string } };
};
export type SignedReceipt<T> = {
  transaction: string;
  signatures: string[];
  executed?: T;
};
/** The state path and complete target fingerprint scope both signed inputs and final receipts. */
export class TransactionJournal<T extends GasReceipt> {
  readonly directory: string;
  constructor(statePath: string, fingerprint: string) {
    this.directory = resolve(`${statePath}.transactions`, fingerprint);
  }
  private path(label: string): string {
    return `${this.directory}/${createHash("sha256").update(label).digest("hex")}.json`;
  }
  read(label: string): SignedReceipt<T> | undefined {
    const path = this.path(label);
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"), (_, v) =>
          v && typeof v === "object" && typeof v.$bytes === "string"
            ? Uint8Array.from(Buffer.from(v.$bytes, "base64"))
            : v,
        )
      : undefined;
  }
  write(label: string, value: SignedReceipt<T>): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(label);
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify(value, (_, v) =>
        v instanceof Uint8Array
          ? { $bytes: Buffer.from(v).toString("base64") }
          : typeof v === "bigint"
            ? v.toString()
            : v,
      ),
      { mode: 0o600 },
    );
    renameSync(`${path}.tmp`, path);
  }
  /** Reserve the entire next gas cap. Refuse new work while any submission is uncertain. */
  reserve(nextBudget: bigint, runBudget: bigint): void {
    const files = existsSync(this.directory)
      ? readdirSync(this.directory).filter((name) => name.endsWith(".json"))
      : [];
    const spent = files.reduce((sum, name) => {
      const saved = JSON.parse(
        readFileSync(`${this.directory}/${name}`, "utf8"),
      ) as SignedReceipt<T>;
      if (!saved.executed)
        throw new Error(
          "An unresolved signed transaction exists; resume its phase before proceeding",
        );
      const gas = saved.executed.effects.gasUsed;
      return sum + BigInt(gas.computationCost) + BigInt(gas.storageCost);
    }, 0n);
    if (spent + nextBudget > runBudget)
      throw new Error("Run gas budget exhausted before signing");
  }
}
