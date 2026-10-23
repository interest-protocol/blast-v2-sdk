import type * as Admin from "@interest-protocol/blast-admin-sdk";
import type * as Boosts from "@interest-protocol/blast-boosts-sdk";
import type * as Cctp from "@interest-protocol/blast-cctp-sdk";
import type * as Coin from "@interest-protocol/blast-coin-sdk";
import type * as Deployments from "@interest-protocol/blast-deployments-sdk";
import type * as Rewards from "@interest-protocol/blast-holder-rewards-sdk";
import type * as Launchpad from "@interest-protocol/blast-launchpad-sdk";
import type * as Template from "@interest-protocol/blast-launchpad-sdk/template";
import type * as Migrators from "@interest-protocol/blast-migrators-sdk";
import type * as Partners from "@interest-protocol/blast-partners-sdk";
import type * as Presale from "@interest-protocol/blast-presale-sdk";
import type * as BlastSui from "@interest-protocol/blast-sui-sdk";

// Assign namespaces both ways so the legacy entry points retain the product
// functions, class constructors, and inferred parameter and return types.
const admin: typeof Admin =
  {} as typeof import("@interest-protocol/blast-sdk/admin");
const blastSui: typeof BlastSui =
  {} as typeof import("@interest-protocol/blast-sdk/blast-sui");
const boosts: typeof Boosts =
  {} as typeof import("@interest-protocol/blast-sdk/boosts");
const coin: typeof Coin =
  {} as typeof import("@interest-protocol/blast-sdk/coin");
const cctp: typeof Cctp =
  {} as typeof import("@interest-protocol/blast-sdk/cctp");
const deployments: typeof Deployments =
  {} as typeof import("@interest-protocol/blast-sdk/deployments");
const rewards: typeof Rewards =
  {} as typeof import("@interest-protocol/blast-sdk/holder-rewards");
const launchpad: typeof Launchpad =
  {} as typeof import("@interest-protocol/blast-sdk/launchpad");
const template: typeof Template =
  {} as typeof import("@interest-protocol/blast-sdk/launchpad/template");
const migrators: typeof Migrators =
  {} as typeof import("@interest-protocol/blast-sdk/migrators");
const partners: typeof Partners =
  {} as typeof import("@interest-protocol/blast-sdk/partners");
const presale: typeof Presale =
  {} as typeof import("@interest-protocol/blast-sdk/presale");

export const legacy: [
  typeof import("@interest-protocol/blast-sdk/admin"),
  typeof import("@interest-protocol/blast-sdk/blast-sui"),
  typeof import("@interest-protocol/blast-sdk/boosts"),
  typeof import("@interest-protocol/blast-sdk/coin"),
  typeof import("@interest-protocol/blast-sdk/cctp"),
  typeof import("@interest-protocol/blast-sdk/deployments"),
  typeof import("@interest-protocol/blast-sdk/holder-rewards"),
  typeof import("@interest-protocol/blast-sdk/launchpad"),
  typeof import("@interest-protocol/blast-sdk/launchpad/template"),
  typeof import("@interest-protocol/blast-sdk/partners"),
  typeof import("@interest-protocol/blast-sdk/presale"),
] = [
  admin,
  blastSui,
  boosts,
  coin,
  cctp,
  deployments,
  rewards,
  launchpad,
  template,
  partners,
  presale,
];

export type { SharedObjectReference } from "@interest-protocol/blast-core";
export type { CetusMemeSide } from "@interest-protocol/blast-migrators-sdk/transactions";
export type { PresaleDeployment } from "@interest-protocol/blast-sdk";
export { migrators };
