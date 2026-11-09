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
  contractsCommit: "86ee8cf9df8e9b2ec920f9564e2fda8afbf82106",
  artifacts: Object.freeze({
    admin: "4763aac86c6a323ae583cb5fdb469be7150bbb10ba419747bda7e8c64bca1bfa",
    partners:
      "c03117f7d95c120cc76006bb36cb9cd0344d126c7af8f1be1d04cbf3364afdc1",
    core: "7ce8a71a70552fc75261b3b7320faa8df3c4097ef1506cc4d73249dfaf4552cd",
    vault: "ff8482c771b06cafb55a12ee88c1aa923932528b1f2e4e3c61db70b6c73b7fd3",
    migrators:
      "dc5769c774cfa99ff0854afcc5e623549ed19a3ab20fc0b940dd0340d33eb1a6",
    launchpad:
      "825dbc389651b3f65dfb1f6cf2b96f812980fef34c3761e8f323c72471da5e4b",
    presale: "5eafc6e1b55c5f8098dd77b15ae1a1531769cf686ceb21e95349b8fc5962e78c",
    aftermathDaoPresale:
      "f16bcfd27db79f71f347647a03dab47307b6924549f0969054268fc9eb2bbf00",
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
  /** True in the coordinated npm release build. */
  published: boolean;
  /** Reviewed SDK source commit, before release metadata; null for a working copy. */
  commit: string | null;
}>;

/**
 * Coordinated 0.2.1 release with route evidence for the November 6 launch stack.
 * The commit pins the reviewed implementation; the sdk-v0.2.1 Git tag records
 * the packaging commit, which also updates this release metadata.
 */
export const SDK_RELEASE: SdkRelease = Object.freeze({
  name: "@interest-protocol/blast-sdk",
  version: "0.2.1",
  published: true,
  commit: "8d88037ac836c0f0e14d52a03151340294e8041e",
});
