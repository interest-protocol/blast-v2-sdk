import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is a source ABI for a fresh PR150 stack, separate from published mainnet artifacts.
const commit = "f661a03462d557dbf6d57c5b82a5ede98519643d";
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "blast-pr150-abi-"));
const contracts = resolve(
  process.env.BLAST_CONTRACTS_DIR ?? "../blast-v2-contracts",
);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(String(result.stderr || result.stdout));
  return result.stdout;
}
function fields(struct) {
  return Object.entries(struct.fields.fields)
    .sort(([, a], [, b]) => a.index - b.index)
    .map(([name, field]) => ({ name, type: field.type_ }));
}
try {
  const archive = run("git", ["-C", contracts, "archive", commit, "sui"]);
  run("tar", ["-x", "-C", temporary], { input: archive });
  const packages = {};
  for (const [key, directory, marker] of [
    ["migrators", "migrators", "blast_holder_rewards"],
    ["presale", "presale", "presale_vault"],
  ]) {
    const output = join(temporary, `${key}-summary`);
    run("sui", [
      "move",
      "summary",
      "--quiet",
      "--path",
      join(temporary, "sui", directory),
      "--output-directory",
      output,
    ]);
    // Sui may choose the treasury alias for the shared zero source address.
    const packageDirectory = readdirSync(output)
      .map((name) => join(output, name))
      .find((path) => {
        try {
          readFileSync(join(path, `${marker}.json`));
          return true;
        } catch {
          return false;
        }
      });
    if (!packageDirectory) throw new Error(`missing ${key} compiler summary`);
    const modules = {};
    for (const file of readdirSync(packageDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const name = file.slice(0, -5),
        summary = JSON.parse(
          readFileSync(join(packageDirectory, file), "utf8"),
        );
      modules[name] = {
        functions: Object.entries(summary.functions)
          .filter(([, f]) => f.visibility === "Public")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, f]) => ({
            name,
            typeParameters: f.type_parameters,
            parameters: f.parameters.map((p) => p.type_),
            returns: f.return_,
          })),
        structs: Object.entries(summary.structs)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, s]) => ({ name, fields: fields(s) })),
      };
    }
    packages[key] = { modules };
  }
  const actual = `${JSON.stringify({ contractsCommit: commit, packages }, null, 2)}\n`;
  const path = join(root, "abi/pr150-consumers.json");
  if (process.argv.includes("--write")) writeFileSync(path, actual);
  else if (readFileSync(path, "utf8") !== actual)
    throw new Error("PR150 compiler ABI differs from its consumer snapshot");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
