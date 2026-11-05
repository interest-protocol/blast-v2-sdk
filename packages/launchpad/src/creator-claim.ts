import { moveTypeNameBcs } from "@interest-protocol/blast-core/bcs";
import { requireU64 } from "@interest-protocol/blast-core/integers";
import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

const ACCOUNT_COMMITMENT_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

const creatorClaimMessageBcs = bcs.struct("CreatorClaimMessage", {
  meme: moveTypeNameBcs,
  account_commitment: bcs.vector(bcs.u8()),
  claimant: bcs.Address,
  expiry_ms: bcs.u64(),
});

/** `creator_authority::CREATOR_CLAIM_DOMAIN`, prefixed to every signed claim without a length. */
const CREATOR_CLAIM_DOMAIN = new TextEncoder().encode(
  "blast_fun::creator_claim::v1",
);

const creatorClaimAttestationBcs = bcs.tuple([bcs.u64(), bcs.vector(bcs.u8())]);

export type CreatorClaim = {
  memeType: string;
  accountCommitment: Uint8Array;
  claimant: string;
  expiryMs: bigint;
};

/**
 * Encodes the exact provider-independent message the backend signs: the ASCII
 * domain tag `blast_fun::creator_claim::v1` followed by the BCS
 * `CreatorClaimMessage`.
 */
export function encodeCreatorClaimMessage(claim: CreatorClaim): Uint8Array {
  requireLength(
    "accountCommitment",
    claim.accountCommitment,
    ACCOUNT_COMMITMENT_LENGTH,
  );
  requireU64("expiryMs", claim.expiryMs);
  const memeType = normalizeStructTag(claim.memeType);

  const claimBytes = creatorClaimMessageBcs
    .serialize({
      // Move's TypeName text omits the conventional address prefix.
      meme: memeType.startsWith("0x") ? memeType.slice(2) : memeType,
      account_commitment: Array.from(claim.accountCommitment),
      claimant: normalizeSuiAddress(claim.claimant),
      expiry_ms: claim.expiryMs,
    })
    .toBytes();
  const message = new Uint8Array(
    CREATOR_CLAIM_DOMAIN.length + claimBytes.length,
  );
  message.set(CREATOR_CLAIM_DOMAIN);
  message.set(claimBytes, CREATOR_CLAIM_DOMAIN.length);
  return message;
}

/** Encodes an expiry and Ed25519 signature for `launch::claim_creator_caps`. */
export function encodeCreatorClaimAttestation(
  expiryMs: bigint,
  signature: Uint8Array,
): Uint8Array {
  requireU64("expiryMs", expiryMs);
  requireLength("signature", signature, ED25519_SIGNATURE_LENGTH);

  return creatorClaimAttestationBcs
    .serialize([expiryMs, Array.from(signature)])
    .toBytes();
}

function requireLength(name: string, value: Uint8Array, length: number) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${name} must contain ${length} bytes`);
  }
}
