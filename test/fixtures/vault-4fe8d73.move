// Fixture generator for test/fixtures/vault-4fe8d73.ts. It is not compiled by the SDK and is
// never added to the contracts repository. It runs against the real `blast_vault` package at
// contracts 4fe8d739 and its test-only `vault_fixture`. To regenerate: copy `sui/{admin,core,
// partners,vesting,vault}` from that commit to a scratch directory (sources, manifests and
// `vault/tests/vault_fixture.move` only), set `blast_vault` in `vault/Move.toml` to
// 0x0b1a5f00000000000000000000000000000000000000000000000000000000f3, write this file to
// `vault/tests/sdk_vault_fixture.move`, and run `sui move test print_vault_fixture` in `vault/`
// (sui 1.77.2). Each `[debug]` label precedes its value.
#[test_only]
module blast_vault::sdk_vault_fixture;

const ALICE: address = @0xA11CE;
const FEE_ADDRESS: address = @0xFEE;
const ROUND_DELAY_MS: u64 = 2 * 60 * 60 * 1_000;
const CLAIM_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MANIFEST: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000001";

#[test]
fun print_vault_fixture() {
    let mut scenario = vault_fixture::begin();
    let mut f = vault_fixture::start(&mut scenario);

    // Registry: two admitted witnesses, one pending admission, one pending delay.
    let version = blast_vault_package::version_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.increment_for_testing(1_000);
    blast_vault_package::schedule_witness<OtherVenue>(
        f.registry_mut(),
        &venue_admin(),
        &version,
        &clock,
    );
    blast_vault_package::schedule_witness_delay(
        f.registry_mut(),
        &venue_admin(),
        &version,
        172_800_000,
        &clock,
    );
    destroy(version);
    clock.destroy_for_testing();
    let registry_bytes = bcs::to_bytes(f.registry());
    label(b"registry");
    debug::print(&object::id(f.registry()));
    debug::print(&registry_bytes);

    // VaultCreated.
    let split = fee_split::new(vector[
        fee_split::route(fee_split::owner_destination(), bps::new(4_000)),
        fee_split::route(fee_split::auto_lp_destination(), bps::new(2_000)),
        fee_split::route(fee_split::holder_rewards_destination(), bps::new(2_000)),
        fee_split::route(fee_split::burn_destination(), bps::new(1_000)),
        fee_split::route(fee_split::address_destination(FEE_ADDRESS), bps::new(1_000)),
    ]);
    let terms = f.terms_for(split, 1_500, 1_000, true, false);
    let vault = f.new_vault(terms);
    let residual_meme = f.meme(7);
    vault.share_with_position(
        &vault_fixture::venue(),
        f.treasury(),
        vault_fixture::new_position(scenario.ctx()),
        123_456_789,
        residual_meme,
        balance::create_for_testing<QUOTE>(11),
        scenario.ctx(),
    );
    print_last_event<VaultCreated<VAULT_FIXTURE, QUOTE, TestVenue>>(b"VaultCreated");
    scenario.next_tx(vault_fixture::sender());
    let mut vault = vault_fixture::take_vault(&scenario);
    label(b"vault_id");
    debug::print(&object::id(&vault));

    // FeesCollected.
    f.collect(&mut vault, 1_000_003, 2_000_007, scenario.ctx());
    print_last_event<FeesCollected<VAULT_FIXTURE, QUOTE>>(b"FeesCollected");

    // OwnerBalancesClaimed.
    let (meme, quote) = vault.claim_owner_balances(
        vault_fixture::owner_proof(),
        f.version(),
        scenario.ctx(),
    );
    destroy(meme);
    destroy(quote);
    print_last_event<OwnerBalancesClaimed<VAULT_FIXTURE, QUOTE>>(b"OwnerBalancesClaimed");

    // AutoLpPositionOpened, AutoLiquidityAdded.
    let position = vault_fixture::new_position(scenario.ctx());
    vault.attach_auto_lp_position(&vault_fixture::venue(), f.version(), position);
    print_last_event<AutoLpPositionOpened<VAULT_FIXTURE, QUOTE>>(b"AutoLpPositionOpened");
    let (mut meme, mut quote, receipt) = vault.take_auto_lp(&vault_fixture::venue(), f.version());
    let meme_back = meme.split(13);
    let quote_back = quote.split(17);
    destroy(meme);
    destroy(quote);
    vault.keep_auto_lp(&vault_fixture::venue(), f.version(), receipt, meme_back, quote_back);
    print_last_event<AutoLiquidityAdded<VAULT_FIXTURE, QUOTE>>(b"AutoLiquidityAdded");

    // BuybackBurned.
    let (quote, receipt) = vault.take_buyback_quote(
        &vault_fixture::venue(),
        &buyback_admin(),
        f.version(),
        100_000,
    );
    destroy(quote);
    f.burn_buyback(&mut vault, receipt, 5_000, 1_000, 4_000, scenario.ctx());
    print_last_event<BuybackBurned<VAULT_FIXTURE, QUOTE>>(b"BuybackBurned");
    scenario.next_tx(vault_fixture::sender());

    // RoundPublished, RewardClaimed, GasReserveSettled, RoundClosed.
    let vault_id = object::id(&vault);
    let alice = holder_rewards::reward_leaf_for_testing(vault_id, 0, 0, ALICE, 100_000, 200_000);
    holder_rewards::schedule_round(
        &mut vault,
        &rewards_admin(),
        f.version(),
        0,
        10,
        100,
        alice,
        MANIFEST,
        1,
        100_000,
        200_000,
        20_000,
        CLAIM_WINDOW_MS,
        vault_fixture::treasury_address(),
        f.clock(),
    );
    f.clock_mut().increment_for_testing(ROUND_DELAY_MS);
    holder_rewards::publish_round(&mut vault, f.version(), f.treasury(), f.clock(), scenario.ctx());
    print_last_event<RoundPublished<VAULT_FIXTURE, QUOTE>>(b"RoundPublished");
    scenario.next_tx(vault_fixture::sender());
    let mut round = scenario.take_shared<Round<VAULT_FIXTURE, QUOTE>>();
    label(b"round_id");
    debug::print(&object::id(&round));
    label(b"round_published");
    debug::print(&bcs::to_bytes(&round));
    round.claim(f.version(), 0, ALICE, 100_000, 200_000, vector[], f.clock(), scenario.ctx());
    print_last_event<RewardClaimed<VAULT_FIXTURE, QUOTE>>(b"RewardClaimed");
    round.settle_gas_reserve(&rewards_admin(), f.version(), &mut vault, 5_000, scenario.ctx());
    print_last_event<GasReserveSettled<VAULT_FIXTURE, QUOTE>>(b"GasReserveSettled");
    label(b"round_settled");
    debug::print(&bcs::to_bytes(&round));
    f.clock_mut().increment_for_testing(CLAIM_WINDOW_MS);
    round.close_round(f.version(), &mut vault, f.clock());
    print_last_event<RoundClosed<VAULT_FIXTURE, QUOTE>>(b"RoundClosed");
    scenario.next_tx(vault_fixture::sender());

    // A vault with every balance, a pending split, pending Blast bps and a scheduled round.
    f.collect(&mut vault, 3_000_001, 4_000_003, scenario.ctx());
    print_last_event<FeesCollected<VAULT_FIXTURE, QUOTE>>(b"FeesCollected2");
    vault.schedule_fee_split(
        vault_fixture::owner_proof(),
        f.version(),
        vault_fixture::owner_split(),
        f.clock(),
    );
    print_last_event<DelayedScheduled<FeeSplitKey, FeeSplit>>(b"FeeSplitScheduled");
    vault.schedule_protocol_bps(
        &fee_admin(),
        f.version(),
        bps::new(500),
        bps::new(700),
        f.clock(),
    );
    print_last_event<DelayedScheduled<ProtocolBpsKey, ProtocolBps>>(b"ProtocolBpsScheduled");
    holder_rewards::schedule_round(
        &mut vault,
        &rewards_admin(),
        f.version(),
        1,
        100,
        200,
        MANIFEST,
        MANIFEST,
        3,
        10,
        10,
        1,
        CLAIM_WINDOW_MS,
        vault_fixture::treasury_address(),
        f.clock(),
    );
    print_last_event<ActionScheduled<RoundPublicationKey, RoundTerms>>(b"RoundScheduled");
    label(b"clock_ms");
    debug::print(&f.clock().timestamp_ms());
    label(b"vault");
    debug::print(&bcs::to_bytes(&vault));

    test_scenario::return_shared(vault);
    f.end();
    scenario.end();
}

fun print_last_event<T: copy + drop>(name: vector<u8>) {
    let events = event::events_by_type<T>();
    label(name);
    debug::print(&bcs::to_bytes(&events[events.length() - 1]));
}

fun label(name: vector<u8>) {
    debug::print(&name.to_string());
}

fun venue_admin(): AdminWitness<VenueAdmin> { blast_acl::witness_for_testing() }

fun rewards_admin(): AdminWitness<RewardsAdmin> { blast_acl::witness_for_testing() }

fun fee_admin(): AdminWitness<FeeAdmin> { blast_acl::witness_for_testing() }

fun buyback_admin(): AdminWitness<BuybackAdmin> { blast_acl::witness_for_testing() }

use blast_admin::{
    blast_acl::{Self, AdminWitness},
    delayed::DelayedScheduled,
    delayed_action::ActionScheduled
};

use blast_core::{
    blast_domain::{BuybackAdmin, FeeAdmin, RewardsAdmin, VenueAdmin},
    bps,
    fee_split::{Self, FeeSplit}
};

use blast_vault::{
    blast_vault_events::{
        AutoLiquidityAdded,
        AutoLpPositionOpened,
        BuybackBurned,
        FeesCollected,
        GasReserveSettled,
        OwnerBalancesClaimed,
        RewardClaimed,
        RoundClosed,
        RoundPublished,
        VaultCreated
    },
    blast_vault_package,
    holder_rewards::{Self, Round},
    vault::{FeeSplitKey, ProtocolBps, ProtocolBpsKey, RoundPublicationKey, RoundTerms},
    vault_fixture::{Self, OtherVenue, QUOTE, TestVenue, VAULT_FIXTURE}
};

use std::{bcs, debug, unit_test::destroy};

use sui::{balance, clock, event, test_scenario};
