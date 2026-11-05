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
  contractsCommit: "a1a8f6c99552603d1bbfdfbcb06b4d0c2c316c6f",
  artifacts: Object.freeze({
    admin: "99fd5e0822f3c748b96d6e79a91666aefd713f243b0ad1e9871519b97fc433aa",
    partners:
      "8ca0343ba72e3aff60d9049602b18bf1ac054fcfbffe2bd93869fcacea09d6fb",
    core: "d959f2b6c4cc36ec0284768363ebf857c973d70c5aa53751d84b20f445fb6109",
    vault: "0a8af5bcbf68cdc9499c52b3fb4ae2959cdedfdf98bb91e5920cac9e89f1754c",
    migrators:
      "ec9b6b82b991a4e5f1640e7fb00bdbe05a44d997f2d631ae2cb35ae46a00dccc",
    launchpad:
      "f8173bd0216f7a36089e19640eef5a65e39babc9a83f6b230ec42e7841c269ea",
    presale: "8726e5687f4d4fd96b91e611a44d18786de742b1abffe98a4f9a6c3f16dc5200",
    aftermathDaoPresale:
      "71bc27ec5599bc358e0272a9f7cb221e6f8b5f69c4e3fa36a53b0d4e9fc3d592",
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
  version: "0.2.0",
  published: false,
  commit: null,
});
