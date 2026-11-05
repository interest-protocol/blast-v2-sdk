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
  contractsCommit: "b50d0c3bee50b637a673d1ccb64b5413af4ba518",
  artifacts: Object.freeze({
    admin: "cc7e09a9d4c3d5c3f7df114359ba2e2edceea84d9171723e61be171e64724a25",
    partners:
      "dcd7c35211c1249ca9a55e828cee581e76c1f8ce1d065173e384c8261c7c6750",
    core: "a364700d313427dda5b4993757cab50030eab041089e3f8bb5b6ee45f9a06922",
    vault: "267b061a0bf19a18b5712af5f7ba7be17635f699b455806dd3202d485f2d0bc1",
    migrators:
      "e4c2b4d28adfbf8d37ecce83c1f0c60ae13cbc394ac71aa1189f97a8237a1774",
    launchpad:
      "e988eabbb7e9c1fb39285bc38fb97a3983b27231a66ab581c2379875478fb407",
    presale: "9bac451903a5c914b19d727944c74a0581a6a88d0816a68148acd0bf762c9fb6",
    aftermathDaoPresale:
      "6d11bf119fecb4d1b3578d0787dc0230f82e7a181ff309e576526f3b2369491c",
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
