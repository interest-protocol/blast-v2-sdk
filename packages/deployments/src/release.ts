import type { ArtifactKey } from "./types.ts";

/**
 * The ABI this SDK is frozen to: the reviewed contracts commit and the sha256
 * of each committed parity artifact (`abi/production-<name>-v1.json`). A
 * manifest built from anything else is an ABI mismatch. The artifact digests
 * follow each `check:abi:write` refreeze.
 */
export const FROZEN_ABI: Readonly<{
  contractsCommit: string;
  artifacts: Readonly<Record<ArtifactKey, string>>;
}> = Object.freeze({
  contractsCommit: "4fe8d739f04bafd0775691795eb9f3727e984089",
  artifacts: Object.freeze({
    admin: "3c9a7f8a200a7ba9617ef1d1597e3fcb5a43fe2c0a75ef755117bd39a835d53d",
    partners:
      "8980fb166347378ad68c8b4277e1070ac533bcc9f052197551ce9a1036e227a4",
    core: "0000000000000000000000000000000000000000000000000000000000000000",
    vault: "0000000000000000000000000000000000000000000000000000000000000000",
    migrators:
      "0000000000000000000000000000000000000000000000000000000000000000",
    launchpad:
      "7ca399dd441aeaa8f63df5e67e44cb7d93a678a47410e4c86193baede5661887",
    presale: "2868e20d71c264c4c2bdd0ce02746136670a5c343d2f62b6bfb6d33d62dd8e99",
    aftermathDaoPresale:
      "0c3031e874e48cf7fcbc63f4e6d8a75a19815a200e0277bdd9ea82d316daf57f",
    blastSui:
      "943236915134897494c1a1eb7f18d2a0ea8a012e6e657321abc5fc274ee3587f",
    boosts: "917665645d05883fffdfd581367c2b45522aa8de52f57aa9730c101bb329cd8b",
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
 * Unreleased source build of the fresh launch stack. Its deployment and the
 * coordinated SDK release register their own package IDs and release
 * identity.
 */
export const SDK_RELEASE: SdkRelease = Object.freeze({
  name: "@interest-protocol/blast-sdk",
  version: "0.1.4",
  published: false,
  commit: null,
});
