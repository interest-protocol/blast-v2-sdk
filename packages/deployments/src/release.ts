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
    admin: "b4345a8ad862ec4612a61d5567e315f192dc9dfb1062b03fc1db7410b7cf58b0",
    partners:
      "583c9ac3848a511f35cc1e6e4abc85f70eb89cba469dccc6960b4111440c5009",
    core: "a1c6564d28de943def47b48df75731d82cdbd052943c51130dbb6f4d17b2f800",
    vault: "cc992f46c3c5346a1a35e305c05d98e6655db052f54700297e4546b8e3e65593",
    migrators:
      "1ec5b01788a799b3b6606ec9542f230c8de536c5698ca609ad89086dfe7abe86",
    launchpad:
      "5bd5545cdcc41f0013609093e94ea39abc6dc7f6ebc85e22ce0e11e61f903191",
    presale: "3e7f00f3cacd7b79209c6e716067b2d0faa658beb85d2c023984ea5fae94cf45",
    aftermathDaoPresale:
      "8ebfb800f9f3a4dfdbf87ed071bfb12d5e860f3fd8c7428c505ada7648eec18c",
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
