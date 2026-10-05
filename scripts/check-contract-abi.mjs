import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_COMMIT = "a5ed34ad49c6c001af2db5b9cbcb206075704412";
const LAUNCHPAD_BASELINE = {
  contractsCommit: BASELINE_COMMIT,
  workingTreeDifferedAtFreeze: true,
  abiNeutralDifferences: [
    "sui/meme_template/Move.lock",
    "docs/research/sui-deepbook-indexer-architecture-2026.md",
  ],
};
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDeclarations = [
  {
    path: "production-launchpad-v1.json",
    packages: [
      ["launchpad", "launchpad", "blast_fun"],
      ["memeTemplate", "meme_template", "meme_template"],
      ["migrators", "migrators", "blast_fun_migrators"],
    ],
    approvedAbiAmendments: [
      "contracts ADR 0011: compact replay-complete event payloads before release",
      "contracts ADR 0027: make protocol ownership explicit in Quote migration fee names",
      "contracts ADR 0067: retire the Full Sail migrator before release",
      "contracts ADR 0068: compact the LP-fee principal snapshot before release",
      "contracts ADR 0069: consolidate launch graduation and move migration math into migrators",
      "contracts ADR 0079: remove redundant launch event totals and history",
      "contracts ADR 0080: make creator recipients provider-independent",
      "contracts ADR 0085: name every explorer-visible type after Blast",
      "contracts ADR 0088: reusable launch accounting, allocation plans, protected public buys, and atomic migration",
      "contracts ADR 0089: start launches in the migration adapter and move every post-migration fee path into the migrators package",
      "contracts ADR 0090: a minimal launchpad surface — trimmed getters, recipient allocation plans, merged config setters and events, renumbered errors, one migration call",
      "contracts ADR 0091: a burn part in the LP-fee split, with admin buyback and burn",
      "contracts ADR 0100: one generic Cetus route per operation over <Meme, Quote, CoinA, CoinB>, replacing the _meme_a/_meme_b pairs",
      "contracts ADR 0090 (redundancy audit): framework aborts replace duplicate checks; Migrated drops native_supply_burned, the holder-reward Round drops its checkpoints and manifest digest, CreatorClaimMessage drops copy",
      "contracts ADR 0092: the creator sets the virtual Quote reserve on the initializer; LaunchConfig admits Quotes in a Table and QuoteSet records allowed",
      "contracts ADR 0093: an optional opening round replaces purchase protection; buy no longer takes the Clock",
      "contracts ADRs 0094 and 0097: every administrator action takes blast_admin::blast_acl::AdminWitness of its own typed blast_fun_domain role",
      "contracts ADR 0098: a SUI creation fee paid at finalize, one ADR 0095 partner per launch paid at Blast's claim, and Blast's migration fee accrued in the launch ledger from an always-set ProtocolAllocation",
      "contracts ADR 0097 (amended 2026-10-02): each package's PackageVersion lives in its one-time-witness module, blast_fun::PackageVersion and blast_fun_migrators::PackageVersion, seeded from that witness",
      "contracts ADR 0105: anyone claims Blast's launch fees, paid to the partner and to a RuntimeConfig treasury that runtime_config::set_treasury (TreasuryAdmin) rotates; ProtocolFeesClaimed records the treasury and TreasuryChanged records each rotation",
      "contracts ADR 0107: the LpVault inherits launch::partner_id and, when partnered, holds Blast's LP fees until anyone calls vault::claim_protocol_lp_fees_with_partner; FeesCollected.protocol_destination becomes optional and ProtocolLpFeesClaimed records each claim",
    ],
  },
  {
    path: "production-presale-v1.json",
    // The presale package is unpublished, so it is frozen at the contracts
    // commit it follows: ADRs 0099 through 0102, team vesting, the
    // package's own two-tier administration (contracts PR 45), the AdminCap's
    // per-vault LP-fee rates, the package-internal Merkle check, and the
    // scheduled start with the AdminCap's per-sale rates before it.
    baseline: {
      contractsCommit: "55e1ac0841535e708554cb45f9c67ab20f6e979a",
      workingTreeDifferedAtFreeze: false,
    },
    approvedAbiAmendments: [
      "contracts ADR 0099 (amended 2026-10-05): optional participant vesting; new takes Option<VestingTerms> after the sale's token rate, claim takes the Clock and locks each participant's tokens in a schedule from the claim, and Claimed carries its vesting_id",
      "contracts ADR 0104: blast_presale::new and migrate are public so a migrator in another package creates and migrates sales with its own allowed witness",
      "contracts ADR 0106: one Blast partner per presale, named by set_partner before the share and accepted by creation_policy::add_partner and remove_partner; a partnered migration holds Blast's shares for pay_partner, PresaleOpened gains partner_id, and ProtocolFeesPaid gains partner_quote",
      "contracts ADR 0099 (owner-requested cleanup, 2026-10-05): Presale derives its windows from start_ms, counts participants down as they claim (Claimed reports remaining_participants), and holds the LP-fee split as one FeeSplit that new, cetus::new, and bluefin::new take, built by blast_presale::fee_split; PresaleVault holds the same FeeSplit",
      "contracts ADR 0104 (amended 2026-10-05): set_migration_witness_allowed also rejects witness types defined at 0x1 and 0x2",
      "contracts ADR 0106 (source-style review, 2026-10-05): pay_partner is pay_protocol_fees_with_partner, since it pays Blast too, and FeeSplit names its recipients fee_recipients",
      "contracts ADR 0107: the PresaleVault inherits the sale's partner and, when partnered, holds Blast's LP fees until anyone calls presale_vault::pay_protocol_lp_fees_with_partner; FeesCollected.protocol_destination becomes optional and ProtocolLpFeesPaid records each payout",
    ],
    packages: [["presale", "presale", "blast_presale"]],
  },
  {
    path: "production-admin-v1.json",
    // The shared ACL package is new to SDK coverage, frozen at contracts main.
    baseline: {
      contractsCommit: "442116a0a1b82c6b4a64dc55fa0de430322f4bb7",
      workingTreeDifferedAtFreeze: false,
    },
    approvedAbiAmendments: [
      "contracts ADR 0097 (amended 2026-10-02, admin package review): upgrade_custody::publisher borrows the sealed Publisher, operational_version::new takes the package's one-time witness, and advance takes the versioned object's UID",
    ],
    packages: [["admin", "admin", "blast_admin"]],
  },
  {
    path: "production-partners-v1.json",
    // The immutable partner package is new to SDK coverage, frozen at contracts main.
    baseline: {
      contractsCommit: "442116a0a1b82c6b4a64dc55fa0de430322f4bb7",
      workingTreeDifferedAtFreeze: false,
    },
    packages: [["partners", "partners", "blast_partners"]],
  },
  {
    path: "production-blast-sui-v1.json",
    packages: [["blastSui", "blast_sui", "blast_sui"]],
    approvedAbiAmendments: [
      "contracts ADR 0059: remove sender and unchanged state from event payloads",
      "contracts ADR 0060: retain both currency metadata caps and the receipt-display cap in PackageAdmin custody",
      "contracts ADR 0061: restore routine AdminCap authorization and composable PackageAdmin custody",
      "contracts ADR 0065: retain discoverable TreasuryCap child objects under Vault custody",
      "contracts ADR 0085: name every explorer-visible type after Blast",
      "contracts ADR 0097: package custody and the redeem fee take blast_admin::blast_acl::AdminWitness of the typed UpgradeAdmin and FeeAdmin roles",
      "contracts ADR 0097 (amended 2026-10-02): PackageVersion lives in the one-time-witness module as blast_sui_package::PackageVersion, seeded from that witness",
    ],
  },
];
const contractsRoot = resolve(
  sdkRoot,
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
    "../contracts",
);
const write = process.argv.includes("--write");
const temporaryRoot = mkdtempSync(join(tmpdir(), "blast-production-abi-"));

function main() {
  try {
    verifySuiCliVersion();
    for (const declaration of artifactDeclarations) {
      checkArtifact(declaration);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function checkArtifact(declaration) {
  const artifactPath = join(sdkRoot, "abi", declaration.path);
  const packages = Object.fromEntries(
    declaration.packages.map(([name, directory, packageName]) => [
      name,
      summarizePackage(join(contractsRoot, "sui", directory), packageName),
    ]),
  );
  const baseline = declaration.baseline ?? LAUNCHPAD_BASELINE;
  const artifact = {
    schemaVersion: 1,
    baseline: {
      ...baseline,
      ...(declaration.approvedAbiAmendments === undefined
        ? {}
        : { approvedAbiAmendments: declaration.approvedAbiAmendments }),
      suiCli: "1.77.2-51d177ad7d65",
    },
    packages,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  if (write) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, serialized);
    console.log(`wrote ${artifactPath}`);
    return;
  }

  const expected = readFileSync(artifactPath, "utf8");
  if (expected !== serialized) {
    console.error(
      `production Move ABI differs from abi/${declaration.path}; run npm run check:abi:write only for an approved ABI migration`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `current production Move ABI matches abi/${declaration.path} frozen at ${baseline.contractsCommit}`,
  );
}

function verifySuiCliVersion() {
  const result = spawnSync("sui", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to read Sui CLI version",
    );
  }
  const actual = result.stdout.trim().replace(/^sui\s+/, "");
  for (const declaration of artifactDeclarations) {
    const artifactPath = join(sdkRoot, "abi", declaration.path);
    // A new package's artifact is first created by --write.
    if (write && !existsSync(artifactPath)) continue;
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const expected = artifact.baseline?.suiCli;
    if (typeof expected !== "string") {
      throw new TypeError(`abi/${declaration.path} has no Sui CLI version`);
    }
    if (actual !== expected) {
      throw new Error(
        `Sui CLI ${actual} does not match abi/${declaration.path} value ${expected}`,
      );
    }
  }
}

function summarizePackage(packagePath, packageName) {
  const outputDirectory = join(temporaryRoot, packageName);
  const result = spawnSync(
    "sui",
    [
      "move",
      "summary",
      "--quiet",
      "--path",
      packagePath,
      "--output-directory",
      outputDirectory,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `failed to summarize ${packageName}`,
    );
  }

  const packageDirectory = join(outputDirectory, packageName);
  const moduleNames = readdirSync(packageDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  return {
    address: packageName,
    modules: Object.fromEntries(
      moduleNames.map((moduleName) => [
        moduleName,
        normalizeModule(
          packageName,
          moduleName,
          JSON.parse(
            readFileSync(join(packageDirectory, `${moduleName}.json`), "utf8"),
          ),
        ),
      ]),
    ),
  };
}

function normalizeModule(packageName, moduleName, summary) {
  const functions = Object.entries(summary.functions)
    .filter(([, definition]) => definition.visibility === "Public")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      sdk: classifyFunction(packageName, moduleName, name),
      entry: definition.entry,
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      parameters: definition.parameters.map((parameter) =>
        normalizeType(parameter.type_),
      ),
      returns: definition.return_.map(normalizeType),
    }));
  const normalizedStructs = normalizeStructs(summary.structs);
  const events = normalizedStructs
    .filter(({ name }) => isEventStruct(packageName, moduleName, name))
    .map((event) => ({ ...event, sdk: classifyEvent(packageName, event) }));
  const structs = normalizedStructs.filter(
    ({ name }) => !isEventStruct(packageName, moduleName, name),
  );
  const enums = Object.entries(summary.enums)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      abilities: [...definition.abilities],
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      variants: Object.entries(definition.variants)
        .sort(([, left], [, right]) => left.index - right.index)
        .map(([variantName, variant]) => ({
          name: variantName,
          fields: normalizeFields(variant.fields),
        })),
    }));

  return { functions, structs, enums, events };
}

function normalizeStructs(structs) {
  return Object.entries(structs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      abilities: [...definition.abilities],
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      positional: definition.fields.positional_fields,
      fields: normalizeFields(definition.fields),
    }));
}

function normalizeFields(fields) {
  return Object.entries(fields.fields)
    .sort(([, left], [, right]) => left.index - right.index)
    .map(([name, field]) => ({ name, type: normalizeType(field.type_) }));
}

function normalizeTypeParameter(parameter) {
  return {
    name: parameter.name,
    phantom: parameter.phantom ?? false,
    constraints: [...parameter.constraints],
  };
}

function normalizeType(type) {
  if (type === null || typeof type !== "object") return type;
  if (Array.isArray(type)) return type.map(normalizeType);
  return Object.fromEntries(
    Object.entries(type)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizeType(value)]),
  );
}

function classifyFunction(packageName, moduleName, functionName) {
  const classifier = functionClassifiers[packageName];
  if (!classifier) throw new Error(`unknown package ${packageName}`);
  return classifier(moduleName, functionName);
}

const functionClassifiers = {
  blast_fun: (moduleName, functionName) =>
    classifyLaunchpadFunction("blast_fun", moduleName, functionName),
  meme_template: classifyMemeTemplateFunction,
  blast_fun_migrators: classifyMigratorFunction,
  blast_sui: classifyBlastSuiFunction,
  blast_presale: classifyPresaleFunction,
  blast_admin: classifyAdminFunction,
  blast_partners: classifyPartnersFunction,
};

const partnersBuilders = new Set([
  "new_cap",
  "register",
  "schedule_share",
  "schedule_cap",
  "set_recipient",
  "destroy_cap",
]);

function classifyPartnersFunction(moduleName, functionName) {
  if (partnersBuilders.has(functionName)) return "builder";
  // Products call `pay` with Blast's own fee balance; `delay_ms` is
  // `PARTNER_DELAY_MS` off chain.
  if (functionName === "pay" || functionName === "delay_ms") {
    return "move-composition";
  }
  throw new Error(
    `unclassified function blast_partners::${moduleName}::${functionName}`,
  );
}

const aclBuilders = new Set([
  "sign_in",
  "grant_admin",
  "revoke_admin",
  "grant_role",
  "revoke_role",
  "destroy_admin_cap",
  "begin_super_admin_transfer",
  "cancel_super_admin_transfer",
  "accept_super_admin_transfer",
  "destroy_retired_super_admin_cap",
]);

function classifyAdminFunction(moduleName, functionName) {
  if (moduleName === "blast_acl" && aclBuilders.has(functionName)) {
    return "builder";
  }
  // Consumers' own package_admin and one-time-witness modules call these on
  // values they wrap; no transaction can reach them directly.
  if (
    moduleName === "upgrade_custody" ||
    moduleName === "operational_version"
  ) {
    return "move-composition";
  }
  throw new Error(
    `unclassified function blast_admin::${moduleName}::${functionName}`,
  );
}

/**
 * Every event the SDK decodes and replays. blast_admin's generic upgrade and
 * operational-version events follow package upgrades, which publish tooling
 * drives, so the SDK leaves them out with the upgrade calls.
 */
function classifyEvent(packageName, event) {
  if (packageName === "blast_admin" && event.typeParameters.length > 0) {
    return "intentional-upgrade-exclusion";
  }
  return "decoder-reducer";
}

const presaleBuilders = new Set([
  "blast_presale::open_eligibility",
  "blast_presale::allowlisted_eligibility",
  "blast_presale::uncapped_for_eligible",
  "blast_presale::uncapped_for_anyone",
  "blast_presale::recipient_share",
  "blast_presale::vested_recipient_share",
  "blast_presale::vesting_terms",
  "blast_presale::fee_split",
  "blast_presale::set_partner",
  "blast_presale::share",
  "blast_presale::set_protocol_fees",
  "blast_presale::commit_open",
  "blast_presale::commit_allowlisted",
  "blast_presale::commit_uncapped",
  "blast_presale::settle",
  "blast_presale::cancel_unlaunched",
  "blast_presale::claim",
  "blast_presale::destroy_cap",
  "blast_presale::pay_protocol_fees_with_partner",
  "fee_policy::set_fees",
  "fee_policy::set_destination",
  "creation_policy::set_quote_allowed",
  "creation_policy::set_migration_witness_allowed",
  "creation_policy::add_partner",
  "creation_policy::remove_partner",
  "cetus::new",
  "cetus::migrate",
  "cetus::collect_fees",
  "bluefin::new",
  "bluefin::migrate",
  "bluefin::collect_fees",
  "presale_vault::claim_migration_residuals",
  "presale_vault::set_protocol_lp_fees",
  "presale_vault::pay_protocol_lp_fees_with_partner",
  "holder_rewards::publish_round",
  "holder_rewards::claim",
  "holder_rewards::close_round",
  "blast_presale_admin::replace_admin_cap",
  "blast_presale_admin::revoke_admin_cap",
  "blast_presale_admin::transfer_super_admin",
]);
const presaleEventNames = new Set([
  "PresaleCreated",
  "PresaleOpened",
  "ProtocolFeesChanged",
  "Committed",
  "PresaleFunded",
  "PresaleCancelled",
  "PresaleMigrated",
  "ProtocolFeesPaid",
  "RaiseAllocated",
  "RecipientAllocated",
  "Claimed",
  "PresaleVaultCreated",
  "FeesCollected",
  "MigrationResidualsClaimed",
  "ProtocolLpFeesChanged",
  "ProtocolLpFeesPaid",
  "FeesChanged",
  "DestinationChanged",
  "QuoteSet",
  "MigrationWitnessSet",
  "PartnerAdded",
  "PartnerRemoved",
  "RoundPublished",
  "RoundClosed",
  "RewardClaimed",
  "AdminCapReplaced",
  "AdminCapRevoked",
]);

function classifyPresaleFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (presaleBuilders.has(key)) return "builder";
  // Every rate argument is a `bps::Bps` built in the PTB.
  if (key === "bps::new") return "compositional";
  // A migrator's module calls these with its own sealed witness, which no
  // transaction can construct; the SDK builds that migrator's entry points.
  if (key === "blast_presale::new" || key === "blast_presale::migrate") {
    return "move-composition";
  }
  // `allowlist.ts` mirrors the Merkle tree and `math.ts` the BPS arithmetic off chain.
  if (moduleName === "merkle_tree" || moduleName === "bps") {
    return "move-composition";
  }
  return classifyPackageAdmin("blast_presale", moduleName, functionName);
}

function classifyMemeTemplateFunction(moduleName, functionName) {
  throw new Error(
    `unexpected public function meme_template::${moduleName}::${functionName}`,
  );
}

const migratorBuilders = new Set([
  "bluefin::new",
  "bluefin::migrate",
  "bluefin::collect_fees",
  "bluefin::settle_and_update_fee_split",
  "bluefin::buyback_and_burn",
  "cetus::new",
  "cetus::migrate",
  "cetus::collect_fees",
  "cetus::settle_and_update_fee_split",
  "cetus::buyback_and_burn",
  "vault::claim_creator_fees",
  "vault::claim_protocol_fees",
  "vault::claim_protocol_lp_fees_with_partner",
  "blast_holder_rewards::publish_round",
  "blast_holder_rewards::claim",
  "lp_fee_policy::set_default_shares",
  "lp_fee_policy::set_coin_shares",
  "lp_fee_policy::clear_coin_shares",
  "lp_fee_policy::set_protocol_destination",
]);

function classifyMigratorFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (migratorBuilders.has(key)) return "builder";
  return classifyPackageAdmin("blast_fun_migrators", moduleName, functionName);
}

/**
 * Every package's `package_admin` holds its Publisher and UpgradeCap.
 * Wrapping them is part of publishing, and authorizing, committing,
 * restricting or sealing an upgrade is CLI publish tooling; neither is SDK
 * surface.
 */
const upgradeCustodyFunctions = new Set([
  "authorize_upgrade",
  "commit_upgrade",
  "commit_upgrade_and_advance",
  "restrict_to_additive",
  "make_immutable",
]);

function classifyPackageAdmin(packageName, moduleName, functionName) {
  if (moduleName === "package_admin") {
    if (functionName === "wrap") return "intentional-deployment-exclusion";
    if (upgradeCustodyFunctions.has(functionName)) {
      return "intentional-upgrade-exclusion";
    }
  }
  throw new Error(
    `unclassified function ${packageName}::${moduleName}::${functionName}`,
  );
}

const launchpadBuilders = new Set([
  "launch::finalize",
  "launch::share",
  "launch::buy",
  "launch::sell",
  "launch::set_graduation_target",
  "launch::set_allocation_plan",
  "launch::set_lp_fee_split",
  "launch::set_virtual_quote",
  "launch::set_opening_round",
  "launch::set_partner",
  "launch::join_opening_round",
  "launch::settle_opening_round",
  "launch::deliver_opening_round",
  "launch::claim_creator_caps",
  "launch::claim_creator_fees",
  "launch::claim_protocol_fees",
  "launch::claim_protocol_fees_with_partner",
  "launch::set_name",
  "launch::set_description",
  "launch::set_icon_url",
  "launch::reassign_curve_fee_cap",
  "launch::reassign_metadata_cap",
  "launch_config::set_protocol_allocation",
  "launch_config::set_meme_decimals_allowed",
  "launch_config::set_quote_allowed",
  "launch_config::set_trade_fees",
  "launch_config::set_creation_fee",
  "launch_config::add_partner",
  "launch_config::remove_partner",
  "launch_config::set_migration_witness_allowed",
  "runtime_config::set_creator_claim_signer",
  "runtime_config::set_protocol_fee_share",
  "runtime_config::set_treasury",
]);
const launchpadCompositional = new Set([
  "allocation::recipient",
  "allocation::plan",
  "allocation::route",
  "allocation::fee_split",
  "bps::new",
]);
const launchpadAdapterComposition = new Set([
  "launch::new",
  "launch::treasury_cap_mut",
  "launch::migrate",
]);

function classifyLaunchpadFunction(packageName, moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (launchpadBuilders.has(key)) return "builder";
  if (launchpadCompositional.has(key)) return "compositional";
  if (launchpadAdapterComposition.has(key)) return "adapter-composition";
  if (key === "launch_ticket::new") return "template-builder";
  if (moduleName === "creator_authority" && functionName.startsWith("new_")) {
    return "template-internal";
  }
  if (isLaunchpadMoveComposition(moduleName, functionName)) {
    return "move-composition";
  }
  return classifyPackageAdmin(packageName, moduleName, functionName);
}

const launchGetters = new Set([
  "launch::pool_tier",
  "launch::lp_fee_split",
  "launch::partner_id",
  "launch::assert_curve_fee_cap",
]);

/** Getters and exact math the SDK mirrors off chain. */
function isLaunchpadMoveComposition(moduleName, functionName) {
  return (
    moduleName === "bps" ||
    moduleName === "allocation" ||
    launchGetters.has(`${moduleName}::${functionName}`) ||
    (moduleName === "creator_authority" && functionName.startsWith("destroy_"))
  );
}

const blastSuiBuilders = new Set([
  "vault::mint_fun_sui",
  "vault::redeem_fun_sui",
  "vault::request_blast_sui",
  "deposit_receipt::keep",
  "vault::claim_blast_sui",
  "deposit_receipt::cancel",
  "vault::donate_sui",
  "vault::redeem_blast_sui",
  "vault::sync",
  "vault::set_redeem_fee",
]);
const blastSuiMoveComposition = new Set(["package_admin::has_upgrade_cap"]);

function classifyBlastSuiFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (blastSuiBuilders.has(key)) return "builder";
  if (isBlastSuiDeploymentExclusion(key)) {
    return "intentional-deployment-exclusion";
  }
  if (blastSuiMoveComposition.has(key)) return "move-composition";
  return classifyPackageAdmin("blast_sui", moduleName, functionName);
}

function isBlastSuiDeploymentExclusion(key) {
  return (
    key === "vault::create" ||
    key === "package_admin::add_capability" ||
    key === "deposit_receipt::create_display" ||
    key === "package_admin::new" ||
    key === "package_admin::share"
  );
}

const blastSuiEventNames = new Set([
  "PackageCapabilityAdded",
  "VaultCreated",
  "FunSuiMinted",
  "FunSuiRedeemed",
  "BlastSuiDepositRequested",
  "BlastSuiDepositClaimed",
  "BlastSuiDepositCancelled",
  "BlastSuiDonated",
  "BlastSuiRedeemed",
  "FunYieldSwept",
  "RedeemFeeChanged",
  "VaultSynced",
  "NativeStakeUnwound",
]);

function isEventStruct(packageName, moduleName, structName) {
  if (packageName === "blast_presale") return presaleEventNames.has(structName);
  if (packageName === "blast_admin") return moduleName === "blast_admin_events";
  if (packageName === "blast_partners") {
    return structName === "PartnerUpdated" || structName === "PartnerPaid";
  }
  if (packageName === "blast_sui" && moduleName === "events") {
    return blastSuiEventNames.has(structName);
  }
  if (moduleName === "events") return true;
  return packageName === "blast_fun_migrators" && moduleName === "blast_events";
}

function runClassificationProbe(argumentIndex) {
  try {
    const [packageName, moduleName, functionName] = process.argv.slice(
      argumentIndex + 1,
      argumentIndex + 4,
    );
    if (!packageName || !moduleName || !functionName) {
      throw new Error(
        "--classify-function requires package, module, and function",
      );
    }
    console.log(classifyFunction(packageName, moduleName, functionName));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const classificationArgumentIndex = process.argv.indexOf("--classify-function");
if (classificationArgumentIndex === -1) main();
else runClassificationProbe(classificationArgumentIndex);
