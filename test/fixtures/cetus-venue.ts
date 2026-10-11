/**
 * Literal Cetus CLMM fixtures for the migrated-venue adapter. Nothing here is
 * computed by the SDK: every byte string was copied from a reviewed source.
 *
 * - `MAINNET_CETUS_SWAPS`: blast-infra `tests/venues/sample.json` at 48bd479
 *   (fetched from Sui mainnet GraphQL by `tests/venues/fetch.py`, reviewed in
 *   blast-infra T-012). `bcs` is the event's BCS and `json` is GraphQL's own
 *   rendering of the same event, an independent decoding.
 * - `BLAST_CETUS`: blast-infra `tests/fixtures/venues` at 48bd479, which runs the
 *   launchpad and migrators (contracts a2a1db2) against forked mainnet Cetus
 *   CLMM v15 bytecode in Sui's simulator. Its `manifest.json` records the
 *   launch, vault, pool, tier, liquidity, digests, senders, and swap inputs;
 *   the pool object and the two `SwapEvent`s are byte ranges of checkpoints
 *   22, 23, and 24 (`<n>.binpb.zst`). `checks` lists the manifest facts each
 *   byte string was cross-checked against when it was copied.
 * - `CETUS_LINEAGE` and the `GlobalConfig` identity: contracts 442116a,
 *   `sui/migrators/interfaces/cetus/Move.toml` (`published-at`, original
 *   address) and `sui/launchpad/ptb_tests/fork/snapshot` (the config object
 *   and its initial shared version, from its object BCS).
 */

export const CETUS_LINEAGE = {
  originalPackageId:
    "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
  /** Cetus CLMM revision 15, the one the migrators link. */
  packageId:
    "0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084",
  globalConfig: {
    objectId:
      "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
    initialSharedVersion: "1574190",
  },
} as const;

/** Mainnet swaps: a buy and a sell in SUIMAN/SUI, and a swap with a partner referral. */
export const MAINNET_CETUS_SWAPS = [
  {
    checkpoint: "327375304",
    transactionDigest: "3DMw2pd63RaysZcHVVPotVjXBaXvfcBTuHVkwwb1QVxx",
    eventIndex: 0,
    eventType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent",
    poolType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<0x8e7ccc5e4a39aabdbb6c199327cfc7f5c09675ef23c6e945937b6115dabd24f3::suiman::SUIMAN,0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>",
    bcs: "0034d926a1babf3a92e063240219c77b4ebf4c337df0eb4b2dda061cf7dd76135000000000000000000000000000000000000000000000000000000000000000002964d65503000000007b2b2e155404000000000000000000b6db1500000000009cc8fee879b7260c4164ba6b590900008218ae5c5f8de0000000000000000000a3cdeccd79dde00000000000000000000100000000000000",
    json: {
      atob: false,
      pool: "0x34d926a1babf3a92e063240219c77b4ebf4c337df0eb4b2dda061cf7dd761350",
      partner:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      amount_in: "14325015593",
      amount_out: "1218349852490496",
      ref_amount: "0",
      fee_amount: "1432502",
      vault_a_amount: "875588911798077596",
      vault_b_amount: "10279664116801",
      before_sqrt_price: "63205835499509890",
      after_sqrt_price: "63293909998816675",
      steps: "1",
    },
  },
  {
    checkpoint: "327375415",
    transactionDigest: "8VGeGGkK63FemfNYTgbrJ6eRQXwWdw55Z2WyHnziYyDa",
    eventIndex: 0,
    eventType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent",
    poolType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<0x8e7ccc5e4a39aabdbb6c199327cfc7f5c09675ef23c6e945937b6115dabd24f3::suiman::SUIMAN,0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>",
    bcs: "0134d926a1babf3a92e063240219c77b4ebf4c337df0eb4b2dda061cf7dd7613500000000000000000000000000000000000000000000000000000000000000000c791b44f6a870500b21599450400000000000000000000003cc9103c24000000fb4547518a4a1d0cbdc814b2600900001f94fd1e173ce1000000000000000000096396c57bd5e00000000000000000000100000000000000",
    json: {
      atob: true,
      pool: "0x34d926a1babf3a92e063240219c77b4ebf4c337df0eb4b2dda061cf7dd761350",
      partner:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      amount_in: "1556265557070279",
      amount_out: "18347529650",
      ref_amount: "0",
      fee_amount: "155626555708",
      vault_a_amount: "872935860709311995",
      vault_b_amount: "10310909216957",
      before_sqrt_price: "63397939761746975",
      after_sqrt_price: "63285122355847945",
      steps: "1",
    },
  },
  {
    checkpoint: "327375323",
    transactionDigest: "DP97FukYy6b93t1FxhGny8dEKwaiy51CZzbsU9ucjLDB",
    eventIndex: 0,
    eventType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent",
    poolType:
      "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<0xffb128761d38b08dd0403af2a6721c9cb7481fd312ce723d5fc0a517d0d3023a::yy::YY,0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>",
    bcs: "003227fe6ef46d38c05896a65e8365d5812d03b198a51b323ddd4ec138176614426e86a2bef3784258ed319beb674751bec0cf1ccd486af4e347fd9c9340ab12aa00a24a0400000000ae495c0e00000000803202000000000000f22b00000000006749e3793000000064e323d00b000000c92ede0de0e30a890000000000000000ca86df4dbaf6318900000000000000000100000000000000",
    json: {
      atob: false,
      pool: "0x3227fe6ef46d38c05896a65e8365d5812d03b198a51b323ddd4ec13817661442",
      partner:
        "0x6e86a2bef3784258ed319beb674751bec0cf1ccd486af4e347fd9c9340ab12aa",
      amount_in: "72000000",
      amount_out: "240929198",
      ref_amount: "144000",
      fee_amount: "2880000",
      vault_a_amount: "208203368807",
      vault_b_amount: "50736653156",
      before_sqrt_price: "9874955684408078025",
      after_sqrt_price: "9885953937085793994",
      steps: "1",
    },
  },
] as const;

/** The blast-infra venue fixture's Cetus launch (coin "c"): Meme is coin B, Quote is USDC. */
export const BLAST_CETUS = {
  memeType:
    "0x6a2e1f1f579612328fd1519f19ab99f426bda2c42262340dc68892466a445361::meme::MEME",
  quoteType:
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  launchId:
    "0x5fa358bfe3e17fd50d63fd4cdbb7feb9f16dcb4a362f57acc8b012baa98113bf",
  /** The simulator's `blast_fun_migrators` package. */
  migratorsPackageId:
    "0x49abf9d4b9adf6b8b2afa5df04d3fa450f152e05bd8b32257d1baf57a273f1b2",
  vaultId: "0xd545acaf45ef4494e2ce43b75202709eead811bc4f38d3a977c86b9563382c23",
  tickSpacing: 200,
  migrationDigest: "AXZR1nGNQWHPcfrEiFSeR6Lq7cRkSG7tsUrTTn8owx1H",
  /** The pool as migration (checkpoint 22) left it. */
  pool: {
    objectId:
      "0x381bbabbda5683069531d9a8354c4418cd4aa924c712f86d3c29005395955706",
    type: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x6a2e1f1f579612328fd1519f19ab99f426bda2c42262340dc68892466a445361::meme::MEME>",
    initialSharedVersion: "1016519798",
    content:
      "381bbabbda5683069531d9a8354c4418cd4aa924c712f86d3c2900539595570631805301000000000000534bfe03a302c8000000102700000000000047036db8de010000000000000000000039830e0ae7850879f868010000000000527d0300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c80000003867026a445a5030ec136d5e08e9e45db6834cdccc2c141b6c8be9daf79f90000200240000000000000000c4890d000000000000c4890d000000000002000000000000001000000000000000020000000000000002000000000000001edcdb1c6cfe00400000000000000000000000000000000000000000000000000000000000000000007f63b66a00000000c8000000010000000000000045c24e8df922afbd28064ce2d52d5a9b4696da0ea905bd2102aa50ffe97b438801fc9c729a1860d6f4d3958a716bd3ada04001f0e693b4321d840fb8e53ee5420701fc9c729a1860d6f4d3958a716bd3ada04001f0e693b4321d840fb8e53ee5420701000000000000000058ad0000000000007468747470733a2f2f627137626b76646a65376776676d763636687278647937777835683567677472726e6d74363672646b6b656862363472767a33712e617277656176652e6e65742f4444345656476b6e7a564d797676486a6365503276305f54476e474c5754393649314b4963507552726e63",
    checks: { tickSpacing: 200, liquidity: "2056088519495" },
  },
  /** Step 37: w1 buys through `pool::flash_swap` (a2b, by amount in, 500000). */
  buy: {
    checkpoint: "23",
    transactionDigest: "5k33Q4EUqK1job8VbtKThLzKj68EoUepNjm9kXXg1qNs",
    sender:
      "0xfa9cbb9ac8d8b1d912be45fc4aac964488f4ac3c5a19553ab226d8c448d92634",
    eventIndex: 0,
    bcs: "01381bbabbda5683069531d9a8354c4418cd4aa924c712f86d3c29005395955706000000000000000000000000000000000000000000000000000000000000000020a1070000000000d2f452d3bcb00e000000000000000000881300000000000031805301000000000000534bfe03a30239830e0ae7850879f868010000000000334c8daea6a588621d610100000000000100000000000000",
    checks: { atob: true, amountIn: "500000" },
  },
  /** Step 38: w2 sells through `pool::flash_swap` (b2a, by amount in). */
  sell: {
    checkpoint: "24",
    transactionDigest: "7PFrpxq5miWGiBfZstjAa85KGNP4cPzMnnJcaY71ESXf",
    sender:
      "0x9f33a6fc03a9dca7e431f38f3fcd5c1f2f646061aaa2b21bc22d7a760d067aac",
    eventIndex: 0,
    bcs: "00381bbabbda5683069531d9a8354c4418cd4aa924c712f86d3c2900539595570600000000000000000000000000000000000000000000000000000000000000009d744b8c5c9934005c5e1900000000000000000000000000b0ac5253a786000051215b01000000002e0b007841539402334c8daea6a588621d61010000000000a7974bd435b67b19f67c0100000000000100000000000000",
    checks: { atob: false, amountIn: "14805321558750365" },
  },
} as const;
