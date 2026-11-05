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
  contractsCommit: "68db57b32f196a78cd952a718b462b758f882ded",
  artifacts: Object.freeze({
    admin: "ada49ae2efd5d0b0cf4fc653f039322304ee3e0f4bba255e8e4c09c627b9c114",
    partners:
      "002a628a90579b8ba7fef89e04ea650e1c4e10675dd756099aeb2e337388e0b9",
    core: "a36c5718d391a2bab515540912236c44375ba12ebf6217c24eaeb2749ed5f42b",
    vault: "0e29dd0cea83e3278863bb7f185b33add114e91ae8c5d04e936e3cdf7726bbc5",
    migrators:
      "b6abbc6d9f72d7dd98222f9088ec5e9707ac6fac87b8a4c10b311828f7bce965",
    launchpad:
      "922ae87bc665e73f54102df5e1fdba922d66580430b496d64e6b5fc3e3664edf",
    presale: "8039453df3caf70981b9dbcc625b01a550d3a6959ae6febe526a1979fbd0eb15",
    aftermathDaoPresale:
      "37cdc942c73bcf12a9037c3d8dceffe3c9ad04d701b355cb897d8f96a654fd3f",
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
