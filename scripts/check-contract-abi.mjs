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
const artifactPath = join(sdkRoot, "abi", "production-launchpad-v1.json");
const contractsRoot = resolve(
  sdkRoot,
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
    "../contracts",
);
const write = process.argv.includes("--write");
const temporaryRoot = mkdtempSync(join(tmpdir(), "blast-production-abi-"));

try {
  const packages = {
    launchpad: summarizePackage(
      join(contractsRoot, "sui", "launchpad"),
      "blast_fun",
    ),
    memeTemplate: summarizePackage(
      join(contractsRoot, "sui", "meme_template"),
      "meme_template",
    ),
    migrators: summarizePackage(
      join(contractsRoot, "sui", "migrators"),
      "blast_fun_migrators",
    ),
  };
  const artifact = {
    schemaVersion: 1,
    baseline: {
      contractsCommit: BASELINE_COMMIT,
      workingTreeDifferedAtFreeze: true,
      abiNeutralDifferences: [
        "sui/meme_template/Move.lock",
        "docs/research/sui-deepbook-indexer-architecture-2026.md",
      ],
      suiCli: "1.77.2-51d177ad7d65",
    },
    packages,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  if (write) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, serialized);
    console.log(`wrote ${artifactPath}`);
  } else {
    const expected = readFileSync(artifactPath, "utf8");
    if (expected !== serialized) {
      console.error(
        "production Move ABI differs from abi/production-launchpad-v1.json; run npm run check:abi:write only for an approved ABI migration",
      );
      process.exitCode = 1;
    } else {
      console.log(`production Move ABI matches ${BASELINE_COMMIT}`);
    }
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
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
  const isEventModule = moduleName === "events";
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
  const events = isEventModule
    ? normalizeStructs(summary.structs).map((event) => ({
        ...event,
        sdk: "decoder-reducer",
      }))
    : [];
  const structs = isEventModule ? [] : normalizeStructs(summary.structs);
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
  if (packageName === "meme_template") {
    throw new Error(
      `unexpected public function ${packageName}::${moduleName}::${functionName}`,
    );
  }
  if (packageName === "blast_fun_migrators") {
    return classifyMigratorFunction(moduleName, functionName);
  }

  return classifyLaunchpadFunction(packageName, moduleName, functionName);
}

function classifyMigratorFunction(moduleName, functionName) {
  if (moduleName === "vault") return "builder";
  if (functionName === "set_tier") return "intentional-admin-exclusion";
  if (
    functionName.startsWith("migrate") ||
    functionName.startsWith("collect_fees")
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
  if (moduleName === "migration_math") return "sdk-arithmetic";
  if (moduleName === "fees") return "move-composition";
  if (isIntentionalAdminExclusion(moduleName, functionName, key)) {
    return "intentional-admin-exclusion";
  }
  if (
    key === "runtime_config::protocol_fee_share_bps" ||
    key === "runtime_config::protocol_treasury"
  ) {
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
