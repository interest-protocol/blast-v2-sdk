/** SDK vesting kinds and the on-chain modules that implement them. */
export type VestingKind = "linear" | "checkpoints";

/** Move module of `blast_fun_vesting` that owns each vesting kind. */
export const VESTING_MODULE_BY_KIND = {
  linear: "blast_fun_linear_vesting",
  checkpoints: "blast_fun_checkpoint_vesting",
} as const satisfies Record<VestingKind, string>;

export type VestingModule = (typeof VESTING_MODULE_BY_KIND)[VestingKind];

const KIND_BY_MODULE: Record<string, VestingKind> = {
  [VESTING_MODULE_BY_KIND.linear]: "linear",
  [VESTING_MODULE_BY_KIND.checkpoints]: "checkpoints",
};

/** The vesting kind an on-chain module implements, if it is a vesting module. */
export function vestingKindOfModule(module: string): VestingKind | undefined {
  return Object.hasOwn(KIND_BY_MODULE, module)
    ? KIND_BY_MODULE[module]
    : undefined;
}

/** The on-chain module that implements a vesting kind. */
export function vestingModule(kind: VestingKind): VestingModule {
  return VESTING_MODULE_BY_KIND[kind];
}
