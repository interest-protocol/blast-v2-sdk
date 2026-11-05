// Fixture generator for test/fixtures/derived-ids.ts. It is not compiled by the SDK.
// The key declarations are copied verbatim from contracts 4fe8d739 (`launch::LaunchKey`,
// `blast_presale::PresaleKey`, `vault::VaultKey`, and the two products' `PackageWitness`) at
// fixed, distinct package addresses, so the derived IDs exercise nonzero original IDs. To
// regenerate: write this file to `sources/derived_ids.move` and the manifest below to
// `Move.toml` in an empty scratch directory, then run `sui move test` there (sui 1.77.2).
// Never add it to the contracts repository.
//
// [package]
// name = "sdk_derived_ids"
// edition = "2024"
//
// [dependencies]
// Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "06734f6ff0af45d8632a14a4dc4b100197f6b1a2" }
//
// [addresses]
// sdk_derived_ids = "0x0"
// blast_fun = "0x0b1a5f00000000000000000000000000000000000000000000000000000000f1"
// blast_presale = "0x0b1a5f00000000000000000000000000000000000000000000000000000000f2"
// blast_vault = "0x0b1a5f00000000000000000000000000000000000000000000000000000000f3"
// fixture_coin = "0x00000000000000000000000000000000000000000000000000000000000c0123"
module blast_fun::launch {
    public struct LaunchKey<phantom Meme>() has copy, drop, store;

    public fun key<Meme>(): LaunchKey<Meme> { LaunchKey() }
}

module blast_fun::blast_fun {
    public struct PackageWitness() has drop;
}

module blast_presale::blast_presale {
    public struct PresaleKey<phantom SaleToken>() has copy, drop, store;

    public fun key<SaleToken>(): PresaleKey<SaleToken> { PresaleKey() }
}

module blast_presale::blast_presale_package {
    public struct PackageWitness() has drop;
}

module blast_vault::vault {
    use std::type_name::TypeName;

    public struct VaultKey has copy, drop, store {
        package_witness: TypeName,
        origin: ID,
    }

    public fun key(package_witness: TypeName, origin: ID): VaultKey {
        VaultKey { package_witness, origin }
    }
}

module fixture_coin::meme {
    public struct MEME has drop {}
}

#[test_only]
module sdk_derived_ids::derived_ids_tests {
    use std::{debug, type_name};
    use sui::derived_object;

    const LAUNCH_REGISTRY: address = @0x00000000000000000000000000000000000000000000000000000000000a0001;
    const PRESALE_REGISTRY: address = @0x00000000000000000000000000000000000000000000000000000000000a0002;
    const VAULT_REGISTRY: address = @0x00000000000000000000000000000000000000000000000000000000000a0003;
    const LAUNCH_ID: address = @0x00000000000000000000000000000000000000000000000000000000000b0001;
    const PRESALE_ID: address = @0x00000000000000000000000000000000000000000000000000000000000b0002;

    #[test]
    fun print_derived_ids() {
        debug::print(&b"launch".to_string());
        debug::print(&derived_object::derive_address(
            object::id_from_address(LAUNCH_REGISTRY),
            blast_fun::launch::key<fixture_coin::meme::MEME>(),
        ));
        debug::print(&b"presale".to_string());
        debug::print(&derived_object::derive_address(
            object::id_from_address(PRESALE_REGISTRY),
            blast_presale::blast_presale::key<fixture_coin::meme::MEME>(),
        ));
        let launch_witness = type_name::with_original_ids<blast_fun::blast_fun::PackageWitness>();
        debug::print(&launch_witness);
        debug::print(&b"launch vault".to_string());
        debug::print(&derived_object::derive_address(
            object::id_from_address(VAULT_REGISTRY),
            blast_vault::vault::key(launch_witness, object::id_from_address(LAUNCH_ID)),
        ));
        let presale_witness = type_name::with_original_ids<
            blast_presale::blast_presale_package::PackageWitness,
        >();
        debug::print(&presale_witness);
        debug::print(&b"presale vault".to_string());
        debug::print(&derived_object::derive_address(
            object::id_from_address(VAULT_REGISTRY),
            blast_vault::vault::key(presale_witness, object::id_from_address(PRESALE_ID)),
        ));
    }
}
