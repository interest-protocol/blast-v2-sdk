// Fixture generator for the literal vectors in test/core-bps.test.ts, test/core-fee-split.test.ts
// and test/core-payout.test.ts. It is not compiled by the SDK. To regenerate: extract contracts
// commit 4fe8d739 with `git archive 4fe8d739 sui/admin sui/partners sui/vesting sui/core`, copy
// this file to sui/core/tests/ in that copy only, and run `sui move test sdk_vectors` from
// sui/core (sui 1.77.2). Never add it to the contracts repository.
#[test_only]
module blast_core::sdk_vectors;

use blast_core::{bps, fee_split, merkle, migration, payout};
use std::{debug, string::String};
use sui::{bcs, hex};

fun label(text: vector<u8>) { debug::print(&text.to_string()); }

fun print_hex(bytes: vector<u8>) {
    let s: String = hex::encode(bytes).to_string();
    debug::print(&s);
}

fun rates(values: vector<u64>): vector<bps::Bps> { values.map!(|v| bps::new(v)) }

#[test]
fun print_vectors() {
    label(b"apportion [3333,3333,3334] 100 none");
    debug::print(&bps::apportion(rates(vector[3333, 3333, 3334]), 100, option::none()));
    label(b"apportion [5000,5000] 7 some(1)");
    debug::print(&bps::apportion(rates(vector[5000, 5000]), 7, option::some(1)));
    label(b"apportion [1,9999] 1 none");
    debug::print(&bps::apportion(rates(vector[1, 9999]), 1, option::none()));
    label(b"apportion [2500x4] 3 some(3)");
    debug::print(&bps::apportion(rates(vector[2500, 2500, 2500, 2500]), 3, option::some(3)));
    label(b"apportion [7000,2000,1000] 999999 some(0)");
    debug::print(&bps::apportion(rates(vector[7000, 2000, 1000]), 999_999, option::some(0)));
    label(b"apportion [1234,4321,4445] 18446744073709551615 some(2)");
    debug::print(&bps::apportion(rates(vector[1234, 4321, 4445]), 18446744073709551615, option::some(2)));
    label(b"apply_up 1 1, 10000 3333, 7 5000, 0 9999, 3 10000");
    debug::print(&bps::new(1).apply_up(1));
    debug::print(&bps::new(3333).apply_up(10000));
    debug::print(&bps::new(5000).apply_up(7));
    debug::print(&bps::new(9999).apply_up(0));
    debug::print(&bps::new(10000).apply_up(3));

    let split = fee_split::new(vector[
        fee_split::route(fee_split::address_destination(@0xf00d), bps::new(1000)),
        fee_split::route(fee_split::owner_destination(), bps::new(4000)),
        fee_split::route(fee_split::auto_lp_destination(), bps::new(2000)),
        fee_split::route(fee_split::holder_rewards_destination(), bps::new(2000)),
        fee_split::route(fee_split::burn_destination(), bps::new(1000)),
    ]);
    label(b"fee_split bcs");
    print_hex(bcs::to_bytes(&split));
    label(b"fee_split apportion 12345");
    debug::print(&split.apportion(12345));

    label(b"recipient vesting bcs");
    print_hex(bcs::to_bytes(&payout::recipient(@0xbeef, option::some(payout::vesting_terms(10, 20, 3)))));
    label(b"recipient outright bcs");
    print_hex(bcs::to_bytes(&payout::recipient(@0xbeef, option::none())));

    let terms = migration::vault_terms(
        migration::test_issuer(),
        object::id_from_address(@0xb0001),
        split,
        bps::new(1500),
        bps::new(3000),
        option::some(object::id_from_address(@0xa11)),
        migration::residuals_to_owner(),
    );
    label(b"vault_terms bcs");
    print_hex(bcs::to_bytes(&terms));

    label(b"sqrt_price_x64 (1000,4000,true) (4000,1000,true) (1000,4000,false) (1,18446744073709551615,true)");
    debug::print(&migration::sqrt_price_x64(1000, 4000, true));
    debug::print(&migration::sqrt_price_x64(4000, 1000, true));
    debug::print(&migration::sqrt_price_x64(1000, 4000, false));
    debug::print(&migration::sqrt_price_x64(1, 18446744073709551615, true));
    label(b"is_seedable 8590096031 8590096032 39613336757700639996223789527 39613336757700639996223789528");
    debug::print(&migration::is_seedable_price(8590096031));
    debug::print(&migration::is_seedable_price(8590096032));
    debug::print(&migration::is_seedable_price(39613336757700639996223789527));
    debug::print(&migration::is_seedable_price(39613336757700639996223789528));

    label(b"merkle leaf blast-holder-rewards-v2 0102");
    print_hex(merkle::leaf(b"blast-holder-rewards-v2", x"0102"));
}
