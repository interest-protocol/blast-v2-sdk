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
  contractsCommit: "88951fe9dbe2b621d45bb80124a325468c6e8298",
  artifacts: Object.freeze({
    admin: "06d0f918ccad763d841feed6028573abb2801a250539748ccbd44ab4c08ae621",
    partners:
      "821aa9101e42aea7cd0f97e5cc4cdb19023c61d97830c2860838fcf47668f4c6",
    core: "e1cdc867e4a93ade022ea3537dd95f3255b3f4da869411c65bbfcb91e20b9127",
    vault: "0cf20e53a58840c7a7ed692870e3f2e5450c92f90351720b03036c958f77a4ad",
    migrators:
      "a26bdcf52bbad5632dbf1a226cf05b0a8ff25238b7696111be8881bcb85f349d",
    launchpad:
      "1c76f5a5a096f1991bed2dd696b26f038a79c596d598fc2fccd7288189f8da2b",
    presale: "14398fe3bf3b82ef8ad583360961d82d2342bb7249d2b3241a4c45f5869af4db",
    aftermathDaoPresale:
      "b9adb79eb997447dc28369ded0094ad53fb4fe46200f4e8c58c0b2b3b3e17fcf",
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
