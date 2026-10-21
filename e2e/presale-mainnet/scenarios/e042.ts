import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { bcs } from "@mysten/sui/bcs";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { TransactionArgument } from "@mysten/sui/transactions";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { getAcl } from "../../../src/admin/index.ts";
import {
  aftermathPoolCoinTypes,
  aftermathSaleTokenFirst,
} from "../../../src/presale/aftermath.ts";
import {
  AFTERMATH_LP_PACKAGE_DEPENDENCIES,
  findAftermathLpCoinPublication,
  publishAftermathLpCoin,
  verifyAftermathLpCoin,
} from "../../../src/presale/aftermath-lp.ts";
import type { PresaleAdminRole } from "../../../src/presale/index.ts";
import type { Executed } from "../chain.ts";
import {
  balanceChange,
  check,
  created,
  createdAll,
  equal,
  event,
  events,
  exec,
  expectAbort,
  expectSuccess,
  hasReceipt,
  record,
  sharedVersion,
} from "../chain.ts";
import {
  ADMIN_DEPLOYMENT,
  AFTERMATH,
  acl,
  administrator,
  assertTarget,
  CONFIG,
  client,
  DEPLOYMENT,
  deployer,
  presale,
  SUI,
  SUPER_ADMIN_CAP,
  TESTKIT,
} from "../env.ts";
import { nativeSaleTransaction } from "../native-sale.ts";
import type { SaleRecord, Shared } from "../sale.ts";
import { mut, newSaleToken, saveStateValue, stateValue, u64 } from "../sale.ts";
import { PRIOR_EVIDENCE } from "../target.ts";

const KEY = "e042";
/** The first testkit sale token the 2026-10-20 run (SALE_A to SALE_E) left unregistered. */
const LETTER = CONFIG.saleTokenLetter;
const DAO_FEE_BPS = 200;
/** The raise, as E2E-011's Cetus sale: 0.01 SUI. */
const RAISE = 10_000_000n;
const SUPPLY = 1_000_000_000_000_000_000n;
const TOKEN_ALLOCATION_BPS = 5_000n;
const FEE_RECIPIENT_BPS = 6_000n;
const HOLDER_REWARDS_BPS = 4_000n;
/** SUI swapped into the pool after migration; the sell swaps back half of what it bought. */
const BUY_IN = 2_000_000n;
const ROLES: PresaleAdminRole[] = ["ListingAdmin", "AdapterAdmin"];
const ZERO_ADDRESS = normalizeSuiAddress("0x0");

/** Aftermath's AMM: the revision-3 id runs the code and defines `CreatePoolCapV2`; types keep the original id. */
const AMM = {
  original:
    "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c",
  current: "0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29",
};
/** Aftermath's DAO-fee pools: revision 2 runs `swap::swap_exact_in`. */
const DAO_FEE = {
  original:
    "0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d",
  current: "0x5ad6890968efcf3d20899e0cec735214f1067b96e77e77d86408989998468bb2",
};
/** Aftermath's shared objects `swap_exact_in` takes, as the 2026-10-20 swaps (FUnhUk8e…) used them. */
const SWAP_OBJECTS = {
  protocolFeeVault:
    "0xf194d9b1bcad972e45a7dd67dd49b3ee1e3357a00a50850c52cd51bb450e13b4",
  treasury:
    "0x28e499dff5e864a2eafe476269a4f5035f1c16f338da7be18b103499abf271ce",
  insuranceFund:
    "0xf0c40d67b078000e18032334c3325c47b9ec9f3d9ae4128be820d54663d14e3b",
  referralVault:
    "0x35d35b0e5b177593d8c3a801462485572fc30861e6ce96a55af6dc4730709278",
};
/** Final swaps allow 0.5% slippage from a validation-enabled quote simulation (1e18 scale). */
const SWAP_SLIPPAGE = 5_000_000_000_000_000n;

type Tx = {
  action: string;
  digest: string;
  sender: string;
  gasOwner: string;
  netGasMist: string;
};
type Check = { id: string; pass: boolean; detail?: unknown };
type LpCoin = {
  packageId: string;
  lpType: string;
  createPoolCap: string;
  digest: string;
};
type Sale = SaleRecord & {
  creationDigest: string;
  tokenRegistrationDigest: string;
  lpType: string;
  createPoolCap: string;
  poolCreation: Shared;
  participant: string;
  feeRecipient: string;
};
type Migration = {
  digest: string;
  vaultId: string;
  vault: Shared;
  poolId: string;
  daoFeePool: Shared;
  ownerCapId: string;
  ownerCapOwner: unknown;
  lpCoinId: string;
  lpCoinOwner: string | null;
  liquidity: string;
  liquidityTokens: string;
  liquidityQuote: string;
  createdPoolCoins: string[];
  poolTypeNames: string[] | null;
  balanceOfMeme: string;
  balanceOfQuote: string;
  balanceOfSource: string;
};
type Swap = {
  digest: string;
  amountIn: string;
  amountOut: string;
  feeCoinIds: string[];
  feeAmount: string;
  expectedFee: string;
};
type Collect = {
  digest: string;
  memeCoins: string[];
  quoteCoins: string[];
  grossMeme: string;
  grossQuote: string;
  event: Record<string, unknown>;
  recipientMeme: string;
  recipientQuote: string;
  repeatDigest: string;
  repeatEvents: number;
};
type Claim = { digest: string; tokens: string; quoteRefund: string };
type Cleanup = {
  delistQuote?: string;
  delistWitness?: string;
  revokeAdmin?: string;
  destroyAdminCap?: string;
};
type State = {
  baseline?: { allowedQuotes: string[]; allowedMigrationWitnesses: string[] };
  liquidityTokenAllocationBps?: string;
  lp?: LpCoin;
  adminCap?: string;
  sale?: Sale;
  migration?: Migration;
  swaps?: { buy: Swap; sell: Swap };
  collect?: Collect;
  pendingCollection?: { meme: OwnedCoin[]; quote: OwnedCoin[] };
  claim?: Claim;
  cleanup?: Cleanup;
  simulatedSuccesses: string[];
  negativeSimulations: { action: string; module: string; code: number }[];
  transactions: Tx[];
  checks: Check[];
};

const packageId = DEPLOYMENT.originalPackageId;
const WITNESS = normalizeStructTag(`${packageId}::aftermath::Witness`);
const VENUE = normalizeStructTag(`${packageId}::aftermath::Venue`);
const SUI_TYPE = normalizeStructTag(SUI);

export async function e042(phase?: string): Promise<void> {
  await assertTarget();
  const state = load();
  switch (phase) {
    case "preflight":
      await preflight();
      return;
    case "lp":
      await lpCoin(state, deployer());
      return;
    case "setup":
      await allow(state);
      return;
    case "cleanup":
      await cleanup(state);
      return;
    case "record":
      await printRecord(state);
      return;
    case undefined:
    case "run":
      break;
    default:
      throw new Error(`unknown phase ${phase}`);
  }
  if (state.cleanup?.destroyAdminCap)
    throw new Error(
      "This run was cleaned up; use record or a new configuration/state",
    );
  await preflight();
  const operator = deployer();
  await allow(state);
  const lp = await lpCoin(state, operator);
  const sale = await createSale(state, operator, lp);
  await fund(state, operator, sale);
  const migration = await migrate(state, operator, sale);
  await swaps(state, operator, sale, migration);
  await collect(state, operator, sale, migration);
  await claim(state, operator, sale);
  console.log(
    `  E2E-042: ${state.transactions.length} transactions, ${state.checks.length} checks, ${state.negativeSimulations.length} simulated aborts; run \`e042 cleanup\` then \`e042 record\``,
  );
}

// === Phases ===

/** Key-free reads: the final ABI, object identities and unused test token are mandatory. */
async function preflight(): Promise<void> {
  const memeType = normalizeStructTag(
    `${TESTKIT}::sale_tokens::SALE_${LETTER}`,
  );
  equal(
    "SDK puts SUI first",
    aftermathPoolCoinTypes(memeType, SUI)[0],
    SUI_TYPE,
  );
  if (!load().sale && !hasReceipt(`register sale token ${LETTER}`)) {
    const { coinMetadata } = await client.core.getCoinMetadata({
      coinType: memeType,
    });
    check(`SALE_${LETTER} is not registered`, coinMetadata === null);
  }
  const policy = await presale.getCreationPolicy();
  record({
    kind: "preflight",
    target: CONFIG,
    policy,
    priorEvidence: PRIOR_EVIDENCE,
  });
  await inspect(
    "SDK LP coin template publishes",
    publishTx(CONFIG.operators.deployer),
    CONFIG.operators.deployer,
  );
  console.log(
    "Final target ABI and configuration passed; no transactions submitted.",
  );
}

/** Grant only this run's temporary capability, owned by the sale creator. */
async function allow(state: State): Promise<void> {
  if (state.cleanup?.destroyAdminCap)
    throw new Error("Temporary AdminCap was retired");
  const admin = administrator();
  const sponsor = sponsorFor(admin);
  if (!state.baseline) {
    const policy = await presale.getCreationPolicy();
    state.baseline = {
      allowedQuotes: policy.allowedQuotes.map(tag),
      allowedMigrationWitnesses: policy.allowedMigrationWitnesses.map(tag),
    };
    save(state);
  }
  if (!state.adminCap) {
    const granted = await step(
      state,
      "grant-admin",
      admin,
      acl.grantAdmin({
        superAdminCapId: SUPER_ADMIN_CAP,
        recipient: CONFIG.operators.deployer,
      }),
      sponsor,
    );
    state.adminCap = created(
      granted,
      `${ADMIN_DEPLOYMENT.packageId}::blast_acl::AdminCap`,
    );
    save(state);
  }
  const existing = (await aclAdmins()).admins[state.adminCap] ?? [];
  const roles = new Transaction();
  for (const role of ROLES) {
    const type = presale.call.roleType(role);
    if (!existing.includes(type))
      roles.add(
        acl.call.grantRole({
          superAdminCap: SUPER_ADMIN_CAP,
          adminCapId: state.adminCap,
          role: type,
        }),
      );
  }
  if (roles.getData().commands.length)
    await step(state, "grant-roles", admin, roles, sponsor);
}

/** Publishes the fresh Aftermath LP coin; its `init` sends the publisher the `CreatePoolCapV2`. */
async function lpCoin(
  state: State,
  publisher: Ed25519Keypair,
): Promise<LpCoin> {
  if (state.lp) return state.lp;
  const executed = await step(
    state,
    "publish-lp-coin",
    publisher,
    publishTx(publisher.toSuiAddress()),
  );
  const publication = findAftermathLpCoinPublication(executed);
  const verified = await verifyAftermathLpCoin(client, {
    ...publication,
    owner: publisher.toSuiAddress(),
  });
  const lp: LpCoin = {
    packageId: publication.packageId,
    lpType: verified.lpType,
    createPoolCap: verified.createPoolCapId,
    digest: executed.digest,
  };
  verify(
    state,
    "LP capability owns zero supply and nine decimal metadata",
    verified.decimals === 9,
    lp,
  );
  state.lp = lp;
  save(state);
  return lp;
}

/** `aftermath::new`, the setters, `aftermath::finalize`, `share`, and `aftermath::share` in one PTB. */
async function createSale(
  state: State,
  creator: Ed25519Keypair,
  lp: LpCoin,
): Promise<Sale> {
  if (state.sale) return state.sale;
  const token = await newSaleToken(LETTER, creator);
  const participant = creator.toSuiAddress();
  const feeRecipient = CONFIG.feeRecipient;
  const launch = { memeType: token.memeType, quoteType: SUI_TYPE };
  const registration = token.registrationDigest;
  if (
    registration &&
    !state.transactions.some((tx) => tx.digest === registration)
  ) {
    // `newSaleToken` executed the registration outside `step`; keep its receipt too.
    const result = await client.core.getTransaction({
      digest: registration,
      include: { effects: true },
    });
    const used = (result.Transaction ?? result.FailedTransaction).effects
      ?.gasUsed;
    state.transactions.push({
      action: "register-sale-token",
      digest: registration,
      sender: participant,
      gasOwner: participant,
      netGasMist: used
        ? (
            BigInt(used.computationCost) +
            BigInt(used.storageCost) -
            BigInt(used.storageRebate)
          ).toString()
        : "0",
    });
    save(state);
  }

  verify(
    state,
    "SDK coin order: the sale token sorts after SUI",
    !aftermathSaleTokenFirst(token.memeType, SUI),
    launch,
  );
  verify(
    state,
    "SDK coin order: SUI is the pool's first coin",
    aftermathPoolCoinTypes(token.memeType, SUI)[0] === SUI_TYPE,
    launch,
  );

  const { adminCap, baseline } = state;
  if (!adminCap || !baseline) throw new Error("Run setup first");
  const feePolicy = await presale.getFeePolicy();
  check(
    "fee recipient differs from protocol treasury",
    feePolicy.destination !== feeRecipient,
  );
  state.liquidityTokenAllocationBps ??= (
    10_000n -
    TOKEN_ALLOCATION_BPS -
    feePolicy.fees.tokenBps
  ).toString();
  check(
    "LP allocation remains positive after protocol token fee",
    BigInt(state.liquidityTokenAllocationBps) > 0n,
  );
  save(state);
  const liquidityTokenAllocationBps = BigInt(state.liquidityTokenAllocationBps);
  const build = async () =>
    nativeSaleTransaction({
      deployment: DEPLOYMENT,
      ...launch,
      treasuryCap: token.treasuryCap,
      currency: token.currency,
      lpCoin: await verifyAftermathLpCoin(client, {
        createPoolCapId: lp.createPoolCap,
        lpType: lp.lpType,
        owner: participant,
      }),
      adminCap,
      baseline: {
        quoteAllowed: baseline.allowedQuotes.includes(SUI_TYPE),
        witnessAllowed: baseline.allowedMigrationWitnesses.includes(WITNESS),
      },
      daoFeeBps: DAO_FEE_BPS,
      recipient: participant,
      configure: (tx, initializer) => {
        tx.add(
          presale.call.configurePresale({
            ...launch,
            initializer,
            tokenSupply: SUPPLY,
            tokenAllocationBps: TOKEN_ALLOCATION_BPS,
            participantVesting: null,
            liquidityTokenAllocationBps,
            recipientAllocations: [],
            burnable: false,
            raiseTarget: RAISE,
            raiseAllocations: [],
            durationMs: 3_600_000n,
            liquidityWindowMs: 7n * 24n * 3_600_000n,
            // One wallet, committing exactly the raise.
            eligibility: {
              kind: "open",
              walletCap: RAISE,
              maxParticipants: 1n,
              minCommitment: RAISE,
            },
            uncapped: null,
            hardCap: { startsAfterMs: 0n, closesWhenFilled: true },
            feeRecipients: [
              { recipient: feeRecipient, bps: FEE_RECIPIENT_BPS },
            ],
            holderRewardsBps: HOLDER_REWARDS_BPS,
          }),
        );
      },
    });
  const executed = await step(state, "create", creator, build);

  await verifyPolicy(state);
  const names = (executed.events ?? []).map(
    (entry) => entry.eventType.split("<")[0] ?? "",
  );
  const tierAt = names.findIndex((name) => name.endsWith("::PoolTierReserved"));
  verify(
    state,
    "PoolTierReserved<Meme, SUI, aftermath::Venue> precedes PresaleCreated",
    tierAt >= 0 &&
      tierAt < names.findIndex((name) => name.endsWith("::PresaleCreated")) &&
      typeParams(executed, "PoolTierReserved")[2] === VENUE,
    names,
  );
  const tier = event(executed, "PoolTierReserved");
  verify(
    state,
    "the tier is the DAO fee with no tick spacing",
    Number(tier.tick_spacing) === 0 &&
      u64(tier.pool_fee_rate) === BigInt(DAO_FEE_BPS),
    tier,
  );
  const presaleId = created(executed, `${packageId}::blast_presale::Presale<`);
  const reserved = event(executed, "PoolCreationReserved");
  verify(
    state,
    "PoolCreationReserved binds the sale and its CreatePoolCapV2",
    reserved.presale_id === presaleId &&
      reserved.create_pool_cap_id === lp.createPoolCap,
    reserved,
  );
  const poolCreationId = String(reserved.pool_creation_id);
  equal(
    "the PoolCreation is shared",
    poolCreationId,
    created(executed, `${packageId}::aftermath::PoolCreation<`),
  );
  const createdEvent = event(executed, "PresaleCreated");
  verify(
    state,
    "PresaleCreated names the adapter's witness",
    tag(String(createdEvent.migration_witness)) === WITNESS,
    createdEvent.migration_witness,
  );
  event(executed, "PresaleOpened");
  const capId = created(executed, `${packageId}::blast_presale::PresaleCap`);
  equal(
    "the creator keeps the PresaleCap",
    ownerOf(executed, capId),
    participant,
  );

  const sale: Sale = {
    scenario: "E2E-042",
    venue: "aftermath",
    memeType: token.memeType,
    quoteType: SUI_TYPE,
    presale: {
      objectId: presaleId,
      initialSharedVersion: sharedVersion(executed, presaleId),
    },
    capId,
    currency: token.currency,
    creationDigest: executed.digest,
    tokenRegistrationDigest: registration,
    lpType: lp.lpType,
    createPoolCap: lp.createPoolCap,
    poolCreation: {
      objectId: poolCreationId,
      initialSharedVersion: sharedVersion(executed, poolCreationId),
    },
    participant,
    feeRecipient,
  };
  state.sale = sale;
  save(state);
  return sale;
}

/** One commitment of the whole raise closes the sale under its hard cap; then `settle` funds it. */
async function fund(
  state: State,
  participant: Ed25519Keypair,
  sale: Sale,
): Promise<void> {
  if (state.migration) return;
  const launch = {
    memeType: sale.memeType,
    quoteType: sale.quoteType,
    presale: mut(sale.presale),
  };
  if (!hasReceipt("E2E-042 commit"))
    await refuse(
      state,
      "settle-before-filled",
      participant,
      presale.tx.settle(launch),
      "blast_presale",
      7,
    );
  {
    const committed = await step(
      state,
      "commit",
      participant,
      presale.tx.commit({
        ...launch,
        amount: RAISE,
        recipient: sale.participant,
        route: "open",
      }),
    );
    const commitment = event(committed, "Committed");
    verify(
      state,
      "the commitment is the whole raise",
      u64(commitment.quote) === RAISE &&
        u64(commitment.total_commitments) === RAISE,
      commitment,
    );
  }
  const settled = await step(
    state,
    "settle",
    participant,
    presale.tx.settle(launch),
  );
  const funded = event(settled, "PresaleFunded");
  verify(
    state,
    "PresaleFunded accepts the raise with no overflow",
    u64(funded.accepted_quote) === RAISE &&
      u64(funded.refundable_quote) === 0n &&
      u64(funded.total_commitments) === RAISE,
    funded,
  );
  equal(
    "lifecycle Funded",
    (await presale.getPresale(sale.presale.objectId)).lifecycle,
    "Funded",
  );
}

/** Dev-inspects `aftermath::migrate`, executes it, and checks the Quote-first pool, vault and custody. */
async function migrate(
  state: State,
  keeper: Ed25519Keypair,
  sale: Sale,
): Promise<Migration> {
  if (state.migration) return state.migration;
  const poolRegistry = await sharedRef(AFTERMATH.poolRegistry);
  const daoFeeVersion = await sharedRef(AFTERMATH.daoFeeVersion);
  const build = () =>
    presale.tx.migrateNativeAftermath({
      ...sale,
      presale: mut(sale.presale),
      poolCreation: mut(sale.poolCreation),
      aftermathObjects: { poolRegistry, daoFeeVersion },
    });
  if (!hasReceipt("E2E-042 migrate"))
    await expectSuccess(
      "validated simulation aftermath::migrate, Quote-first",
      keeper,
      build(),
    );
  state.simulatedSuccesses.push("migrate");
  save(state);
  const executed = await step(state, "migrate", keeper, build());

  const migrated = event(executed, "PresaleMigrated");
  verify(
    state,
    "PresaleMigrated names the adapter's witness",
    tag(String(migrated.migration_witness)) === WITNESS,
    migrated,
  );
  const dao = event(executed, "DaoFeePoolCreated");
  const vaultEvent = event(executed, "VaultCreated");
  verify(
    state,
    "VaultCreated's venue is aftermath::Venue",
    typeParams(executed, "VaultCreated")[2] === VENUE,
    typeParams(executed, "VaultCreated"),
  );
  verify(
    state,
    "VaultCreated and DaoFeePoolCreated agree on the vault, base pool and position",
    vaultEvent.vault_id === dao.vault_id &&
      vaultEvent.pool_id === dao.pool_id &&
      vaultEvent.position_id === dao.owner_cap_id &&
      vaultEvent.presale_id === sale.presale.objectId,
    { vaultEvent, dao },
  );
  const poolCreated = event(executed, "CreatedPoolEvent");
  const createdPoolCoins = (poolCreated.coins as string[]).map((coin) =>
    tag(coin),
  );
  verify(
    state,
    "executed branch: Aftermath's pool lists SUI first",
    createdPoolCoins[0] === SUI_TYPE && createdPoolCoins[1] === sale.memeType,
    createdPoolCoins,
  );
  const daoCreated = event(executed, "CreatedDaoFeePoolEvent");
  verify(
    state,
    "the DAO-fee pool pays the vault the recorded fee",
    Number(daoCreated.fee_bps) === DAO_FEE_BPS &&
      normalizeSuiAddress(String(daoCreated.fee_recipient)) ===
        normalizeSuiAddress(String(dao.vault_id)) &&
      daoCreated.inner_pool_id === dao.pool_id,
    daoCreated,
  );
  const lpCoinOwner = ownerOf(executed, String(dao.lp_coin_id)) ?? null;
  verify(state, "the LP coin is owned by 0x0", lpCoinOwner === ZERO_ADDRESS, {
    lpCoinId: dao.lp_coin_id,
    lpCoinOwner,
  });
  const vaultId = String(dao.vault_id);
  const daoFeePoolId = String(dao.dao_fee_pool_id);
  const poolId = String(dao.pool_id);
  const ownerCapOwner = outputOwner(executed, String(dao.owner_cap_id));
  check("OwnerCap is object-owned", ownerCapOwner?.$kind === "ObjectOwner");
  const { object: position } = await client.core.getObject({
    objectId:
      ownerCapOwner?.$kind === "ObjectOwner" ? ownerCapOwner?.ObjectOwner : "",
  });
  verify(
    state,
    "OwnerCap is the vault position under aftermath::Venue",
    position.owner.$kind === "ObjectOwner" &&
      position.owner.ObjectOwner === vaultId &&
      normalizeStructTag(position.type).includes(VENUE),
    {
      ownerCapOwner,
      positionType: position.type,
      positionOwner: position.owner,
    },
  );
  const vaultState = await presale.getVault(vaultId);
  verify(
    state,
    "the vault's pool is the base pool and its presale is this sale",
    vaultState.poolId === poolId &&
      vaultState.presaleId === sale.presale.objectId,
    vaultState,
  );
  equal(
    "lifecycle Migrated",
    (await presale.getPresale(sale.presale.objectId)).lifecycle,
    "Migrated",
  );

  const liquidityTokens = u64(migrated.liquidity_tokens);
  const liquidityQuote = u64(migrated.liquidity_quote);
  const balances = await poolBalances(poolId, sale);
  verify(
    state,
    "amm::pool::balance_of equals PresaleMigrated's hand-off for both coins",
    balances.meme === liquidityTokens && balances.quote === liquidityQuote,
    { balances, liquidityTokens, liquidityQuote },
  );
  const poolTypeNames = await poolTypeNamesOf(poolId);
  if (poolTypeNames) {
    verify(
      state,
      "the base pool object's first type name is SUI",
      tag(poolTypeNames[0] ?? "") === SUI_TYPE,
      poolTypeNames,
    );
  }

  const migration: Migration = {
    digest: executed.digest,
    vaultId,
    vault: {
      objectId: vaultId,
      initialSharedVersion: sharedVersion(executed, vaultId),
    },
    poolId,
    daoFeePool: {
      objectId: daoFeePoolId,
      initialSharedVersion: sharedVersion(executed, daoFeePoolId),
    },
    ownerCapId: String(dao.owner_cap_id),
    ownerCapOwner,
    lpCoinId: String(dao.lp_coin_id),
    lpCoinOwner,
    liquidity: String(vaultEvent.liquidity),
    liquidityTokens: liquidityTokens.toString(),
    liquidityQuote: liquidityQuote.toString(),
    createdPoolCoins,
    poolTypeNames,
    balanceOfMeme: balances.meme.toString(),
    balanceOfQuote: balances.quote.toString(),
    balanceOfSource: balances.source,
  };
  state.migration = migration;
  save(state);
  return migration;
}

/** One small swap each way on the DAO-fee pool; each sends its DAO fee as a coin to the vault's address. */
async function swaps(
  state: State,
  swapper: Ed25519Keypair,
  sale: Sale,
  migration: Migration,
): Promise<void> {
  if (state.swaps) return;
  const buy = await swap(state, swapper, sale, migration, "buy", BUY_IN);
  const sell = await swap(
    state,
    swapper,
    sale,
    migration,
    "sell",
    BigInt(buy.amountOut) / 2n,
  );
  state.swaps = { buy, sell };
  save(state);
}

async function swap(
  state: State,
  swapper: Ed25519Keypair,
  sale: Sale,
  migration: Migration,
  direction: "buy" | "sell",
  amountIn: bigint,
): Promise<Swap> {
  const [coinIn, coinOut] =
    direction === "buy"
      ? [sale.quoteType, sale.memeType]
      : [sale.memeType, sale.quoteType];
  const objects = {
    daoFeeVersion: await sharedRef(AFTERMATH.daoFeeVersion),
    poolRegistry: await sharedRef(AFTERMATH.poolRegistry),
    protocolFeeVault: await sharedRef(SWAP_OBJECTS.protocolFeeVault),
    treasury: await sharedRef(SWAP_OBJECTS.treasury),
    insuranceFund: await sharedRef(SWAP_OBJECTS.insuranceFund),
    referralVault: await sharedRef(SWAP_OBJECTS.referralVault),
  };
  const build = (expectedOut: bigint, slippage: bigint) => {
    const tx = new Transaction();
    const input =
      direction === "buy"
        ? (tx.splitCoins(tx.gas, [amountIn])[0] as TransactionArgument)
        : tx.coin({ type: coinIn, balance: amountIn });
    const out = tx.moveCall({
      target: `${DAO_FEE.current}::swap::swap_exact_in`,
      typeArguments: [sale.lpType, coinIn, coinOut],
      arguments: [
        tx.sharedObjectRef({ ...migration.daoFeePool, mutable: true }),
        tx.sharedObjectRef({ ...objects.daoFeeVersion, mutable: false }),
        tx.sharedObjectRef({ ...objects.poolRegistry, mutable: false }),
        tx.sharedObjectRef({ ...objects.protocolFeeVault, mutable: false }),
        tx.sharedObjectRef({ ...objects.treasury, mutable: true }),
        tx.sharedObjectRef({ ...objects.insuranceFund, mutable: true }),
        tx.sharedObjectRef({ ...objects.referralVault, mutable: false }),
        input,
        tx.pure.u64(expectedOut),
        tx.pure.u64(slippage),
      ],
    });
    tx.transferObjects([out], swapper.toSuiAddress());
    return tx;
  };
  let expectedOut = 1n;
  if (!hasReceipt(`E2E-042 swap-${direction}`)) {
    const quote = build(1n, 1_000_000_000_000_000_000n);
    quote.setSender(swapper.toSuiAddress());
    quote.setGasBudget(100_000_000n);
    const simulated = await client.core.simulateTransaction({
      transaction: quote,
      checksEnabled: true,
      include: {
        effects: true,
        events: true,
        balanceChanges: true,
        objectTypes: true,
      },
    });
    if (simulated.$kind !== "Transaction")
      throw new Error(
        `Swap quote failed: ${simulated.FailedTransaction.status.error?.message}`,
      );
    expectedOut = swapOutput(
      simulated.Transaction,
      swapper.toSuiAddress(),
      coinOut,
      direction === "sell",
    );
    check(`${direction}: simulated quote is positive`, expectedOut > 0n);
  }
  const executed = await step(
    state,
    `swap-${direction}`,
    swapper,
    build(expectedOut, SWAP_SLIPPAGE),
  );
  const amountOut = swapOutput(
    executed,
    swapper.toSuiAddress(),
    coinOut,
    direction === "sell",
  );
  const feeCoinIds = createdAll(executed, `0x2::coin::Coin<${coinIn}>`).filter(
    (id) => ownerOf(executed, id) === migration.vaultId,
  );
  // The vault is an object, so its receipts are read from the coins themselves.
  let feeAmount = 0n;
  for (const id of feeCoinIds) feeAmount += await coinBalance(id);
  const expectedFee = (amountIn * BigInt(DAO_FEE_BPS)) / 10_000n;
  verify(
    state,
    `${direction}: the DAO fee arrives as one coin at the vault's address`,
    feeCoinIds.length === 1 && feeAmount === expectedFee && amountOut > 0n,
    { feeCoinIds, feeAmount, expectedFee, amountOut },
  );
  return {
    digest: executed.digest,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    feeCoinIds,
    feeAmount: feeAmount.toString(),
    expectedFee: expectedFee.toString(),
  };
}

/** SUI balance deltas include gas; add net gas back to isolate swap output. */
function swapOutput(
  executed: Executed,
  owner: string,
  coinOut: string,
  outputIsSui: boolean,
): bigint {
  const gas = executed.effects.gasUsed;
  const netGas =
    BigInt(gas.computationCost) +
    BigInt(gas.storageCost) -
    BigInt(gas.storageRebate);
  return balanceChange(executed, owner, coinOut) + (outputIsSui ? netGas : 0n);
}

/** `aftermath::collect_fees` with every fee coin the vault's address owns; the split must equal the receipts. */
async function collect(
  state: State,
  relayer: Ed25519Keypair,
  sale: Sale,
  migration: Migration,
): Promise<void> {
  if (state.collect) return;
  const memeCoins =
    state.pendingCollection?.meme ??
    (await ownedCoins(migration.vaultId, sale.memeType));
  const quoteCoins =
    state.pendingCollection?.quote ??
    (await ownedCoins(migration.vaultId, sale.quoteType));
  // Snapshot before consuming Receiving inputs, so an interrupted collection can reconcile.
  state.pendingCollection = { meme: memeCoins, quote: quoteCoins };
  save(state);
  const sum = (list: OwnedCoin[]) =>
    list.reduce((total, coin) => total + BigInt(coin.balance), 0n);
  verify(
    state,
    "the vault's address owns the fee coins of both swaps",
    memeCoins.length >= 1 && quoteCoins.length >= 1,
    { memeCoins, quoteCoins },
  );
  const build = (meme: OwnedCoin[], quote: OwnedCoin[]) =>
    presale.tx.collectNativeAftermathFees({
      ...sale,
      vault: { ...migration.vault, mutable: true },
      memeFees: meme,
      quoteFees: quote,
    });
  const executed = await step(
    state,
    "collect-fees",
    relayer,
    build(memeCoins, quoteCoins),
  );
  const collected = event(executed, "FeesCollected");
  const grossMeme = u64(collected.gross_meme);
  const grossQuote = u64(collected.gross_quote);
  const recipientMeme = (collected.fee_recipient_meme as unknown[]).map(u64);
  const recipientQuote = (collected.fee_recipient_quote as unknown[]).map(u64);
  const total = (list: bigint[]) =>
    list.reduce((sum, value) => sum + value, 0n);
  verify(
    state,
    "FeesCollected's gross amounts are exactly the coins received",
    grossMeme === sum(memeCoins) && grossQuote === sum(quoteCoins),
    { collected, memeCoins, quoteCoins },
  );
  verify(
    state,
    "FeesCollected splits every unit between Blast, the recipient and the holder share",
    u64(collected.protocol_meme) +
      total(recipientMeme) +
      u64(collected.holder_rewards_meme) ===
      grossMeme &&
      u64(collected.protocol_quote) +
        total(recipientQuote) +
        u64(collected.holder_rewards_quote) ===
        grossQuote,
    collected,
  );
  verify(
    state,
    "the fee recipient received its split as coins",
    balanceChange(executed, sale.feeRecipient, sale.memeType) ===
      total(recipientMeme) &&
      balanceChange(executed, sale.feeRecipient, sale.quoteType) ===
        total(recipientQuote),
    executed.balanceChanges,
  );
  const vaultState = await presale.getVault(migration.vaultId);
  verify(
    state,
    "holder Meme goes to treasury and holder Quote stays in the vault",
    vaultState.holderRewardsMeme === 0n &&
      vaultState.holderRewardsQuote === u64(collected.holder_rewards_quote) &&
      balanceChange(
        executed,
        String(collected.protocol_destination),
        sale.memeType,
      ) ===
        u64(collected.protocol_meme) +
          u64(collected.holder_rewards_meme) +
          (collected.protocol_destination === sale.feeRecipient
            ? total(recipientMeme)
            : 0n),
    {
      holderRewardsMeme: vaultState.holderRewardsMeme,
      holderRewardsQuote: vaultState.holderRewardsQuote,
    },
  );
  // An empty collection is valid and moves nothing.
  const repeated = await step(
    state,
    "collect-fees-empty",
    relayer,
    build([], []),
  );
  const repeatEvents = events(repeated, "FeesCollected").length;
  verify(
    state,
    "an empty collection emits no FeesCollected",
    repeatEvents === 0,
    repeatEvents,
  );
  state.collect = {
    digest: executed.digest,
    memeCoins: memeCoins.map((coin) => coin.objectId),
    quoteCoins: quoteCoins.map((coin) => coin.objectId),
    grossMeme: grossMeme.toString(),
    grossQuote: grossQuote.toString(),
    event: collected,
    recipientMeme: total(recipientMeme).toString(),
    recipientQuote: total(recipientQuote).toString(),
    repeatDigest: repeated.digest,
    repeatEvents,
  };
  save(state);
}

/** The participant claims its whole allocation; a second claim is refused. */
async function claim(
  state: State,
  relayer: Ed25519Keypair,
  sale: Sale,
): Promise<void> {
  if (state.claim) return;
  const launch = {
    memeType: sale.memeType,
    quoteType: sale.quoteType,
    presale: mut(sale.presale),
  };
  const executed = await step(
    state,
    "claim",
    relayer,
    presale.tx.claim({ ...launch, participants: [sale.participant] }),
  );
  const claimed = event(executed, "Claimed");
  const expected = (SUPPLY * TOKEN_ALLOCATION_BPS) / 10_000n;
  verify(
    state,
    "the only participant receives the whole token allocation and no refund",
    u64(claimed.tokens) === expected &&
      u64(claimed.quote_refund) === 0n &&
      balanceChange(executed, sale.participant, sale.memeType) === expected,
    claimed,
  );
  await refuse(
    state,
    "claim-twice",
    relayer,
    presale.tx.claim({ ...launch, participants: [sale.participant] }),
    "blast_presale",
    14,
  );
  state.claim = {
    digest: executed.digest,
    tokens: String(claimed.tokens),
    quoteRefund: String(claimed.quote_refund),
  };
  save(state);
}

/** Admissions were restored in creation; retire only this run's temporary AdminCap. */
async function cleanup(state: State): Promise<void> {
  if (!state.adminCap) throw new Error("No temporary AdminCap to clean up");
  await verifyPolicy(state);
  const admin = administrator();
  const sponsor = sponsorFor(admin);
  const done = state.cleanup ?? {};
  if (!done.revokeAdmin) {
    done.revokeAdmin = (
      await step(
        state,
        "revoke-admin",
        admin,
        acl.revokeAdmin({
          superAdminCapId: SUPER_ADMIN_CAP,
          adminCapId: state.adminCap,
        }),
        sponsor,
      )
    ).digest;
    state.cleanup = done;
    save(state);
  }
  if (!done.destroyAdminCap) {
    done.destroyAdminCap = (
      await step(
        state,
        "destroy-admin-cap",
        deployer(),
        acl.destroyAdminCap({ adminCapId: state.adminCap }),
      )
    ).digest;
    state.cleanup = done;
    save(state);
  }
  verify(
    state,
    "temporary ACL grant removed",
    !(state.adminCap in (await aclAdmins()).admins),
  );
}
async function verifyPolicy(state: State): Promise<void> {
  const after = await presale.getCreationPolicy();
  const same = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify(a.map(tag).sort()) === JSON.stringify(b.map(tag).sort());
  verify(
    state,
    "creation admissions equal the pre-run baseline",
    !!state.baseline &&
      same(after.allowedQuotes, state.baseline.allowedQuotes) &&
      same(
        after.allowedMigrationWitnesses,
        state.baseline.allowedMigrationWitnesses,
      ),
    after,
  );
}

// === Record ===

/** Prints the normalized deployment record (contracts `deployments/README.md`), from the run state and the ledger. */
async function printRecord(state: State): Promise<void> {
  const {
    lp,
    sale,
    migration,
    swaps: swapped,
    collect: collected,
    claim: claimed,
  } = state;
  if (
    !lp ||
    !sale ||
    !migration ||
    !swapped ||
    !collected ||
    !claimed ||
    !state.cleanup?.destroyAdminCap ||
    state.checks.some((check) => !check.pass)
  ) {
    throw new Error(
      "the run is incomplete; finish `e042` before `e042 record`",
    );
  }
  await verifyPolicy(state);
  const transactions = [];
  for (const tx of state.transactions)
    transactions.push(await recordedTransaction(tx));
  const gas = state.transactions.reduce(
    (sum, tx) => sum + BigInt(tx.netGasMist),
    0n,
  );
  const operators = CONFIG.operators;
  const output = {
    schemaVersion: 1,
    recordKind: "sui-presale-e2e-verification",
    release: "blast-presale-aftermath-quote-first-e2e",
    purpose:
      "E2E-042: mainnet test-only verification of blast_presale::aftermath::migrate in the Quote-first coin order on the explicitly configured final FinalizeTicket publication.",
    network: {
      chain: "sui",
      environment: "mainnet",
      chainIdentifierHex: "35834a8a",
    },
    recordedAtUtc: new Date().toISOString(),
    repository: {
      publicationCommit: CONFIG.contractsCommit,
      publicationDigest: CONFIG.publicationDigest,
    },
    sdkCommitTested: gitHead(),
    sdkWorkingTree: execFileSync("git", ["status", "--porcelain"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    }).trim(),
    finalizeTicket: {
      abiGatePassed: true,
      initializerResult: 0,
      ticketResult: 1,
      finalizeTicketArgument: 2,
    },
    toolchain: {
      node: process.version,
      suiCli: process.env.E2E_SUI_CLI ?? null,
    },
    deployer: operators.deployer ?? null,
    sponsoredAdministrator: operators.administrator ?? null,
    status: "success",
    deployment: {
      ...DEPLOYMENT,
      aftermath: {
        ammPackageId: AMM.current,
        ammOriginalPackageId: AMM.original,
        daoFeePackageId: DAO_FEE.current,
        daoFeeOriginalPackageId: DAO_FEE.original,
        poolRegistry: await sharedRef(AFTERMATH.poolRegistry),
        daoFeeVersion: await sharedRef(AFTERMATH.daoFeeVersion),
      },
    },
    packages: {
      testkit: { packageId: TESTKIT },
      lpCoin: {
        ...lp,
        dependencies: AFTERMATH_LP_PACKAGE_DEPENDENCIES,
        bytecode: "SDK pinned Aftermath LP template",
      },
    },
    testAdmin: {
      objectId: state.adminCap ?? null,
      owner: operators.deployer,
      presaleRoles: ROLES,
      finalStatus: state.cleanup?.destroyAdminCap
        ? "revoked and destroyed"
        : "live",
    },
    sale: {
      ...sale,
      raiseTarget: RAISE.toString(),
      tokenSupply: SUPPLY.toString(),
      daoFeeBps: DAO_FEE_BPS,
      eligibility: {
        kind: "open",
        walletCap: RAISE.toString(),
        maxParticipants: "1",
        minCommitment: RAISE.toString(),
      },
      hardCap: { startsAfterMs: "0", closesWhenFilled: true },
      feeSplit: {
        feeRecipientBps: FEE_RECIPIENT_BPS.toString(),
        holderRewardsBps: HOLDER_REWARDS_BPS.toString(),
      },
    },
    coinOrder: {
      sdk: {
        saleTokenFirst: aftermathSaleTokenFirst(sale.memeType, SUI),
        poolCoinTypes: aftermathPoolCoinTypes(sale.memeType, SUI),
      },
      executed: {
        createdPoolEventCoins: migration.createdPoolCoins,
        poolTypeNames: migration.poolTypeNames,
        quoteFirst: true,
      },
    },
    vault: migration,
    swaps: swapped,
    feeCollection: collected,
    claim: claimed,
    transactions,
    simulatedSuccesses: state.simulatedSuccesses,
    negativeSimulations: state.negativeSimulations.map((entry) => ({
      ...entry,
      validationEnabled: true,
    })),
    checks: state.checks,
    accounting: {
      netGasMist: gas.toString(),
      raisedSuiMist: RAISE.toString(),
      swapBuySuiMist: BUY_IN.toString(),
      aftermathSwapDaoFeeBps: DAO_FEE_BPS,
    },
    cleanup: {
      ...(state.cleanup ?? {}),
      policyAfter: await presale.getCreationPolicy(),
      productionRoutingChanged: false,
    },
    limitations: [
      "This run covers SUI-first. Older signed and simulated evidence is listed separately and does not count as final-package execution.",
    ],
    priorEvidence: PRIOR_EVIDENCE,
    rawEvidence: `${process.env.E2E_STATE ?? "e2e/presale-mainnet/state.local.json"}.transactions`,
  };
  const text = JSON.stringify(
    output,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  if (process.env.E2E_RECORD_OUT)
    writeFileSync(process.env.E2E_RECORD_OUT, `${text}\n`);
  console.log(text);
}

// === Helpers ===

async function recordedTransaction(tx: Tx) {
  const live = await client.core.getTransaction({
    digest: tx.digest,
    include: { effects: true },
  });
  check(
    `record receipt ${tx.action} succeeded`,
    live.$kind === "Transaction" && live.Transaction.effects.status.success,
  );
  const { response } = await client.ledgerService.getTransaction({
    digest: tx.digest,
    readMask: { paths: ["checkpoint", "timestamp"] },
  });
  const timestamp = response.transaction?.timestamp;
  check(
    `record receipt ${tx.action} is checkpointed`,
    !!response.transaction?.checkpoint && !!timestamp,
  );
  return {
    ...tx,
    checkpoint: response.transaction?.checkpoint?.toString() ?? null,
    timestampMs: timestamp
      ? String(
          BigInt(timestamp.seconds) * 1000n +
            BigInt(Math.floor((timestamp.nanos ?? 0) / 1e6)),
        )
      : null,
    validationEnabled: true,
  };
}

function load(): State {
  return (
    stateValue<State>(KEY) ?? {
      simulatedSuccesses: [],
      negativeSimulations: [],
      transactions: [],
      checks: [],
    }
  );
}

function save(state: State): void {
  saveStateValue(KEY, state);
}

/** Executes `tx` and keeps its receipt in the run state. */
async function step(
  state: State,
  action: string,
  signer: Ed25519Keypair,
  tx: Transaction | (() => Promise<Transaction>),
  sponsor?: Ed25519Keypair,
): Promise<Executed> {
  const executed = await exec(
    `E2E-042 ${action}`,
    signer,
    typeof tx === "function"
      ? hasReceipt(`E2E-042 ${action}`)
        ? new Transaction()
        : await tx()
      : tx,
    sponsor ? { sponsor } : {},
  );
  const used = executed.effects?.gasUsed;
  const netGasMist = used
    ? BigInt(used.computationCost) +
      BigInt(used.storageCost) -
      BigInt(used.storageRebate)
    : 0n;
  if (!state.transactions.some((tx) => tx.digest === executed.digest))
    state.transactions.push({
      action,
      digest: executed.digest,
      sender: signer.toSuiAddress(),
      gasOwner: (sponsor ?? signer).toSuiAddress(),
      netGasMist: netGasMist.toString(),
    });
  save(state);
  return executed;
}

/** A check kept in the run state; a failure stops the run. */
function verify(
  state: State,
  id: string,
  pass: boolean,
  detail?: unknown,
): void {
  const index = state.checks.findIndex((check) => check.id === id);
  if (index >= 0) state.checks[index] = { id, pass, detail };
  else state.checks.push({ id, pass, detail });
  save(state);
  check(id, pass, detail);
}

/** Simulates an expected abort and keeps it in the run state. */
async function refuse(
  state: State,
  action: string,
  signer: Ed25519Keypair,
  tx: Transaction,
  module: string,
  code: number,
): Promise<void> {
  await expectAbort(`E2E-042 ${action}`, signer, tx, { module, code });
  state.negativeSimulations.push({ action, module, code });
  save(state);
}

/** Dev-inspects `tx` as `sender` with ownership checks off and requires success. */
async function inspect(
  label: string,
  tx: Transaction,
  sender: string,
): Promise<Executed> {
  tx.setSender(sender);
  tx.setGasBudget(500_000_000);
  const result = await client.core.simulateTransaction({
    transaction: tx,
    checksEnabled: false,
    include: {
      effects: true,
      events: true,
      balanceChanges: true,
      objectTypes: true,
    },
  });
  const simulated = result.Transaction ?? result.FailedTransaction;
  record({
    kind: "dev-inspect",
    label,
    pass: result.$kind === "Transaction",
    status: simulated.status,
    events: simulated.events?.map((entry) => entry.eventType),
  });
  check(
    `${label} (dev-inspect)`,
    result.$kind === "Transaction",
    simulated.status,
  );
  return simulated;
}

/** The deployer sponsors the administrator's gas unless they are the same wallet. */
function sponsorFor(admin: Ed25519Keypair): Ed25519Keypair | undefined {
  const sponsor = deployer();
  return sponsor.toSuiAddress() === admin.toSuiAddress() ? undefined : sponsor;
}

function publishTx(publisher: string): Transaction {
  return publishAftermathLpCoin({
    symbol: "E042LP",
    name: "E2E 042 final LP",
    description: "Final native Aftermath SUI-first verification",
    upgradeCapRecipient: publisher,
  });
}

async function sharedRef(objectId: string): Promise<Shared> {
  const { object } = await client.core.getObject({ objectId });
  if (object.owner.$kind !== "Shared")
    throw new Error(`${objectId} is not shared`);
  return {
    objectId,
    initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
  };
}

/** A Move type's name in the form every event and object reports it, with `0x` and 64 hex digits. */
function tag(type: string): string {
  return normalizeStructTag(type.startsWith("0x") ? type : `0x${type}`);
}

/** The normalized type arguments of the one event of `executed` named `name`. */
function typeParams(executed: Executed, name: string): string[] {
  const found = (executed.events ?? []).filter((entry) =>
    entry.eventType.split("<")[0]?.endsWith(`::${name}`),
  );
  if (found.length !== 1)
    throw new Error(`expected one ${name} event, found ${found.length}`);
  const type = found[0]?.eventType ?? "";
  const inner = type.slice(type.indexOf("<") + 1, type.lastIndexOf(">"));
  return inner.split(/,\s*/).map((param) => tag(param.trim()));
}

function outputOwner(executed: Executed, objectId: string) {
  return executed.effects?.changedObjects.find(
    (entry) => entry.objectId === objectId,
  )?.outputOwner;
}

function ownerOf(executed: Executed, objectId: string): string | undefined {
  const owner = outputOwner(executed, objectId);
  return owner?.$kind === "AddressOwner"
    ? normalizeSuiAddress(owner.AddressOwner)
    : undefined;
}

type OwnedCoin = {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
};

async function coinBalance(objectId: string): Promise<bigint> {
  const { object } = await client.core.getObject({
    objectId,
    include: { json: true },
  });
  return BigInt(String((object.json as { balance: string | number }).balance));
}

/** Every `Coin<coinType>` owned by `owner`, oldest page first. */
async function ownedCoins(
  owner: string,
  coinType: string,
): Promise<OwnedCoin[]> {
  const found: OwnedCoin[] = [];
  let cursor: string | null = null;
  do {
    const page: SuiClientTypes.ListOwnedObjectsResponse<{ json: true }> =
      await client.core.listOwnedObjects({
        owner,
        type: `0x2::coin::Coin<${coinType}>`,
        cursor,
        include: { json: true },
      });
    for (const object of page.objects) {
      found.push({
        objectId: object.objectId,
        version: String(object.version),
        digest: object.digest,
        balance: BigInt(
          String((object.json as { balance: string | number }).balance),
        ),
      });
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return found;
}

/**
 * `amm::pool::balance_of<Lp, Coin>` for both coins through a dev-inspect of the live AMM; when
 * the pool, a child of the DAO-fee pool, is refused as an input, the pool object's own
 * `normalized_balances` divided by its `decimal_scalars`, in its `type_names` order.
 */
async function poolBalances(
  poolId: string,
  sale: Sale,
): Promise<{ meme: bigint; quote: bigint; source: string }> {
  const sender = CONFIG.operators.deployer;
  const read = async (coinType: string) => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${AMM.current}::pool::balance_of`,
      typeArguments: [sale.lpType, coinType],
      arguments: [tx.object(poolId)],
    });
    tx.setSender(sender);
    tx.setGasBudget(50_000_000);
    const result = await client.core.simulateTransaction({
      transaction: tx,
      checksEnabled: false,
      include: { commandResults: true },
    });
    if (result.$kind !== "Transaction")
      throw new Error(JSON.stringify(result.FailedTransaction.status));
    const value = result.commandResults?.[0]?.returnValues[0]?.bcs;
    if (!value) throw new Error("balance_of returned nothing");
    return BigInt(bcs.u64().parse(value));
  };
  try {
    return {
      meme: await read(sale.memeType),
      quote: await read(sale.quoteType),
      source: "dev-inspect amm::pool::balance_of",
    };
  } catch (error) {
    record({
      kind: "note",
      label: "balance_of dev-inspect unavailable; reading the pool object",
      error: String(error),
    });
    const { object } = await client.core.getObject({
      objectId: poolId,
      include: { json: true },
    });
    const pool = object.json as {
      type_names: string[];
      normalized_balances: string[];
      decimal_scalars: string[];
    };
    const at = (coinType: string) => {
      const index = pool.type_names.findIndex((name) => tag(name) === coinType);
      if (index < 0)
        throw new Error(`${coinType} is not a coin of pool ${poolId}`);
      return (
        BigInt(pool.normalized_balances[index] ?? "0") /
        BigInt(pool.decimal_scalars[index] ?? "1")
      );
    };
    return {
      meme: at(sale.memeType),
      quote: at(sale.quoteType),
      source: "pool object normalized_balances / decimal_scalars",
    };
  }
}

/** The AMM pool object's recorded coin type names, when its JSON exposes them. */
async function poolTypeNamesOf(poolId: string): Promise<string[] | null> {
  const { object } = await client.core.getObject({
    objectId: poolId,
    include: { json: true },
  });
  const names = (object.json as { type_names?: unknown }).type_names;
  return Array.isArray(names) ? names.map(String) : null;
}

async function aclAdmins() {
  return getAcl(
    client,
    ADMIN_DEPLOYMENT.acl.objectId,
    ADMIN_DEPLOYMENT.packageId,
  );
}

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}
