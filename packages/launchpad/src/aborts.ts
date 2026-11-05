import { abortName } from "@interest-protocol/blast-core/aborts";

/**
 * The `blast_fun` error registry (`sui/launchpad/sources/lib/errors.move`):
 * a name's index is its numeric abort code. Codes are package-wide, so check
 * first that the abort location's package is `blast_fun`; the module is only
 * where the macro expanded.
 */
export const LAUNCHPAD_ABORTS = [
  "EInvalidTradeFeeBps",
  "EDecimalsNotAllowed",
  "EVenueNotAllowed",
  "EInvalidVenue",
  "EInvalidProtocolAllocation",
  "EInvalidShares",
  "ERecipientCapacityReached",
  "EInvalidSellBurnBps",
  "EInvalidInitialMemeSupply",
  "EInvalidMemeQuotePair",
  "EInvalidOpeningRound",
  "EInvalidGraduationTarget",
  "EInvalidLaunchLifecycle",
  "ESlippageExceeded",
  "EZeroTradeOutput",
  "EOpeningRoundEnded",
  "EOpeningRoundNotEnded",
  "ENothingAccrued",
  "ECreatorCapNotLive",
  "EUnchanged",
  "EInvalidCreatorRecipient",
  "EInvalidAccountCommitment",
  "EInvalidCreatorClaimPublicKey",
  "EInvalidCreatorClaimAttestation",
  "ECreatorClaimExpired",
  "ECreatorNotSender",
  "EInvalidCreatorClaimSignature",
  "EQuoteNotAllowed",
  "EInvalidVirtualQuote",
  "EZeroOpeningRoundBid",
  "EInvalidCreationFee",
  "ETooManyClaimSigners",
  "EUnguardedDelay",
  "EInvalidProtocolFeeShare",
  "EInvalidLpFeeBps",
] as const;

export type LaunchpadAbortName = (typeof LAUNCHPAD_ABORTS)[number];

/** The error a `blast_fun` abort `code` names; null for an unknown code. */
export function launchpadAbortName(code: number): LaunchpadAbortName | null {
  return abortName(LAUNCHPAD_ABORTS, code);
}
