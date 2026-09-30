// Fixture generator for test/fixtures/launchpad-a2a1db2.ts. It is not compiled by the SDK.
// To regenerate: extract contracts commit a2a1db25f72a44e3b650bebe0ef806de4c70abbc with
// `git archive`, copy this file to sui/launchpad/tests/ in that copy only, and run
// `sui move test sdk_fixture_tests` from sui/launchpad. Never add it to the contracts repository.
#[test_only]
module blast_fun::sdk_fixture_tests;

const COIN_REGISTRY: address = @0xc;
const ADMIN: address = @0xAD;
const LAUNCHER: address = @0xB1A57;
const CREATOR: address = @0xC0FFEE;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const RECIPIENT: address = @0xFEED;
const ROUTE: address = @0xF00D;
const PARTNER_RECIPIENT: address = @0xBEEF;

public struct SDK_FIXTURE_TESTS has drop {}
public struct TEST_QUOTE() has drop;
public struct TEST_MIGRATION_WITNESS() has drop;

#[test]
fun print_fixtures() {
    let mut scenario = test_scenario::begin(ADMIN);
    let pv = package_version::new_for_testing(scenario.ctx());
    launch_config::init_for_testing(scenario.ctx());
    let mut runtime = runtime_config::new_disabled_for_testing(scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1_000);
    let partner = blast_partners::new_for_testing(PARTNER_RECIPIENT, 2_000, scenario.ctx());
    label(b"partner_id");
    debug::print(&bcs::to_bytes(&object::id(&partner)));

    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<LaunchConfig>();
    config.set_quote_allowed<TEST_QUOTE>(&pv, &blast_acl::witness_for_testing<ListingAdmin>(), true);
    print_event<QuoteSet>(b"event QuoteSet");
    config.set_migration_witness_allowed<TEST_MIGRATION_WITNESS>(
        &pv,
        &blast_acl::witness_for_testing<AdapterAdmin>(),
        true,
    );
    print_event<MigrationWitnessSet>(b"event MigrationWitnessSet");
    config.set_trade_fees(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), bps::new(100), bps::new(250));
    print_event<LaunchTradeFeesChanged>(b"event LaunchTradeFeesChanged");
    config.set_protocol_allocation(
        &pv,
        &blast_acl::witness_for_testing<TreasuryAdmin>(),
        bps::new(750),
        bps::new(250),
    );
    print_event<ProtocolAllocationSet>(b"event ProtocolAllocationSet");
    config.set_creation_fee(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), 5_000_000_000);
    print_event<CreationFeeChanged>(b"event CreationFeeChanged");
    config.add_partner(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), &partner);
    print_event<PartnerAdded>(b"event PartnerAdded");
    runtime.set_protocol_fee_share(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), bps::new(3_000));
    print_event<ProtocolFeeShareChanged>(b"event ProtocolFeeShareChanged");
    label(b"object LaunchConfig");
    debug::print(&bcs::to_bytes(&config));
    label(b"object RuntimeConfig");
    debug::print(&bcs::to_bytes(&runtime));
    label(b"object Partner");
    debug::print(&bcs::to_bytes(&partner));

    scenario.next_tx(LAUNCHER);
    let ticket = launch_ticket::new(
        test_utils::create_one_time_witness<SDK_FIXTURE_TESTS>(),
        9,
        b"SDK".to_string(),
        b"SDK Fixture".to_string(),
        b"".to_string(),
        b"".to_string(),
        creator_authority::new_address(CREATOR),
        false,
        1_000,
        scenario.ctx(),
    );
    print_event<LaunchTicketCreated>(b"event LaunchTicketCreated");
    label(b"object LaunchTicket");
    debug::print(&bcs::to_bytes(&ticket));

    scenario.next_tx(LAUNCHER);
    let mut currency = scenario.take_from_address<Currency<SDK_FIXTURE_TESTS>>(COIN_REGISTRY);
    let mut initializer = launch::new<_, TEST_QUOTE, _>(
        ticket,
        &pv,
        &config,
        TEST_MIGRATION_WITNESS(),
        200,
        10_000,
    );
    initializer.set_virtual_quote(3_000_000_000_000);
    initializer.set_graduation_target(12_345_678_901_237);
    initializer.set_allocation_plan(
        allocation::plan(
            bps::new(7_000),
            bps::new(2_000),
            bps::new(9_500),
            vector[allocation::recipient(RECIPIENT, bps::new(250), bps::new(250))],
        ),
    );
    initializer.set_lp_fee_split(
        allocation::fee_split(
            bps::new(5_000),
            bps::new(2_000),
            bps::new(1_000),
            bps::new(1_000),
            vector[allocation::route(ROUTE, bps::new(1_000))],
        ),
    );
    initializer.set_opening_round(60_000);
    initializer.set_partner(&config, &partner, &clock);
    let creation_fee = coin::mint_for_testing<SUI>(5_000_000_000, scenario.ctx());
    let mut launch = initializer.finalize(&mut currency, &config, creation_fee, scenario.ctx());
    test_scenario::return_to_address(COIN_REGISTRY, currency);
    print_event<LaunchCreated>(b"event LaunchCreated");
    label(b"object Launch finalized");
    debug::print(&bcs::to_bytes(&launch));

    let quote = coin::mint_for_testing<TEST_QUOTE>(1_000_000_000, scenario.ctx());
    launch.join_opening_round(&pv, quote, &clock, scenario.ctx());
    print_event<OpeningRoundJoined>(b"event OpeningRoundJoined creator");
    launch.share(&clock);
    print_event<LaunchShared>(b"event LaunchShared");

    scenario.next_tx(ALICE);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let quote = coin::mint_for_testing<TEST_QUOTE>(2_000_000_000, scenario.ctx());
    launch.join_opening_round(&pv, quote, &clock, scenario.ctx());
    print_event<OpeningRoundJoined>(b"event OpeningRoundJoined alice");
    label(b"object Launch opening round");
    debug::print(&bcs::to_bytes(&launch));
    test_scenario::return_shared(launch);

    clock.set_for_testing(61_000);
    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    launch.settle_opening_round(&pv, &runtime, &clock);
    print_event<Bought>(b"event Bought settlement");
    print_event<OpeningRoundSettled>(b"event OpeningRoundSettled");
    label(b"object Launch settled");
    debug::print(&bcs::to_bytes(&launch));
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    launch.deliver_opening_round(&pv, ALICE, scenario.ctx());
    print_event<OpeningRoundDelivered>(b"event OpeningRoundDelivered");
    test_scenario::return_shared(launch);

    scenario.next_tx(ALICE);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let mut meme = scenario.take_from_address<Coin<SDK_FIXTURE_TESTS>>(ALICE);
    let half = meme.value() / 2;
    let sold = meme.split(half, scenario.ctx());
    let quote_out = launch.sell(&pv, &runtime, sold, 1, scenario.ctx());
    print_event<Sold>(b"event Sold");
    transfer::public_transfer(quote_out, ALICE);
    transfer::public_transfer(meme, ALICE);
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let quote = coin::mint_for_testing<TEST_QUOTE>(20_000_000_000_000, scenario.ctx());
    let (meme_out, refund) = launch.buy(&pv, &runtime, quote, 1, scenario.ctx());
    print_event<Bought>(b"event Bought graduation");
    label(b"object Launch migration ready");
    debug::print(&bcs::to_bytes(&launch));
    transfer::public_transfer(meme_out, BOB);
    transfer::public_transfer(refund, BOB);
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let mut currency = scenario.take_from_address<Currency<SDK_FIXTURE_TESTS>>(COIN_REGISTRY);
    let (meme, quote) = launch.migrate(&pv, &mut currency, TEST_MIGRATION_WITNESS(), scenario.ctx());
    print_event<MigrationAllocationPaid>(b"event MigrationAllocationPaid");
    print_event<ProtocolFeesAccrued>(b"event ProtocolFeesAccrued");
    print_event<Migrated>(b"event Migrated");
    label(b"object Launch migrated");
    debug::print(&bcs::to_bytes(&launch));
    destroy(meme);
    destroy(quote);
    test_scenario::return_to_address(COIN_REGISTRY, currency);
    test_scenario::return_shared(launch);

    scenario.next_tx(CREATOR);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let (curve_fee_cap, metadata_cap) = launch.claim_creator_caps(
        &pv,
        &runtime,
        option::none(),
        &clock,
        scenario.ctx(),
    );
    print_event<CreatorCapsClaimed>(b"event CreatorCapsClaimed");
    let (creator_meme, creator_quote) = launch.claim_creator_fees(&pv, &curve_fee_cap, scenario.ctx());
    print_event<CreatorFeesClaimed>(b"event CreatorFeesClaimed");
    let (meme, quote, sui) = launch.claim_protocol_fees_with_partner(
        &pv,
        &blast_acl::witness_for_testing<TreasuryAdmin>(),
        &partner,
        &clock,
        scenario.ctx(),
    );
    print_event<ProtocolFeesClaimed>(b"event ProtocolFeesClaimed");
    label(b"object Launch claimed");
    debug::print(&bcs::to_bytes(&launch));
    destroy(creator_meme);
    destroy(creator_quote);
    destroy(meme);
    destroy(quote);
    destroy(sui);
    destroy(curve_fee_cap);
    destroy(metadata_cap);
    test_scenario::return_shared(launch);

    scenario.next_tx(ADMIN);
    config.remove_partner(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), &partner, &clock);
    print_event<PartnerRemoved>(b"event PartnerRemoved");

    destroy(partner);
    destroy(config);
    destroy(runtime);
    destroy(pv);
    destroy(clock);
    scenario.end();
}

fun label(text: vector<u8>) {
    debug::print(&text.to_string());
}

fun print_event<T: copy + drop>(name: vector<u8>) {
    let events = event::events_by_type<Event<T>>();
    label(name);
    debug::print(&bcs::to_bytes(&events[events.length() - 1].unwrap()));
}

use blast_admin::blast_acl;
use blast_fun::{
    allocation,
    blast_events::Event,
    blast_fun_domain::{AdapterAdmin, FeeAdmin, ListingAdmin, TreasuryAdmin},
    bps,
    creator_authority,
    events::{
        Bought,
        CreationFeeChanged,
        CreatorCapsClaimed,
        CreatorFeesClaimed,
        LaunchCreated,
        LaunchShared,
        LaunchTicketCreated,
        LaunchTradeFeesChanged,
        Migrated,
        MigrationAllocationPaid,
        MigrationWitnessSet,
        OpeningRoundDelivered,
        OpeningRoundJoined,
        OpeningRoundSettled,
        PartnerAdded,
        PartnerRemoved,
        ProtocolAllocationSet,
        ProtocolFeeShareChanged,
        ProtocolFeesAccrued,
        ProtocolFeesClaimed,
        QuoteSet,
        Sold,
    },
    launch::{Self, Launch},
    launch_config::{Self, LaunchConfig},
    launch_ticket,
    package_version,
    runtime_config,
};
use blast_partners::blast_partners;
use std::{bcs, debug, unit_test::destroy};
use sui::{
    clock,
    coin::{Self, Coin},
    coin_registry::Currency,
    event,
    sui::SUI,
    test_scenario,
    test_utils,
};
