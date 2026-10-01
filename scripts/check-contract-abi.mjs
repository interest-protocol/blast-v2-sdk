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
      "contracts ADR 0092: the creator picks the virtual Quote reserve at creation",
      "contracts ADR 0093: an optional opening round replaces protected public buys",
      "contracts ADR 0097: one singleton Blast ACL with typed administrator roles",
      "contracts ADR 0098: a launch creation fee, and one partner per launch",
      "contracts ADR 0100: one generic Cetus route per operation over <Meme, Quote, CoinA, CoinB>, replacing the _meme_a/_meme_b pairs",
    ],
  },
  {
    path: "production-presale-v1.json",
    // The presale package is new, frozen at its first contracts main commit.
    baseline: {
      contractsCommit: "442116a0a1b82c6b4a64dc55fa0de430322f4bb7",
      workingTreeDifferedAtFreeze: false,
    },
    packages: [["presale", "presale", "blast_presale"]],
    approvedAbiAmendments: [
      "contracts ADR 0101: admin-set Blast fees on the raise, the token supply, and LP fees, snapshotted at creation",
    ],
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
      "contracts ADR 0097: one singleton Blast ACL with typed administrator roles",
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
    .map((event) => ({ ...event, sdk: "decoder-reducer" }));
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
};

const presaleBuilders = new Set([
  "blast_presale::open_eligibility",
  "blast_presale::allowlisted_eligibility",
  "blast_presale::uncapped_for_eligible",
  "blast_presale::uncapped_for_anyone",
  "blast_presale::recipient_allocation",
  "blast_presale::fee_recipient",
  "blast_presale::share",
  "blast_presale::commit_open",
  "blast_presale::commit_allowlisted",
  "blast_presale::commit_uncapped",
  "blast_presale::settle",
  "blast_presale::cancel_unlaunched",
  "blast_presale::claim",
  "blast_presale::destroy_cap",
  "fee_policy::set_fees",
  "fee_policy::set_destination",
  "cetus::new",
  "cetus::migrate",
  "cetus::collect_fees",
  "bluefin::new",
  "bluefin::migrate",
  "bluefin::collect_fees",
  "presale_vault::claim_migration_residuals",
  "holder_rewards::publish_round",
  "holder_rewards::claim",
  "holder_rewards::close_round",
]);
const presaleEventNames = new Set([
  "PresaleCreated",
  "PresaleOpened",
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
  "FeesChanged",
  "DestinationChanged",
  "RoundPublished",
  "RoundClosed",
  "RewardClaimed",
]);

function classifyPresaleFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (presaleBuilders.has(key)) return "builder";
  // `allowlist.ts` mirrors the Merkle tree off chain.
  if (moduleName === "merkle_tree") return "move-composition";
  if (key === "package_admin::wrap") return "intentional-deployment-exclusion";
  if (moduleName === "package_admin") return "intentional-admin-exclusion";
  throw new Error(`unclassified function blast_presale::${key}`);
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
  if (moduleName === "package_admin") return "intentional-admin-exclusion";
  throw new Error(`unclassified function blast_fun_migrators::${key}`);
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
  "launch_config::set_protocol_allocation",
  "launch_config::set_meme_decimals_allowed",
  "launch_config::set_quote_allowed",
  "launch_config::set_trade_fees",
  "launch_config::set_creation_fee",
  "launch_config::add_partner",
  "launch_config::remove_partner",
  "launch_config::set_migration_witness_allowed",
  "launch::set_name",
  "launch::set_description",
  "launch::set_icon_url",
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
  if (isIntentionalAdminExclusion(moduleName, key)) {
    return "intentional-admin-exclusion";
  }
  if (isLaunchpadMoveComposition(moduleName, functionName)) {
    return "move-composition";
  }
  throw new Error(`unclassified function ${packageName}::${key}`);
}

/** Getters and exact math the SDK mirrors off chain. */
function isLaunchpadMoveComposition(moduleName, functionName) {
  return (
    moduleName === "bps" ||
    moduleName === "allocation" ||
    moduleName === "launch" ||
    (moduleName === "creator_authority" &&
      functionName.startsWith("destroy_")) ||
    (moduleName === "blast_fun_domain" && functionName.endsWith("_role"))
  );
}

function isIntentionalAdminExclusion(moduleName, key) {
  return (
    moduleName === "launch_config" ||
    moduleName === "package_admin" ||
    moduleName === "runtime_config" ||
    key === "launch::reassign_curve_fee_cap" ||
    key === "launch::reassign_metadata_cap"
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
]);
const blastSuiAdminExclusions = new Set([
  "package_admin::add_capability",
  "package_admin::authorize_upgrade",
  "package_admin::commit_upgrade_and_advance",
  "package_admin::make_immutable",
  "package_admin::restrict_to_additive",
  "vault::set_redeem_fee",
]);
const blastSuiMoveComposition = new Set([
  "blast_sui_domain::package_admin_role",
  "package_admin::has_upgrade_cap",
]);

function classifyBlastSuiFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (blastSuiBuilders.has(key)) return "builder";
  if (isBlastSuiDeploymentExclusion(key)) {
    return "intentional-deployment-exclusion";
  }
  if (blastSuiAdminExclusions.has(key)) {
    return "intentional-admin-exclusion";
  }
  if (blastSuiMoveComposition.has(key)) return "move-composition";
  throw new Error(`unclassified function blast_sui::${key}`);
}

function isBlastSuiDeploymentExclusion(key) {
  return (
    key === "vault::create" ||
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
