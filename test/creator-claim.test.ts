import assert from "node:assert/strict";
import test from "node:test";

import { toHex } from "@mysten/sui/utils";

import {
  encodeCreatorClaimAttestation,
  encodeCreatorClaimMessage,
} from "../src/launchpad/creator-claim.ts";

const accountCommitment = Uint8Array.from([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xaa, 0xbb, 0xcc,
  0xdd, 0xee, 0xff, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x00, 0x99, 0x88, 0x77,
  0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
]);
const expiryMs = 2_000_000n;

test("matches the contract creator-claim message fixture", () => {
  const message = encodeCreatorClaimMessage({
    memeType: `${"0".repeat(64)}::creator_authority_tests::TEST_MEME`,
    accountCommitment,
    claimant: "0xc0ffee",
    expiryMs,
  });

  assert.equal(
    toHex(message),
    "64303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303a3a63726561746f725f617574686f726974795f74657374733a3a544553545f4d454d452011223344556677889900aabbccddeeffffeeddccbbaa009988776655443322110000000000000000000000000000000000000000000000000000000000c0ffee80841e0000000000",
  );
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
