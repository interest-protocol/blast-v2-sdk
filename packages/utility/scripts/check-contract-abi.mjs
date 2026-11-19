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

/** The commit both packages were published from; their ABI has not changed since. */
const PUBLISHED_COMMIT = "8600b8fa096c685ba72cd39b384124cb01fc97d6";
const SUI_CLI = "1.77.2-51d177ad7d65";
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDeclarations = [
  {
    path: "otc-v1.json",
    directory: "otc",
    packageName: "blast_fun_otc",
    mainnetPackageId:
      "0x40e0c95f73af329e7a6a8eafee9d152a1f3090736d35052842288232f7eb5968",
    builders: new Set([
      "blast_fun_otc::new",
      "blast_fun_otc::share",
      "blast_fun_otc::take",
      "blast_fun_otc::cancel",
    ]),
    events: new Set(["OfferCreated", "OfferTaken", "OfferCanceled"]),
  },
  {
    path: "vesting-v1.json",
    directory: "vesting",
    packageName: "blast_fun_vesting",
    mainnetPackageId:
      "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c",
    builders: new Set([
      "blast_fun_checkpoint_vesting::new_schedule",
      "blast_fun_checkpoint_vesting::add",
      "blast_fun_checkpoint_vesting::new_irrevocable",
      "blast_fun_checkpoint_vesting::new_cancelable",
      "blast_fun_checkpoint_vesting::share",
      "blast_fun_checkpoint_vesting::claim",
      "blast_fun_checkpoint_vesting::cancel",
      "blast_fun_checkpoint_vesting::close_irrevocable",
      "blast_fun_linear_vesting::new_irrevocable",
      "blast_fun_linear_vesting::new_cancelable",
      "blast_fun_linear_vesting::share",
      "blast_fun_linear_vesting::claim",
      "blast_fun_linear_vesting::cancel",
      "blast_fun_linear_vesting::close_irrevocable",
    ]),
    events: new Set([
      "VestingCreated",
      "VestingClaimed",
      "VestingCanceled",
      "VestingClosed",
    ]),
  },
];
const contractsRoot = resolve(
  sdkRoot,
  "../..",
  process.argv.slice(2).find((argument) => !argument.startsWith("--")) ??
    process.env.BLAST_CONTRACTS_DIR ??
    "../blast-v2-contracts",
);
const write = process.argv.includes("--write");
const temporaryRoot = mkdtempSync(join(tmpdir(), "blast-util-abi-"));

function main() {
  try {
    verifySuiCliVersion();
    extractPublishedSources();
    for (const declaration of artifactDeclarations) {
      checkArtifact(declaration);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function extractPublishedSources() {
  const archive = spawnSync("git", [
    "-C",
    contractsRoot,
    "archive",
    PUBLISHED_COMMIT,
    "sui/otc",
    "sui/vesting",
  ]);
  if (archive.status !== 0) throw new Error(String(archive.stderr));

  const extract = spawnSync("tar", ["-x", "-C", temporaryRoot], {
    input: archive.stdout,
  });
  if (extract.status !== 0) throw new Error(String(extract.stderr));
}

function checkArtifact(declaration) {
  const artifactPath = join(sdkRoot, "abi", declaration.path);
  const artifact = {
    schemaVersion: 1,
    mainnet: {
      packageId: declaration.mainnetPackageId,
      publishedCommit: PUBLISHED_COMMIT,
      immutable: true,
    },
    suiCli: SUI_CLI,
    package: summarizePackage(declaration),
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  if (write) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, serialized);
    console.log(`wrote ${artifactPath}`);
    return;
  }

  if (readFileSync(artifactPath, "utf8") !== serialized) {
    console.error(
      `Move ABI differs from abi/${declaration.path}; the mainnet package is immutable, so the source must not change its ABI`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${declaration.packageName} Move ABI matches abi/${declaration.path}`,
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
  if (actual !== SUI_CLI) {
    throw new Error(`Sui CLI ${actual} does not match ${SUI_CLI}`);
  }
}

function summarizePackage(declaration) {
  const { directory, packageName } = declaration;
  const outputDirectory = join(temporaryRoot, packageName);
  const result = spawnSync(
    "sui",
    [
      "move",
      "summary",
      "--quiet",
      "--path",
      join(temporaryRoot, "sui", directory),
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
          declaration,
          moduleName,
          JSON.parse(
            readFileSync(join(packageDirectory, `${moduleName}.json`), "utf8"),
          ),
        ),
      ]),
    ),
  };
}

function normalizeModule(declaration, moduleName, summary) {
  const functions = Object.entries(summary.functions)
    .filter(([, definition]) => definition.visibility === "Public")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => ({
      name,
      sdk: classifyFunction(declaration, moduleName, name),
      entry: definition.entry,
      typeParameters: definition.type_parameters.map(normalizeTypeParameter),
      parameters: definition.parameters.map((parameter) =>
        normalizeType(parameter.type_),
      ),
      returns: definition.return_.map(normalizeType),
    }));
  const normalizedStructs = normalizeStructs(summary.structs);
  const events = normalizedStructs
    .filter(({ name }) => declaration.events.has(name))
    .map((event) => ({ ...event, sdk: "decoder-reducer" }));
  const structs = normalizedStructs.filter(
    ({ name }) => !declaration.events.has(name),
  );

  return { functions, structs, events };
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

/** Every public function must have an SDK builder; a new one fails here until it gets one. */
function classifyFunction(declaration, moduleName, functionName) {
  const key = `${moduleName}::${functionName}`;
  if (declaration.builders.has(key)) return "builder";
  throw new Error(`unclassified function ${declaration.packageName}::${key}`);
}

main();
