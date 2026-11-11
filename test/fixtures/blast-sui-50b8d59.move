// Fixture generator for test/fixtures/blast-sui-50b8d59.ts. It is not compiled by the SDK and is
// never added to the contracts repository. It runs against the real `blast_sui` package at
// contracts 50b8d59a and reuses the private helpers of its `tests/validators_tests.move`. To
// regenerate: extract `git archive 50b8d59a sui` to a scratch directory, append everything below
// the `---` line to `sui/defi/blast_sui/tests/validators_tests.move`, and run
// `sui move test print_sdk_fixture` in `sui/defi/blast_sui/` (sui 1.77.2). Each `[debug]` label
// precedes its value.
// ---

#[test]
fun print_sdk_fixture() {
    // Three genesis validators; pools 0 and 1 listed.
    let mut fixture = sdk_start(3);
    let pools = vector[fixture.pool_of(0), fixture.pool_of(1), fixture.pool_of(2)];
    sdk_label(b"pools");
    std::debug::print(&pools);
    fixture.schedule(pools[1]);
    fixture.apply(pools[1]);
    sdk_print_event<events::VaultSynced>(b"vault_synced");

    fixture.mint(pools[1], 2 * MIST_PER_SUI);
    sdk_print_event<events::FunSuiMinted>(b"fun_sui_minted");

    fixture.request(pools[0], 3 * MIST_PER_SUI);
    sdk_print_event<events::BlastSuiDepositRequested>(b"deposit_requested");
    fixture.next_tx!(USER, |f| {
        let receipt = f.runner.scenario_mut().take_from_sender<BlastSuiDepositReceipt>();
        sdk_label(b"receipt");
        std::debug::print(&object::id(&receipt));
        std::debug::print(&bcs::to_bytes(&receipt));
        f.runner.scenario_mut().return_to_sender(receipt);
    });

    fixture.next_tx!(USER, |f| {
        let sui_in = coin::mint_for_testing(500_000_000, f.ctx!());
        f.vault!().top_up_fun_reserve(&f.version, sui_in);
    });
    sdk_print_event<events::FunReserveToppedUp>(b"fun_reserve_topped_up");

    fixture.donate(MIST_PER_SUI);
    sdk_print_event<events::BlastSuiDonated>(b"blast_sui_donated");

    fixture.advance_epoch();
    fixture.claim(0);
    sdk_print_event<events::BlastSuiDepositClaimed>(b"deposit_claimed");

    fixture.advance_epoch_with_rewards(4 * MIST_PER_SUI);
    fixture.sync();
    sdk_print_event<events::FunYieldSwept>(b"fun_yield_swept");

    fixture.redeem_fun(MIST_PER_SUI);
    sdk_print_event<events::FunSuiRedeemed>(b"fun_sui_redeemed");

    fixture.redeem_blast(MIST_PER_SUI);
    sdk_print_event<events::BlastSuiRedeemed>(b"blast_sui_redeemed");

    fixture.request(pools[1], 2 * MIST_PER_SUI);
    fixture.next_tx!(USER, |f| {
        let receipt = f.runner.scenario_mut().take_from_sender<BlastSuiDepositReceipt>();
        let sui_out = receipt.cancel(f.system!(), f.ctx!());
        transfer::public_transfer(sui_out, USER);
    });
    sdk_print_event<events::BlastSuiDepositCancelled>(b"deposit_cancelled");

    fixture.remove(pools[1]);
    sdk_print_event<events::PoolUnwound>(b"pool_unwound");

    // Final vault: pool 0 listed, pool 2 pending, a pending fee, a pending validator delay.
    fixture.next_tx!(OWNER, |f| {
        let mut clock = clock::create_for_testing(f.ctx!());
        clock.set_for_testing(1_000);
        f.vault!().schedule_validator(&f.version, &validator_admin(), pools[2], &clock);
        let fee_admin = blast_acl::witness_for_testing<FeeAdmin>();
        f.vault!().schedule_redeem_fee(&f.version, &fee_admin, 7, DELAY_MS, &clock);
        f.vault!().schedule_validator_delay(&f.version, &validator_admin(), DELAY_MS, &clock);
        clock.destroy_for_testing();
        sdk_label(b"vault");
        std::debug::print(&object::id(f.vault!()));
        std::debug::print(&bcs::to_bytes(f.vault!()));
    });

    fixture.end();
}

/// `start_from` over `validators` genesis validators with only the first listed, printing its
/// `VaultCreated`.
fun sdk_start(validators: u64): Fixture {
    let builders = vector::tabulate!(validators, |_| {
        validator_builder::new().initial_stake(100)
    });
    let mut runner = test_runner::new().validators(builders).build();
    runner.scenario_mut().create_system_objects();
    runner.advance_runner_epoch();
    let version = blast_sui_package::version_for_testing(runner.ctx());
    let first = runner.genesis_validator_addresses()[0];

    runner.set_sender(OWNER);
    let mut system_state = runner.scenario_mut().take_shared<SuiSystemState>();
    let pool_id = system_state.validator_staking_pool_id(first);
    let (fun_cap, fun_metadata_cap) = fun_sui::new_for_testing(runner.ctx());
    let (blast_cap, blast_metadata_cap) = blast_coin::new_for_testing(runner.ctx());
    let mut display_registry = runner.scenario_mut().take_shared<DisplayRegistry>();
    let clock = clock::create_for_testing(runner.ctx());
    let seed = coin::mint_for_testing(
        BOOTSTRAP + constants::fun_rounding_reserve_mist!(),
        runner.ctx(),
    );
    vault::create(
        &version,
        &mut system_state,
        &mut display_registry,
        fun_cap,
        blast_cap,
        fun_metadata_cap,
        blast_metadata_cap,
        seed,
        pool_id,
        &clock,
        runner.ctx(),
    );
    sdk_print_event<events::VaultCreated>(b"vault_created");
    clock.destroy_for_testing();
    test_scenario::return_shared(display_registry);
    test_scenario::return_shared(system_state);
    runner.set_sender(OWNER);

    Fixture { runner, version, vault: option::none(), system_state: option::none() }
}

fun sdk_print_event<T: copy + drop>(name: vector<u8>) {
    let emitted = events::collect<T>();
    assert!(emitted.length() == 1);
    sdk_label(name);
    std::debug::print(&bcs::to_bytes(&emitted[0]));
}

fun sdk_label(text: vector<u8>) {
    std::debug::print(&text.to_ascii_string());
}

use blast_sui::blast_sui_domain::FeeAdmin;
use sui::bcs;
