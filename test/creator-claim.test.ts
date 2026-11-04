import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeCreatorClaimAttestation,
  encodeCreatorClaimMessage,
} from "@interest-protocol/blast-launchpad-sdk/creator-claim";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toHex } from "@mysten/sui/utils";

const accountCommitment = Uint8Array.from([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc,
  0xdd, 0xee, 0xff, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x00, 0x99, 0x88, 0x77,
  0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
]);
const expiryMs = 2_000_000n;

// Fixtures from contracts 9d76884 `creator_authority_tests`, whose harness
// publishes the launchpad at 0xc.
const moveMessage = {
  memeType: "0xc::creator_authority_tests::TEST_MEME",
  accountCommitment,
  claimant: "0xc0ffee",
  expiryMs,
};
const MOVE_TAGGED_MESSAGE =
  "626c6173745f66756e3a3a63726561746f725f636c61696d3a3a763164303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030633a3a63726561746f725f617574686f726974795f74657374733a3a544553545f4d454d452011223344556677889900aabbccddeeffffeeddccbbaa009988776655443322110000000000000000000000000000000000000000000000000000000000c0ffee80841e0000000000";
const MOVE_SIGNATURES = [
  {
    seed: 7,
    publicKey:
      "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    signature:
      "3fb85e420aec61b9cf441af24cbc48bf5cbc7ce7fb3b116327f04ac9a86c9cd6fa2598296fd39611234edbf61eeccc2993cb083a88c5d6de464920df06f82102",
  },
  {
    seed: 8,
    publicKey:
      "1398f62c6d1a457c51ba6a4b5f3dbd2f69fca93216218dc8997e416bd17d93ca",
    signature:
      "5e17e9f22982da21fde818ea7118d21915cd41a54c5746443bc9a37d24832ec03f00253eb58b4c34a1acc1df837537247076102f271496e01e6819492da7b10e",
  },
];
// Seed [7; 32] over the same claim without the tag, which the contract rejects.
const MOVE_UNTAGGED_SIGNATURE =
  "ff0ced0a7390306e2da4210845558a93f6594f4c30836e2499ad400e38a9fbadc4591d9188fa6aaaac9ff3575a7c212f62fc451d1266ea744b847b4c7afc6a04";

test("matches the contract's tagged creator-claim message fixture", () => {
  const message = encodeCreatorClaimMessage(moveMessage);

  assert.equal(toHex(message), MOVE_TAGGED_MESSAGE);
  assert.equal(
    new TextDecoder().decode(message.slice(0, 28)),
    "blast_fun::creator_claim::v1",
  );
});

test("reproduces the contract's Ed25519 signatures over the tagged message", async () => {
  const message = encodeCreatorClaimMessage(moveMessage);

  for (const { seed, publicKey, signature } of MOVE_SIGNATURES) {
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(seed));
    assert.equal(toHex(keypair.getPublicKey().toRawBytes()), publicKey);
    assert.equal(toHex(await keypair.sign(message)), signature);
  }
  const untagged = await Ed25519Keypair.fromSecretKey(
    new Uint8Array(32).fill(7),
  ).sign(message.slice(28));
  assert.equal(toHex(untagged), MOVE_UNTAGGED_SIGNATURE);
});

test("encodes the claim expiry followed by a 64-byte signature", () => {
  const signature = Uint8Array.from({ length: 64 }, (_, index) => index);
  const attestation = encodeCreatorClaimAttestation(expiryMs, signature);

  assert.equal(toHex(attestation.slice(0, 9)), "80841e000000000040");
  assert.deepEqual(attestation.slice(9), signature);
});

test("rejects malformed creator-claim inputs", () => {
  assert.throws(
    () =>
      encodeCreatorClaimMessage({
        memeType: "0x1::meme::MEME",
        accountCommitment: new Uint8Array(31),
        claimant: "0xc0ffee",
        expiryMs,
      }),
    /32 bytes/,
  );
  assert.throws(
    () => encodeCreatorClaimAttestation(expiryMs, new Uint8Array(63)),
    /64 bytes/,
  );
});
