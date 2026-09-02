import { spawnSync } from "node:child_process";
import {
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
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDeclarations = [
  {
    path: "production-launchpad-v1.json",
    packages: [
      ["launchpad", "launchpad", "blast_fun"],
      ["memeTemplate", "meme_template", "meme_template"],
      ["migrators", "migrators", "blast_fun_migrators"],
    ],
  },
  {
    path: "production-vesting-v1.json",
    packages: [["vesting", "vesting", "blast_fun_vesting"]],
  },
  {
    path: "production-blast-sui-v1.json",
    packages: [["blastSui", "blast_sui", "blast_sui"]],
    approvedAbiAmendments: [
      "contracts ADR 0059: remove sender and unchanged state from event payloads",
      "contracts ADR 0060: retain both currency metadata caps and the receipt-display cap in PackageAdmin custody",
      "contracts ADR 0061: restore routine AdminCap authorization and composable PackageAdmin custody",
      "contracts ADR 0065: retain discoverable TreasuryCap child objects under Vault custody",
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
  const artifact = {
    schemaVersion: 1,
    baseline: {
      contractsCommit: BASELINE_COMMIT,
      workingTreeDifferedAtFreeze: true,
      abiNeutralDifferences: [
        "sui/meme_template/Move.lock",
        "docs/research/sui-deepbook-indexer-architecture-2026.md",
      ],
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
    `current production Move ABI matches artifact frozen at ${BASELINE_COMMIT}`,
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
  blast_fun_vesting: classifyVestingFunction,
  blast_sui: classifyBlastSuiFunction,
};

function classifyMemeTemplateFunction(moduleName, functionName) {
  throw new Error(
    `unexpected public function meme_template::${moduleName}::${functionName}`,
  );
}

function classifyMigratorFunction(moduleName, functionName) {
  if (moduleName === "vault") return "builder";
  if (moduleName === "migration_math") return "sdk-arithmetic";
  if (functionName === "set_tier" || functionName === "set_policy") {
    return "intentional-admin-exclusion";
  }
  if (
    functionName.startsWith("migrate") ||
    functionName.startsWith("collect_fees") ||
    functionName.startsWith("accrue_") ||
    (moduleName === "aftermath" && functionName === "update_fee")
  ) {
    return "builder";
  }
  throw new Error(
    `unclassified function blast_fun_migrators::${moduleName}::${functionName}`,
  );
}

function classifyLaunchpadFunction(packageName, moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  const builders = new Set([
    "launch::new",
    "launch::share",
    "launch::buy",
    "launch::sell",
    "launch::claim_creator_cap",
    "launch::claim_creator_fees",
    "launch::claim_protocol_fees",
  ]);
  if (builders.has(key)) return "builder";
  if (
    key === "launch::migrate" ||
    key === "launch::redeem_migration" ||
    key === "acl::sign_in"
  ) {
    return "compositional";
  }
  if (key === "launch_ticket::new") return "template-builder";
  if (moduleName === "creator_authority") return "template-internal";
  if (moduleName === "fees") return "move-composition";
  if (moduleName === "migration_math") return "sdk-arithmetic";
  if (isIntentionalAdminExclusion(moduleName, functionName, key)) {
    return "intentional-admin-exclusion";
  }
  if (key === "runtime_config::protocol_fee_share_bps") {
    return "move-composition";
  }
  throw new Error(`unclassified function ${packageName}::${key}`);
}

function isIntentionalAdminExclusion(moduleName, functionName, key) {
  return (
    moduleName === "acl" ||
    moduleName === "launch_config" ||
    moduleName === "package_admin" ||
    (moduleName === "runtime_config" && functionName.startsWith("set_")) ||
    key === "runtime_config::revoke_x_claim_signer"
  );
}

const vestingBuilders = new Set([
  "checkpoints::new_schedule",
  "checkpoints::add",
  "checkpoints::new_irrevocable",
  "checkpoints::new_cancelable",
  "checkpoints::share",
  "checkpoints::claim",
  "checkpoints::cancel",
  "checkpoints::close_irrevocable",
  "linear::new_irrevocable",
  "linear::new_cancelable",
  "linear::share",
  "linear::claim",
  "linear::cancel",
  "linear::close_irrevocable",
]);

function classifyVestingFunction(moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (vestingBuilders.has(key)) return "builder";
  throw new Error(`unclassified function blast_fun_vesting::${key}`);
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
  "acl::accept_super_admin_transfer",
  "acl::begin_super_admin_transfer",
  "acl::cancel_super_admin_transfer",
  "acl::destroy_admin_cap",
  "acl::destroy_retired_super_admin_cap",
  "acl::grant_admin",
  "acl::keep",
  "acl::revoke_admin",
  "acl::sign_in",
  "package_admin::add_capability",
  "package_admin::activate_package_version",
  "package_admin::authorize_upgrade",
  "package_admin::commit_upgrade",
  "package_admin::restrict_to_additive",
  "vault::set_redeem_fee",
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

const directEventNames = new Set([
  "VestingCreated",
  "VestingClaimed",
  "VestingCanceled",
  "VestingClosed",
]);
const blastSuiEventNames = new Set([
  "AdminDestroyed",
  "AdminGranted",
  "AdminRevoked",
  "SuperAdminTransferStarted",
  "SuperAdminTransferCancelled",
  "SuperAdminTransferred",
  "PackageVersionAdvanced",
  "PackageCapabilityAdded",
  "PackageAdminCreated",
  "UpgradeAuthorized",
  "UpgradeCommitted",
  "UpgradePolicyRestricted",
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
  if (packageName === "blast_sui" && moduleName === "events") {
    return blastSuiEventNames.has(structName);
  }
  if (moduleName === "events") return true;
  return (
    packageName === "blast_fun_vesting" && directEventNames.has(structName)
  );
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
