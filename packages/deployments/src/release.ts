/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "7b13bfcbb20d44952c162d706f32ac65bf9716b5",
  artifacts: Object.freeze({
    launchpad:
      "73117fbef4c56dcaca99c27297052f9a89f5e906645eb3fbb084588eb73fdcdd",
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
