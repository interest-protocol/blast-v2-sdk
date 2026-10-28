/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact. A manifest built from anything else is an
 * ABI mismatch.
 */
export const FROZEN_ABI = Object.freeze({
  contractsCommit: "9255e78751b70b22d8f33cc6577df126a3434424",
  artifacts: Object.freeze({
    launchpad:
      "7ca399dd441aeaa8f63df5e67e44cb7d93a678a47410e4c86193baede5661887",
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
 * Release identity of the validated canonical MVR sources shipped in 0.1.1.
 * Production signing separately requires a released deployment and runtime
 * verification; canonical package bindings alone do not authorize it.
 */
export const SDK_RELEASE: SdkRelease = Object.freeze({
  name: "@interest-protocol/blast-sdk",
  version: "0.1.1",
  published: true,
  commit: "1719b378f9a755c86fd8e70dc35f6ac651da343f",
});
