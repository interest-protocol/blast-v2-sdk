/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "b841a811f1cb299543ce215efda586686f77383d",
  artifacts: Object.freeze({
    launchpad:
      "c9bfa8b13d0f8636ee1714824a921086e71df73f70480357b9a8803068171878",
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
