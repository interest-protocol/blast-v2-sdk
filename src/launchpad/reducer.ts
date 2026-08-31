import type { DecodedLaunchpadEvent, LaunchpadEventKind } from "./events.ts";
import { launchpadEventId, launchpadEventSpecs } from "./events.ts";

export type LaunchMigrationProjection = {
  memeAmount: bigint;
  quoteAmount: bigint;
  disposedMeme: bigint;
  nativeSupplyBurned: boolean;
  totalSupplyAfter: bigint;
};

export type LaunchEventProjection = {
  launchId: string;
  ticketId: string;
  memeType: string;
  quoteType: string;
  migrationWitnessType: string;
  launcher: string;
  metadataCapId: string;
  lifecycle: "Live" | "MigrationReady" | "Migrated";
  sellBurnBps: bigint;
  initialMemeSupply: bigint;
  memeReserve: bigint;
  realQuoteReserve: bigint;
  pendingBurn: bigint;
  protocolMemeGraduationFee: bigint;
  memeLiquidityProvision: bigint;
  protocolMemeFees: bigint;
  creatorMemeFees: bigint;
  protocolQuoteFees: bigint;
  creatorQuoteFees: bigint;
  virtualQuote: bigint;
  migrationQuoteTarget: bigint;
  quoteFeeBps: bigint;
  memeFeeBps: bigint;
  quoteMigrationFeeBps: bigint;
  protocolMemeGraduationFeeBps: bigint;
  memeLiquidityProvisionBps: bigint;
  migration: LaunchMigrationProjection | null;
};

export type LaunchTicketEventProjection = {
  ticketId: string;
  memeType: string;
  initialSupply: bigint;
  metadataCapId: string;
  launcher: string;
  creator: string | null;
  xIdentityHash: Uint8Array | null;
  burnable: boolean;
  sellBurnBps: bigint;
};

export type LaunchpadConfigProjection = {
  packageVersion: bigint | null;
  protocolFeeShareBps: bigint | null;
  tradeFeeDefaults: {
    quoteFeeBps: bigint;
    memeFeeBps: bigint;
  } | null;
  graduationDefaults: {
    quoteMigrationFeeBps: bigint;
    protocolMemeGraduationFeeBps: bigint;
    memeLiquidityProvisionBps: bigint;
  } | null;
  quotes: Readonly<
    Record<string, { virtualQuote: bigint; migrationQuoteTarget: bigint }>
  >;
  migrationWitnesses: Readonly<Record<string, true>>;
};

export type LaunchpadAdministrationProjection = {
  admins: Readonly<
    Record<
      string,
      {
        adminCapId: string;
        recipient: string | null;
        active: boolean;
        destroyed: boolean;
        wasActiveAtDestruction: boolean | null;
      }
    >
  >;
  creatorCapClaims: Readonly<
    Record<
      string,
      {
        memeType: string;
        creator: string;
        xIdentityHash: Uint8Array | null;
        xClaimExpiryMs: bigint | null;
      }
    >
  >;
  packageAdmin: {
    packageAdminId: string;
    publisherId: string;
    upgradeCapId: string;
    packageId: string;
    packageVersion: bigint;
    policy: number;
  } | null;
  pendingSuperAdminTransfer: {
    recipient: string;
    executeAfterMs: bigint;
  } | null;
  superAdmin: {
    previousCapId: string;
    capId: string;
    recipient: string;
  } | null;
  pendingUpgrade: {
    packageId: string;
    packageVersion: bigint;
    policy: number;
    digest: Uint8Array;
  } | null;
  lastUpgradeCommit: {
    packageId: string;
    previousVersion: bigint;
    newVersion: bigint;
  } | null;
  xClaimSignerPublicKey: Uint8Array | null;
};

export type LaunchpadEventProjection = {
  appliedEventIds: Readonly<Record<string, true>>;
  eventCounts: Readonly<Record<LaunchpadEventKind, number>>;
  launches: Readonly<Record<string, LaunchEventProjection>>;
  tickets: Readonly<Record<string, LaunchTicketEventProjection>>;
  config: LaunchpadConfigProjection;
  administration: LaunchpadAdministrationProjection;
};

export function createLaunchpadEventProjection(): LaunchpadEventProjection {
  return {
    appliedEventIds: {},
    eventCounts: Object.fromEntries(
      Object.keys(launchpadEventSpecs).map((kind) => [kind, 0]),
    ) as Record<LaunchpadEventKind, number>,
    launches: {},
    tickets: {},
    config: {
      packageVersion: null,
      protocolFeeShareBps: null,
      tradeFeeDefaults: null,
      graduationDefaults: null,
      quotes: {},
      migrationWitnesses: {},
    },
    administration: {
      admins: {},
      creatorCapClaims: {},
      packageAdmin: null,
      pendingSuperAdminTransfer: null,
      superAdmin: null,
      pendingUpgrade: null,
      lastUpgradeCommit: null,
      xClaimSignerPublicKey: null,
    },
  };
}

export function reduceLaunchpadEvent(
  state: LaunchpadEventProjection,
  event: DecodedLaunchpadEvent,
): LaunchpadEventProjection {
  const eventId = launchpadEventId(event);
  if (state.appliedEventIds[eventId]) return state;

  const next: LaunchpadEventProjection = {
    ...state,
    appliedEventIds: { ...state.appliedEventIds, [eventId]: true },
    eventCounts: {
      ...state.eventCounts,
      [event.kind]: state.eventCounts[event.kind] + 1,
    },
  };

  switch (event.kind) {
    case "LaunchTicketCreated": {
      const payload = event.payload;
      return {
        ...next,
        tickets: {
          ...state.tickets,
          [payload.ticket_id]: {
            ticketId: payload.ticket_id,
            memeType: payload.meme,
            initialSupply: payload.initial_supply,
            metadataCapId: payload.metadata_cap_id,
            launcher: event.sender,
            creator: payload.creator,
            xIdentityHash: payload.x_identity_hash,
            burnable: payload.burnable,
            sellBurnBps: payload.sell_burn_bps,
          },
        },
      };
    }
    case "LaunchCreated": {
      const payload = event.payload;
      return {
        ...next,
        launches: {
          ...state.launches,
          [payload.launch_id]: {
            launchId: payload.launch_id,
            ticketId: payload.ticket_id,
            memeType: payload.meme,
            quoteType: payload.quote,
            migrationWitnessType: payload.migration_witness,
            launcher: event.sender,
            metadataCapId: payload.metadata_cap_id,
            lifecycle: "Live",
            sellBurnBps: payload.sell_burn_bps,
            initialMemeSupply: payload.initial_meme_supply,
            memeReserve: payload.meme_reserve,
            realQuoteReserve: payload.real_quote_reserve,
            pendingBurn: payload.pending_burn,
            protocolMemeGraduationFee: payload.protocol_meme_graduation_fee,
            memeLiquidityProvision: payload.meme_liquidity_provision,
            protocolMemeFees: payload.protocol_meme_trade_fees,
            creatorMemeFees: payload.creator_meme_trade_fees,
            protocolQuoteFees: payload.protocol_quote_trade_fees,
            creatorQuoteFees: payload.creator_quote_trade_fees,
            virtualQuote: payload.virtual_quote,
            migrationQuoteTarget: payload.migration_quote_target,
            quoteFeeBps: payload.quote_fee_bps,
            memeFeeBps: payload.meme_fee_bps,
            quoteMigrationFeeBps: payload.quote_migration_fee_bps,
            protocolMemeGraduationFeeBps:
              payload.protocol_meme_graduation_fee_bps,
            memeLiquidityProvisionBps: payload.meme_liquidity_provision_bps,
            migration: null,
          },
        },
      };
    }
    case "Bought": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle: payload.crossed_threshold
          ? "MigrationReady"
          : launch.lifecycle,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        protocolMemeFees: payload.protocol_meme_fee_total,
        creatorMemeFees: payload.creator_meme_fee_total,
        protocolQuoteFees: payload.protocol_quote_fee_total,
        creatorQuoteFees: payload.creator_quote_fee_total,
      }));
    }
    case "Sold": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        memeReserve: payload.meme_reserve,
        realQuoteReserve: payload.real_quote_reserve,
        pendingBurn: payload.pending_burn_total,
        protocolMemeFees: payload.protocol_meme_fee_total,
        creatorMemeFees: payload.creator_meme_fee_total,
        protocolQuoteFees: payload.protocol_quote_fee_total,
        creatorQuoteFees: payload.creator_quote_fee_total,
      }));
    }
    case "CreatorFeesClaimed":
      return updateLaunch(next, event.payload.launch_id, (launch) => ({
        ...launch,
        creatorMemeFees: 0n,
        creatorQuoteFees: 0n,
      }));
    case "ProtocolFeesClaimed":
      return updateLaunch(next, event.payload.launch_id, (launch) => ({
        ...launch,
        protocolMemeFees: 0n,
        protocolQuoteFees: 0n,
      }));
    case "Migrated": {
      const payload = event.payload;
      return updateLaunch(next, payload.launch_id, (launch) => ({
        ...launch,
        lifecycle: "Migrated",
        memeReserve: 0n,
        realQuoteReserve: 0n,
        pendingBurn: 0n,
        protocolMemeGraduationFee: 0n,
        memeLiquidityProvision: 0n,
        protocolMemeFees: payload.protocol_meme_fee_total,
        protocolQuoteFees: payload.protocol_quote_fee_total,
        migration: {
          memeAmount: payload.migration_meme,
          quoteAmount: payload.migration_quote,
          disposedMeme: payload.disposed_meme,
          nativeSupplyBurned: payload.native_supply_burned,
          totalSupplyAfter: payload.total_supply_after,
        },
      }));
    }
    case "PackageVersionAdvanced":
      return updateConfig(next, {
        ...state.config,
        packageVersion: event.payload.new_version,
      });
    case "ProtocolFeeShareChanged":
      return updateConfig(next, {
        ...state.config,
        protocolFeeShareBps: event.payload.new_protocol_fee_share_bps,
      });
    case "LaunchTradeFeesChanged":
      return updateConfig(next, {
        ...state.config,
        tradeFeeDefaults: {
          quoteFeeBps: event.payload.new_quote_fee_bps,
          memeFeeBps: event.payload.new_meme_fee_bps,
        },
      });
    case "GraduationDefaultsChanged":
      return updateConfig(next, {
        ...state.config,
        graduationDefaults: {
          quoteMigrationFeeBps: event.payload.new_quote_migration_fee_bps,
          protocolMemeGraduationFeeBps:
            event.payload.new_protocol_meme_graduation_fee_bps,
          memeLiquidityProvisionBps:
            event.payload.new_meme_liquidity_provision_bps,
        },
      });
    case "QuoteAllowed": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: {
          ...state.config.quotes,
          [payload.quote]: {
            virtualQuote: payload.virtual_quote,
            migrationQuoteTarget: payload.migration_quote_target,
          },
        },
      });
    }
    case "QuoteParametersChanged": {
      const payload = event.payload;
      return updateConfig(next, {
        ...state.config,
        quotes: {
          ...state.config.quotes,
          [payload.quote]: {
            virtualQuote: payload.new_virtual_quote,
            migrationQuoteTarget: payload.new_migration_quote_target,
          },
        },
      });
    }
    case "QuoteDisallowed": {
      const quotes = { ...state.config.quotes };
      delete quotes[event.payload.quote];
      return updateConfig(next, { ...state.config, quotes });
    }
    case "MigrationWitnessAllowed":
      return updateConfig(next, {
        ...state.config,
        migrationWitnesses: {
          ...state.config.migrationWitnesses,
          [event.payload.migration_witness]: true,
        },
      });
    case "MigrationWitnessDisallowed": {
      const migrationWitnesses = { ...state.config.migrationWitnesses };
      delete migrationWitnesses[event.payload.migration_witness];
      return updateConfig(next, { ...state.config, migrationWitnesses });
    }
    case "AdminGranted": {
      const payload = event.payload;
      return updateAdministration(next, {
        ...state.administration,
        admins: {
          ...state.administration.admins,
          [payload.admin_cap_id]: {
            adminCapId: payload.admin_cap_id,
            recipient: payload.recipient,
            active: true,
            destroyed: false,
            wasActiveAtDestruction: null,
          },
        },
      });
    }
    case "AdminRevoked": {
      const payload = event.payload;
      const previous = state.administration.admins[payload.admin_cap_id];
      return updateAdministration(next, {
        ...state.administration,
        admins: {
          ...state.administration.admins,
          [payload.admin_cap_id]: {
            adminCapId: payload.admin_cap_id,
            recipient: previous?.recipient ?? null,
            active: false,
            destroyed: false,
            wasActiveAtDestruction: null,
          },
        },
      });
    }
    case "AdminDestroyed": {
      const payload = event.payload;
      const previous = state.administration.admins[payload.admin_cap_id];
      return updateAdministration(next, {
        ...state.administration,
        admins: {
          ...state.administration.admins,
          [payload.admin_cap_id]: {
            adminCapId: payload.admin_cap_id,
            recipient: previous?.recipient ?? null,
            active: false,
            destroyed: true,
            wasActiveAtDestruction: payload.was_active,
          },
        },
      });
    }
    case "CreatorCapClaimed": {
      const payload = event.payload;
      return updateAdministration(next, {
        ...state.administration,
        creatorCapClaims: {
          ...state.administration.creatorCapClaims,
          [payload.meme]: {
            memeType: payload.meme,
            creator: event.sender,
            xIdentityHash: payload.x_identity_hash,
            xClaimExpiryMs: payload.x_claim_expiry_ms,
          },
        },
      });
    }
    case "PackageAdminCreated": {
      const payload = event.payload;
      return updateAdministration(next, {
        ...state.administration,
        packageAdmin: {
          packageAdminId: payload.package_admin_id,
          publisherId: payload.publisher_id,
          upgradeCapId: payload.upgrade_cap_id,
          packageId: payload.package_id,
          packageVersion: payload.package_version,
          policy: payload.policy,
        },
      });
    }
    case "SuperAdminTransferStarted":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: {
          recipient: event.payload.recipient,
          executeAfterMs: event.payload.execute_after_ms,
        },
      });
    case "SuperAdminTransferCancelled":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: null,
      });
    case "SuperAdminTransferred":
      return updateAdministration(next, {
        ...state.administration,
        pendingSuperAdminTransfer: null,
        superAdmin: {
          previousCapId: event.payload.previous_super_admin_cap_id,
          capId: event.payload.new_super_admin_cap_id,
          recipient: event.payload.recipient,
        },
      });
    case "UpgradeAuthorized": {
      const packageAdmin = state.administration.packageAdmin;
      return updateAdministration(next, {
        ...state.administration,
        pendingUpgrade: packageAdmin
          ? {
              packageId: packageAdmin.packageId,
              packageVersion: packageAdmin.packageVersion,
              policy: packageAdmin.policy,
              digest: event.payload.digest,
            }
          : null,
      });
    }
    case "UpgradeCommitted": {
      const payload = event.payload;
      const packageAdmin = state.administration.packageAdmin;
      return updateAdministration(next, {
        ...state.administration,
        packageAdmin: packageAdmin
          ? {
              ...packageAdmin,
              packageId: payload.new_package_id,
              packageVersion: payload.new_version,
            }
          : null,
        pendingUpgrade: null,
        lastUpgradeCommit: {
          packageId: payload.new_package_id,
          previousVersion: payload.previous_version,
          newVersion: payload.new_version,
        },
      });
    }
    case "UpgradePolicyRestricted": {
      const packageAdmin = state.administration.packageAdmin;
      return updateAdministration(next, {
        ...state.administration,
        packageAdmin: packageAdmin
          ? { ...packageAdmin, policy: event.payload.new_policy }
          : null,
      });
    }
    case "XClaimSignerSet":
      return updateAdministration(next, {
        ...state.administration,
        xClaimSignerPublicKey: event.payload.signer_public_key,
      });
    case "XClaimSignerRevoked":
      return updateAdministration(next, {
        ...state.administration,
        xClaimSignerPublicKey: null,
      });
  }
}

function updateLaunch(
  state: LaunchpadEventProjection,
  launchId: string,
  update: (launch: LaunchEventProjection) => LaunchEventProjection,
): LaunchpadEventProjection {
  const launch = state.launches[launchId];
  if (!launch) return state;
  return {
    ...state,
    launches: { ...state.launches, [launchId]: update(launch) },
  };
}

function updateConfig(
  state: LaunchpadEventProjection,
  config: LaunchpadConfigProjection,
): LaunchpadEventProjection {
  return { ...state, config };
}

function updateAdministration(
  state: LaunchpadEventProjection,
  administration: LaunchpadAdministrationProjection,
): LaunchpadEventProjection {
  return { ...state, administration };
}
