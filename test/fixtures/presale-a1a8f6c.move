// Fixture generator for test/fixtures/presale-a1a8f6c.ts. It is not compiled by the SDK. The two
// test functions below reuse the private fixtures of the contracts' own presale and vendor tests,
// so they are appended to copies of those files. To regenerate: extract contracts commit a1a8f6c9
// with `git archive a1a8f6c9 sui/admin sui/partners sui/vesting sui/core sui/presale
// sui/vendors/aftermath_dao_presale`, append the PRESALE block to
// sui/presale/tests/blast_presale_tests.move and the VENDOR block to
// sui/vendors/aftermath_dao_presale/tests/blast_aftermath_dao_presale_tests.move in that copy
// only, then run `sui move test sdk_print` in each package (sui 1.77.2). Each printed pair is a
// label then the lowercase hex BCS. Never add this to the contracts repository.

// ==== PRESALE (append to blast_presale_tests.move) ====

fun sdk_hex(label: vector<u8>, bytes: vector<u8>) {
    std::debug::print(&label.to_string());
    std::debug::print(&sui::hex::encode(bytes).to_string());
}

fun sdk_events<E: copy + drop>(label: vector<u8>) {
    event::events_by_type<E>().do!(|e| sdk_hex(label, std::bcs::to_bytes(&e)));
}

fun sdk_print_presale(self: &mut Fixture, label: vector<u8>) {
    self.next_tx!(KEEPER, |fixture| {
        let sale = fixture.take_presale();
        sdk_hex(label, std::bcs::to_bytes(&sale));
        fixture.return_presale(sale);
    });
}

#[test]
/// A partnered sale through creation, commitments, settlement, migration, its partner payout
/// and a claim.
fun sdk_print_partnered_sale() {
    let mut ctx = tx_context::dummy();
    let partner = new_partner(PARTNER_CUT_BPS, &mut ctx);
    let mut fixture = partner.share_partnered_sale(COMMITMENT_STARTS_AT_MS, PROTOCOL_RAISE_BPS);
    sdk_hex(b"presale id", object::id_to_bytes(&fixture.presale_id));
    sdk_hex(b"partner id", object::id_to_bytes(&object::id(&partner)));
    sdk_hex(b"venue", type_name::with_original_ids<TEST_VENUE>().into_string().into_bytes());
    sdk_events<PresaleCreated<BLAST_PRESALE_TESTS, QUOTE>>(b"PresaleCreated");
    sdk_events<PresaleOpened<BLAST_PRESALE_TESTS, QUOTE>>(b"PresaleOpened");
    fixture.sdk_print_presale(b"presale open");

    fixture.set_time(COMMITMENT_STARTS_AT_MS);
    fixture.commit_open(ALICE, 1_000);
    sdk_events<Committed<BLAST_PRESALE_TESTS, QUOTE>>(b"Committed");
    fixture.commit_open(BOB, 3_000);
    fixture.set_time(COMMITMENT_ENDS_AT_MS);
    fixture.settle(KEEPER);
    sdk_events<PresaleFunded<BLAST_PRESALE_TESTS, QUOTE>>(b"PresaleFunded");
    fixture.sdk_print_presale(b"presale funded");

    let (_, terms) = fixture.migrate_with_terms();
    sdk_events<RaiseAllocated<BLAST_PRESALE_TESTS, QUOTE>>(b"RaiseAllocated");
    sdk_events<RecipientAllocated<BLAST_PRESALE_TESTS, QUOTE>>(b"RecipientAllocated");
    sdk_events<PresaleMigrated<BLAST_PRESALE_TESTS, QUOTE>>(b"PresaleMigrated");
    sdk_hex(b"vault terms", std::bcs::to_bytes(&terms));
    fixture.sdk_print_presale(b"presale migrated");

    fixture.pay_protocol_fees_with_partner(KEEPER, &partner);
    sdk_events<ProtocolFeesPaid<BLAST_PRESALE_TESTS, QUOTE>>(b"ProtocolFeesPaid");
    fixture.claim(KEEPER, ALICE);
    sdk_events<Claimed<BLAST_PRESALE_TESTS, QUOTE>>(b"Claimed");

    destroy(partner);
    fixture.destroy_migrated_cap();
    fixture.end();
}

#[test]
/// A sale whose rates the FeeAdmin lowers before its start, then underfunded and cancelled.
fun sdk_print_rates_and_cancellation() {
    let mut fixture = schedule_with_creation_rates(
        vector[outright_share(RAISE_RECIPIENT, 2_000)],
        PROTOCOL_RAISE_BPS,
        PROTOCOL_TOKEN_BPS,
        FEE_PAYING_RECIPIENT_B_BPS,
        vector[1_000, PROTOCOL_TOKEN_BPS, 200, 300],
    );
    fixture.set_protocol_fees(vector[500, 250, 100, 200]);
    sdk_events<ProtocolFeesChanged<BLAST_PRESALE_TESTS, QUOTE>>(b"ProtocolFeesChanged");

    fixture.set_time(COMMITMENT_STARTS_AT_MS);
    fixture.commit_open(ALICE, 500);
    fixture.set_time(COMMITMENT_ENDS_AT_MS);
    fixture.settle(KEEPER);
    sdk_events<PresaleCancelled<BLAST_PRESALE_TESTS, QUOTE>>(b"PresaleCancelled");
    fixture.sdk_print_presale(b"presale cancelled");

    fixture.claim(KEEPER, ALICE);
    fixture.destroy_cancelled_cap();
    fixture.end();
}

// ==== VENDOR (append to blast_aftermath_dao_presale_tests.move) ====

fun sdk_hex(label: vector<u8>, bytes: vector<u8>) {
    std::debug::print(&label.to_string());
    std::debug::print(&sui::hex::encode(bytes).to_string());
}

#[test]
/// `prepare`'s reservation event and shared `PoolCreation`.
fun sdk_print_pool_creation() {
    let mut scenario = publish();
    scenario.prepare().redeem_ticket();
    let reserved = event::events_by_type<PoolCreationReserved<LP, SALE, QUOTE>>();
    sdk_hex(b"PoolCreationReserved", std::bcs::to_bytes(&reserved[0]));
    scenario.next_tx(KEEPER);
    let pool_creation = scenario.take_shared<PoolCreation<LP, SALE>>();
    sdk_hex(b"pool creation id", object::id(&pool_creation).to_bytes());
    sdk_hex(b"PoolCreation", std::bcs::to_bytes(&pool_creation));
    test_scenario::return_shared(pool_creation);
    scenario.end();
}
