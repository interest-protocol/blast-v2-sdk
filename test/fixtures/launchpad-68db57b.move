<<<<<<<< HEAD:test/fixtures/launchpad-68db57b.move
// Fixture generator for test/fixtures/launchpad-68db57b.ts. It is not compiled by the SDK.
// To regenerate: extract contracts commit 68db57b3 with `git archive 68db57b3 sui`, copy this
========
// Fixture generator for test/fixtures/launchpad-7efd934.ts. It is not compiled by the SDK.
// To regenerate: extract contracts commit 7efd9342 with `git archive 7efd9342 sui`, copy this
>>>>>>>> a54a02d (feat(sdk)!: port to sealed treasury caps (contracts #219, ADR 0138) at 7efd9342):test/fixtures/launchpad-7efd934.move
// file to sui/launchpad/tests/ in that copy only, and run `sui move test sdk_fixture_tests` from
// sui/launchpad (sui 1.77.2). Never add it to the contracts repository.
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
const TREASURY: address = @0x7EA5;
const NEW_OWNER: address = @0x0E1;

public struct SDK_FIXTURE_TESTS has drop {}
public struct TEST_QUOTE() has drop;

#[test]
fun print_fixtures() {
    let mut scenario = test_scenario::begin(ADMIN);
    let pv = package_version::version_for_testing(scenario.ctx());
    let mut registry = launch::registry_for_testing(scenario.ctx());
    launch_config::init_for_testing(scenario.ctx());
    let mut runtime = runtime_config::new_zero_fee_share_with_signer_for_testing(
        x"0909090909090909090909090909090909090909090909090909090909090909",
        scenario.ctx(),
    );
    let treasury = blast_treasury::new_for_testing(TREASURY, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1_000);
    let partner = blast_partners::new_for_testing(PARTNER_RECIPIENT, 2_000, scenario.ctx());
    label(b"partner_id");
    debug::print(&bcs::to_bytes(&object::id(&partner)));
    label(b"registry_id");
    debug::print(&bcs::to_bytes(&object::id(&registry)));

    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<LaunchConfig>();
    label(b"config_id");
    debug::print(&bcs::to_bytes(&object::id(&config)));
    config.set_quote_allowed<TEST_QUOTE>(&pv, &blast_acl::witness_for_testing<ListingAdmin>(), true);
    print_event<QuoteAllowed<TEST_QUOTE>>(b"event QuoteAllowed");
    config.set_meme_decimals_allowed(&pv, &blast_acl::witness_for_testing<ListingAdmin>(), 8, true);
    print_event<MemeDecimalsAllowed>(b"event MemeDecimalsAllowed");
    config.set_venue_allowed_for_testing<TestVenue>(
        &pv,
        &blast_acl::witness_for_testing<VenueAdmin>(),
        true,
        scenario.ctx(),
    );
    config.set_trade_fees_for_testing(
        &pv,
        &blast_acl::witness_for_testing<FeeAdmin>(),
        bps::new(100),
        bps::new(250),
        scenario.ctx(),
    );
    config.set_protocol_allocation_for_testing(
        &pv,
        &blast_acl::witness_for_testing<TreasuryAdmin>(),
        bps::new(750),
        bps::new(250),
        scenario.ctx(),
    );
    config.set_protocol_lp_fees_for_testing(
        &pv,
        &blast_acl::witness_for_testing<FeeAdmin>(),
        bps::new(2_000),
        bps::new(1_000),
        scenario.ctx(),
    );
    config.set_creation_fee_for_testing(
        &pv,
        &blast_acl::witness_for_testing<FeeAdmin>(),
        5_000_000_000,
        scenario.ctx(),
    );
    config.add_partner(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), &partner);
    print_event<PartnerAdded>(b"event PartnerAdded");
    runtime.set_protocol_fee_share_for_testing(
        &pv,
        &blast_acl::witness_for_testing<FeeAdmin>(),
        bps::new(3_000),
        scenario.ctx(),
    );
    label(b"object LaunchConfig");
    debug::print(&bcs::to_bytes(&config));
    label(b"object RuntimeConfig");
    debug::print(&bcs::to_bytes(&runtime));

    scenario.next_tx(LAUNCHER);
    let (ticket, sealed_treasury_cap) = launch_ticket::new(
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
    print_event<LaunchTicketCreated<SDK_FIXTURE_TESTS>>(b"event LaunchTicketCreated");
    label(b"object LaunchTicket");
    debug::print(&bcs::to_bytes(&ticket));

    scenario.next_tx(LAUNCHER);
    let mut currency = scenario.take_from_address<Currency<SDK_FIXTURE_TESTS>>(COIN_REGISTRY);
    let mut initializer = launch::new<_, TEST_QUOTE>(
        ticket,
        sealed_treasury_cap,
        &pv,
        &config,
        migration::issue_ticket<_, TEST_QUOTE, _>(migration::test_venue()),
    );
    initializer.set_virtual_quote(&pv, 3_000_000_000_000);
    initializer.set_graduation_target(&pv, 12_345_678_901_237);
    initializer.set_allocation_plan(
        &pv,
        allocation::plan(
            bps::new(7_000),
            bps::new(2_000),
            bps::new(9_500),
            vector[
                allocation::recipient_share(
                    payout::recipient(
                        RECIPIENT,
                        option::some(payout::vesting_terms(1_000, 2_000, 3)),
                    ),
                    bps::new(250),
                    bps::new(250),
                ),
            ],
        ),
    );
    initializer.set_lp_fee_split(
        &pv,
        fee_split::new(vector[
            fee_split::route(fee_split::owner_destination(), bps::new(5_000)),
            fee_split::route(fee_split::auto_lp_destination(), bps::new(2_000)),
            fee_split::route(fee_split::holder_rewards_destination(), bps::new(1_000)),
            fee_split::route(fee_split::burn_destination(), bps::new(1_000)),
            fee_split::route(fee_split::address_destination(ROUTE), bps::new(1_000)),
        ]),
    );
    initializer.set_opening_round(&pv, 60_000);
    initializer.set_partner(&pv, &config, &partner, &clock);
    let creation_fee = coin::mint_for_testing<SUI>(5_000_000_000, scenario.ctx());
    let mut launch = initializer.finalize(&pv, &mut registry, &mut currency, &config, creation_fee);
    test_scenario::return_to_address(COIN_REGISTRY, currency);
    print_event<LaunchCreated<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event LaunchCreated");
    label(b"launch_id");
    debug::print(&bcs::to_bytes(&object::id(&launch)));
    label(b"object Launch finalized");
    debug::print(&bcs::to_bytes(&launch));

    let quote = coin::mint_for_testing<TEST_QUOTE>(1_000_000_000, scenario.ctx());
    launch.join_opening_round(&pv, quote, &clock, scenario.ctx());
    print_event<OpeningRoundJoined<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event OpeningRoundJoined creator");
    launch.share(&pv, &clock);
    print_event<LaunchShared<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event LaunchShared");

    scenario.next_tx(ALICE);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let quote = coin::mint_for_testing<TEST_QUOTE>(2_000_000_000, scenario.ctx());
    launch.join_opening_round(&pv, quote, &clock, scenario.ctx());
    print_event<OpeningRoundJoined<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event OpeningRoundJoined alice");
    label(b"object Launch opening round");
    debug::print(&bcs::to_bytes(&launch));
    test_scenario::return_shared(launch);

    clock.set_for_testing(61_000);
    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    launch.settle_opening_round(&pv, &runtime, &clock);
    print_event<Bought<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event Bought settlement");
    print_event<OpeningRoundSettled<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event OpeningRoundSettled");
    label(b"object Launch settled");
    debug::print(&bcs::to_bytes(&launch));
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    launch.deliver_opening_round(&pv, ALICE, scenario.ctx());
    print_event<OpeningRoundDelivered<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event OpeningRoundDelivered");
    test_scenario::return_shared(launch);

    scenario.next_tx(ALICE);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let mut meme = scenario.take_from_address<Coin<SDK_FIXTURE_TESTS>>(ALICE);
    let half = meme.value() / 2;
    let sold = meme.split(half, scenario.ctx());
    let quote_out = launch.sell(&pv, &runtime, sold, 1, scenario.ctx());
    print_event<Sold<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event Sold");
    transfer::public_transfer(quote_out, ALICE);
    transfer::public_transfer(meme, ALICE);
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let quote = coin::mint_for_testing<TEST_QUOTE>(20_000_000_000_000, scenario.ctx());
    let (meme_out, refund) = launch.buy(&pv, &runtime, quote, 1, scenario.ctx());
    print_event<Bought<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event Bought graduation");
    label(b"object Launch migration ready");
    debug::print(&bcs::to_bytes(&launch));
    transfer::public_transfer(meme_out, BOB);
    transfer::public_transfer(refund, BOB);
    test_scenario::return_shared(launch);

    scenario.next_tx(BOB);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let mut currency = scenario.take_from_address<Currency<SDK_FIXTURE_TESTS>>(COIN_REGISTRY);
    let migration = launch.migrate(&pv, &config, &mut currency, &clock, scenario.ctx());
    print_event<MigrationAllocationPaid<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event MigrationAllocationPaid");
    print_event<ProtocolFeesAccrued<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event ProtocolFeesAccrued");
    print_event<Migrated<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event Migrated");
    label(b"migration terms");
    debug::print(&bcs::to_bytes(migration.terms()));
    let (meme, quote, _) = migration.redeem(migration::test_venue());
    label(b"object Launch migrated");
    debug::print(&bcs::to_bytes(&launch));
    destroy(meme);
    destroy(quote);
    test_scenario::return_to_address(COIN_REGISTRY, currency);
    test_scenario::return_shared(launch);

    scenario.next_tx(CREATOR);
    let mut launch = scenario.take_shared<Launch<SDK_FIXTURE_TESTS, TEST_QUOTE>>();
    let (curve_fee_cap, creator_metadata_cap) = launch.claim_creator_caps(
        &pv,
        &runtime,
        option::none(),
        &clock,
        scenario.ctx(),
    );
    print_event<CreatorCapsClaimed<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event CreatorCapsClaimed");
    let (creator_meme, creator_quote) = launch.claim_creator_fees(&pv, &curve_fee_cap, scenario.ctx());
    print_event<CreatorFeesClaimed<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event CreatorFeesClaimed");
    launch.claim_protocol_fees_with_partner(&pv, &treasury, &partner, scenario.ctx());
    print_event<ProtocolFeesPaid<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event ProtocolFeesPaid");
    let mut currency = scenario.take_from_address<Currency<SDK_FIXTURE_TESTS>>(COIN_REGISTRY);
    launch.set_name(&pv, &creator_metadata_cap, &mut currency, b"SDK Renamed".to_string());
    print_event<MemeMetadataUpdated<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event MemeMetadataUpdated");
    test_scenario::return_to_address(COIN_REGISTRY, currency);
    label(b"object Launch claimed");
    debug::print(&bcs::to_bytes(&launch));
    launch.reassign_curve_fee_cap_for_testing(
        &pv,
        &blast_acl::witness_for_testing<CreatorAdmin>(),
        NEW_OWNER,
        scenario.ctx(),
    );
    print_event<CurveFeeCapReassigned<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event CurveFeeCapReassigned");
    launch.reassign_creator_metadata_cap_for_testing(
        &pv,
        &blast_acl::witness_for_testing<CreatorAdmin>(),
        NEW_OWNER,
        scenario.ctx(),
    );
    print_event<CreatorMetadataCapReassigned<SDK_FIXTURE_TESTS, TEST_QUOTE>>(b"event CreatorMetadataCapReassigned");
    destroy(creator_meme);
    destroy(creator_quote);
    destroy(curve_fee_cap);
    destroy(creator_metadata_cap);
    test_scenario::return_shared(launch);

    scenario.next_tx(ADMIN);
    config.remove_partner(&pv, &blast_acl::witness_for_testing<FeeAdmin>(), &partner, &clock);
    print_event<PartnerRemoved>(b"event PartnerRemoved");

    destroy(partner);
    destroy(config);
    destroy(runtime);
    destroy(registry);
    destroy(treasury);
    destroy(pv);
    destroy(clock);
    scenario.end();
}

fun label(text: vector<u8>) {
    debug::print(&text.to_string());
}

fun print_event<T: copy + drop>(name: vector<u8>) {
    let events = event::events_by_type<T>();
    label(name);
    debug::print(&bcs::to_bytes(&events[events.length() - 1]));
}

use blast_admin::blast_acl;
use blast_core::{
    blast_core_events::ProtocolFeesPaid,
    blast_domain::{CreatorAdmin, FeeAdmin, ListingAdmin, TreasuryAdmin, VenueAdmin},
    blast_treasury,
    bps,
    fee_split,
    migration::{Self, TestVenue},
    payout,
};
use blast_fun::{
    allocation,
    blast_fun as package_version,
    creator_authority,
    events::{
        Bought,
        CreatorCapsClaimed,
        CreatorFeesClaimed,
        CreatorMetadataCapReassigned,
        CurveFeeCapReassigned,
        LaunchCreated,
        LaunchShared,
        LaunchTicketCreated,
        MemeDecimalsAllowed,
        MemeMetadataUpdated,
        Migrated,
        MigrationAllocationPaid,
        OpeningRoundDelivered,
        OpeningRoundJoined,
        OpeningRoundSettled,
        ProtocolFeesAccrued,
        QuoteAllowed,
        Sold,
    },
    launch::{Self, Launch},
    launch_config::LaunchConfig,
    launch_ticket,
    launch_config,
    runtime_config,
};
use blast_partners::{blast_partners, partner_list::{PartnerAdded, PartnerRemoved}};
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
