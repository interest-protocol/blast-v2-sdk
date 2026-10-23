import { createHash } from "node:crypto";
import type { PresaleDeployment } from "@interest-protocol/blast-presale-sdk/transactions";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

export type FinalConfig = {
  schemaVersion: 1;
  contractsCommit: string;
  publicationDigest: string;
  deployment: PresaleDeployment;
  superAdminCap: string;
  testkit: string;
  saleTokenLetter: string;
  operators: { deployer: string; administrator: string };
  feeRecipient: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected configuration object");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}
function address(value: unknown): string {
  const str = text(value, "Sui object/address");
  if (!/^0x[0-9a-fA-F]{64}$/.test(str) || BigInt(str) === 0n)
    throw new Error(`Expected a nonzero full Sui ID: ${str}`);
  return normalizeSuiAddress(str);
}
function shared(value: unknown) {
  const ref = object(value);
  const version = text(
    ref.initialSharedVersion,
    "initialSharedVersion (decimal string)",
  );
  if (!/^[1-9][0-9]*$/.test(version))
    throw new Error("Invalid initialSharedVersion");
  return { objectId: address(ref.objectId), initialSharedVersion: version };
}
export function parseConfig(value: unknown): FinalConfig {
  const config = object(value);
  if (config.schemaVersion !== 1)
    throw new Error(
      "Expected final deployment config schemaVersion 1; legacy records are not targets",
    );
  const contractsCommit = text(config.contractsCommit, "contractsCommit");
  if (!/^[a-f0-9]{40}$/.test(contractsCommit))
    throw new Error("Set the exact published contracts commit");
  const publicationDigest = text(config.publicationDigest, "publicationDigest");
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicationDigest))
    throw new Error("Set the final publication transaction digest");
  const d = object(config.deployment);
  const admin = object(d.admin);
  const operators = object(config.operators);
  const deployment: PresaleDeployment = {
    packageId: address(d.packageId),
    originalPackageId: address(d.originalPackageId),
    packageVersion: shared(d.packageVersion),
    venueConfig: shared(d.venueConfig),
    creationPolicy: shared(d.creationPolicy),
    feePolicy: shared(d.feePolicy),
    admin: { packageId: address(admin.packageId), acl: shared(admin.acl) },
  };
  if (deployment.packageId !== deployment.originalPackageId)
    throw new Error(
      "This runner requires a fresh final publication (packageId = originalPackageId)",
    );
  const saleTokenLetter = text(config.saleTokenLetter, "saleTokenLetter");
  if (!/^[A-Z]$/.test(saleTokenLetter))
    throw new Error("Use one testkit sale token letter");
  const result: FinalConfig = {
    schemaVersion: 1,
    contractsCommit,
    publicationDigest,
    deployment,
    superAdminCap: address(config.superAdminCap),
    testkit: address(config.testkit),
    saleTokenLetter,
    operators: {
      deployer: address(operators.deployer),
      administrator: address(operators.administrator),
    },
    feeRecipient: address(config.feeRecipient),
  };
  if (result.feeRecipient === result.operators.deployer)
    throw new Error(
      "Use a distinct fee recipient to separate receipts from gas",
    );
  return result;
}
export function targetFingerprint(config: FinalConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(parseConfig(config)))
    .digest("hex");
}
export function assertStateTarget(
  state: { target?: unknown },
  fingerprint: string,
): void {
  if (state.target !== fingerprint)
    throw new Error(
      "Run state belongs to a different deployment/configuration; use a separate E2E_STATE",
    );
}
function datatype(
  signature: SuiClientTypes.OpenSignature | undefined,
  expected: string,
): boolean {
  return (
    signature?.reference === null &&
    signature.body.$kind === "datatype" &&
    normalizeStructTag(signature.body.datatype.typeName) ===
      normalizeStructTag(expected)
  );
}
export function assertFinalizeTicketAbi(
  packageId: string,
  create: SuiClientTypes.FunctionResponse,
  finalize: SuiClientTypes.FunctionResponse,
): void {
  const ticket = `${packageId}::aftermath::FinalizeTicket`;
  if (
    create.typeParameters.length !== 2 ||
    create.returns.length !== 2 ||
    !datatype(
      create.returns[0],
      `${packageId}::blast_presale::PresaleInitializer`,
    ) ||
    !datatype(create.returns[1], ticket) ||
    finalize.typeParameters.length !== 3 ||
    finalize.parameters.length !== 6 ||
    !datatype(finalize.parameters[2], ticket) ||
    finalize.returns.length !== 3
  )
    throw new Error(
      "Final package does not expose the required native Aftermath FinalizeTicket ABI",
    );
  for (const sig of [create.returns[1], finalize.parameters[2]]) {
    if (
      sig?.body.$kind !== "datatype" ||
      sig.body.datatype.typeParameters.length !== 2 ||
      sig.body.datatype.typeParameters.some(
        (type, i) =>
          type.$kind !== "typeParameter" ||
          type.index !== i + (sig === finalize.parameters[2] ? 1 : 0),
      )
    )
      throw new Error(
        "FinalizeTicket generic arguments do not match Meme, Quote",
      );
  }
}
export const PRIOR_EVIDENCE = [
  {
    path: "deployments/sui/mainnet/2026-10-20-blast-presale-versioned-e2e.json",
    sha256: "2c0234416e86120b07fa40daebdb313e21c6f4591683cd9bac1fec6f9ce5e200",
    scope: "Signed vendor lifecycle; not the native adapter or FinalizeTicket",
  },
  {
    path: "outputs/operations/2026-10-21-aftermath-sui-live/verification.json",
    sha256: "773817361d07560dd831f30e85c891eed80e74425b47160a2beb25cc42c28a88",
    scope:
      "14 signed native unversioned lifecycle transactions, SUI first, swaps, collection and rewards; predates FinalizeTicket",
  },
  {
    path: "outputs/operations/2026-10-21-aftermath-reverse-order/verification.json",
    sha256: "cea0cec430e1092227a7842acad0d561d726dcc80fdd5db8e15e6f13d11c3625",
    scope:
      "Both coin orders on both older native packages, checks-disabled reconstructed simulations; not signed lifecycles",
  },
] as const;
