import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import type { RewardManifest } from "../src/holder-rewards/allocations.ts";
import type {
  HolderRewardsOperator,
  HolderRewardsOperatorConfig,
} from "../src/holder-rewards/operator.ts";
import { holderRewardsOperator } from "../src/holder-rewards/operator.ts";
import {
  fileHolderRewardsStore,
  readOperatorJson,
  writeOperatorJson,
} from "./file-store.ts";

type OperatorConfig = HolderRewardsOperatorConfig & {
  grpcUrl: string;
  /** Blast deploys to Sui mainnet only. */
  network: "mainnet";
};
type OperatorOptions = {
  until?: string;
  round?: string;
  manifest?: string;
  out?: string;
  execute?: boolean;
};

/** Node CLI over a file store. Publication stays unsigned; only explicit relay --execute reads a gas key. */
export async function runHolderRewardsOperator(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      dir: { type: "string" },
      until: { type: "string" },
      round: { type: "string" },
      manifest: { type: "string" },
      out: { type: "string" },
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "holder-rewards <inspect|index|prepare|publish-tx|advance|relay> --config FILE --dir DIRECTORY [--until CHECKPOINT] [--round ID] [--manifest FILE] [--out FILE] [--execute]",
    );
    return;
  }
  const command = positionals[0];
  if (!values.config || !values.dir || !command || positionals.length !== 1)
    throw new Error("supply one command, --config and --dir; use --help");
  if (values.execute && command !== "relay")
    throw new Error("--execute is supported only for permissionless relay");
  const config = await readOperatorJson<OperatorConfig>(values.config);
  if (
    !config.chainId ||
    !config.grpcUrl ||
    !config.deployment ||
    !config.vaultId ||
    config.network !== "mainnet"
  )
    throw new Error(
      "config needs grpcUrl, network, expected genesis chainId, deployment and vaultId",
    );
  const client = new SuiGrpcClient({
    baseUrl: config.grpcUrl,
    network: config.network,
  });
  const directory = resolve(values.dir);
  const operator = holderRewardsOperator(
    client,
    config,
    fileHolderRewardsStore(directory),
  );
  await dispatchCommand(operator, command, directory, values);
  console.log(`${command} completed; artifacts: ${directory}`);
}

async function dispatchCommand(
  operator: HolderRewardsOperator,
  command: string,
  directory: string,
  values: OperatorOptions,
): Promise<void> {
  const output = values.out ?? join(directory, `${command}.json`);
  const manifest = values.manifest
    ? await readOperatorJson<RewardManifest>(values.manifest)
    : undefined;
  switch (command) {
    case "inspect":
      return writeOperatorJson(output, await operator.inspect());
    case "index":
      if (!values.until || !/^\d+$/.test(values.until))
        throw new Error("index needs --until CHECKPOINT");
      return operator.index(BigInt(values.until));
    case "prepare":
      await operator.prepare();
      return;
    case "publish-tx":
      return writeTransaction(
        output,
        await operator.publishTransaction(manifest),
      );
    case "advance":
      return operator.advance(requireRound(values), manifest);
    case "relay":
      return relayRewards(operator, directory, values, manifest);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function relayRewards(
  operator: HolderRewardsOperator,
  directory: string,
  values: OperatorOptions,
  manifest: RewardManifest | undefined,
): Promise<void> {
  const key = values.execute
    ? process.env.HOLDER_REWARDS_RELAYER_KEY
    : undefined;
  if (values.execute && !key)
    throw new Error(
      "relay --execute requires HOLDER_REWARDS_RELAYER_KEY (gas only)",
    );
  const signer = key ? Ed25519Keypair.fromSecretKey(key) : undefined;
  const relay = await operator.relay(requireRound(values), {
    manifest,
    signer,
  });
  for (const batch of relay.batches)
    if (!batch.digest)
      await writeTransaction(
        join(
          directory,
          "rounds",
          relay.roundNumber,
          `relay-${batch.firstIndex}.json`,
        ),
        batch.transaction,
      );
}

function requireRound(values: OperatorOptions): string {
  if (!values.round) throw new Error("supply the confirmed --round object ID");
  return values.round;
}
async function writeTransaction(path: string, tx: Transaction) {
  await writeOperatorJson(path, { transaction: await tx.toJSON() });
}
