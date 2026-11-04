/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "9d76884868e449d5b6a72d4d0e12edc5df9dbe0f",
  artifacts: Object.freeze({
    launchpad:
      "2530a97950480e4581b2e6083cbb50be392d5579320ced15f2da2f8c74573633",
    blastSui:
      "943236915134897494c1a1eb7f18d2a0ea8a012e6e657321abc5fc274ee3587f",
  }),
});

/** This SDK build's release identity. */
export type SdkRelease = Readonly<{
  name: string;
  /** package.json `version`. */
  version: string;
  /** False until this SDK version is released to npm. */
  published: boolean;
  /** The released source commit; null for a working copy. */
  commit: string | null;
}>;

/**
 * Unreleased PR150 source build. A fresh deployment and coordinated SDK release
 * must register their own package IDs and release identity.
 */
export const SDK_RELEASE: SdkRelease = Object.freeze({
  name: "@interest-protocol/blast-sdk",
  version: "0.1.4",
  published: false,
  commit: null,
});
