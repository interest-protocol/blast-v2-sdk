/**
 * Literal Bluefin Spot fixtures for the migrated-venue adapter. Nothing here
 * is computed by the SDK: every byte string was copied from a reviewed source.
 *
 * - `MAINNET_BLUEFIN_SWAPS`: blast-infra `tests/venues/sample.json` at
 *   48bd479 (fetched from Sui mainnet GraphQL by `tests/venues/fetch.py`).
 *   `bcs` is the event's BCS and `json` is GraphQL's own rendering of the
 *   same event, an independent decoding.
 * - `BLAST_BLUEFIN`: blast-infra `tests/fixtures/venues` at 48bd479, which
 *   runs the launchpad and migrators (contracts a2a1db2) against forked
 *   mainnet Bluefin Spot bytecode (the contracts 442116a fork snapshot) in
 *   Sui's simulator. Its `manifest.json` records launch "d" (Bluefin, Meme
 *   is coin A), the vault, pool, tier, liquidity, digests, senders, and swap
 *   inputs; the pool object, the two `AssetSwap`s, and the `FlashSwap` are
 *   the BCS of checkpoints 31 to 34 (`<n>.binpb.zst`), read with the Sui SDK's
 *   `Checkpoint` protobuf and `bcs.Object` schemas. `checks` lists the
 *   manifest facts each byte string was cross-checked against.
 * - The Bluefin Spot lineage and `GlobalConfig` identity are
 *   `VENUE_LINEAGE` in `venue-deployment.ts` (contracts 442116a), the same
 *   package and config the fixture simulation forked.
 */

/** Two mainnet swaps: one b2a with a positive tick, one a2b with a negative tick. */
export const MAINNET_BLUEFIN_SWAPS = [
  {
    checkpoint: "327370024",
    transactionDigest: "257GabLQrTpvAjnXJV5JykK9bNM5PKtJ5LSGDxB1aS1Z",
    eventIndex: 14,
    eventType:
      "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::AssetSwap",
    bcs: "4746414e445cebdc19666b6e4de9b79a46ca7bcaa894bf10ec230e649376356e00800fbfcc02000000a6e041b20200000087932bc94c0300008173942f190a0000bbd50100000000009ccc875ad444030200000000000000009ccc875ad444030200000000000000008f9842e99950dd0401000000000000000aa0db01fe51dd0401000000000000007801000000110c5b00000000000000000000000000",
    json: {
      pool_id:
        "0x4746414e445cebdc19666b6e4de9b79a46ca7bcaa894bf10ec230e649376356e",
      a2b: false,
      amount_in: "12025008000",
      amount_out: "11580596390",
      pool_coin_a_amount: "3628327474055",
      pool_coin_b_amount: "11103288718209",
      fee: "120251",
      before_liquidity: "145035291848592540",
      after_liquidity: "145035291848592540",
      before_sqrt_price: "18797269041687992463",
      after_sqrt_price: "18797270571109031946",
      current_tick: { bits: 376 },
      exceeded: false,
      sequence_number: "5966865",
    },
  },
  {
    checkpoint: "327370024",
    transactionDigest: "257GabLQrTpvAjnXJV5JykK9bNM5PKtJ5LSGDxB1aS1Z",
    eventIndex: 30,
    eventType:
      "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::AssetSwap",
    bcs: "11dbeb991fea4b2c7efcba4b6b21cbecd3f94be99ec8c9205839eaf03356d35801a6e041b2020000004959d60000000000f729f134130a000082e71d5e03000000acab110000000000cffdf97d920100000000000000000000cffdf97d920100000000000000000000d9188da4f9e6ea080000000000000000b9fa022fa45eea080000000000000000b0f9feff00d21bae00000000000000000000000000",
    json: {
      pool_id:
        "0x11dbeb991fea4b2c7efcba4b6b21cbecd3f94be99ec8c9205839eaf03356d358",
      a2b: true,
      amount_in: "11580596390",
      amount_out: "14047561",
      pool_coin_a_amount: "11077608876535",
      pool_coin_b_amount: "14463920002",
      fee: "1158060",
      before_liquidity: "1728690388431",
      after_liquidity: "1728690388431",
      before_sqrt_price: "642579856735672537",
      after_sqrt_price: "642429956110088889",
      current_tick: { bits: 4294900144 },
      exceeded: false,
      sequence_number: "11410386",
    },
  },
] as const;

/** The blast-infra venue fixture's Bluefin launch (coin "d"): Meme is coin A, Quote is SUI. */
export const BLAST_BLUEFIN = {
  memeType:
    "0x29ba3dd8f91b6a5cd83c0046f563e24e0a1ac3605c5923baa9786aaa44069ced::meme::MEME",
  quoteType:
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  launchId:
    "0x80ee53c1904484557d860db91d7c5393863fe5dd2e32fdfda9d553c1805ac654",
  /** The simulator's `blast_fun_migrators` package. */
  migratorsPackageId:
    "0x49abf9d4b9adf6b8b2afa5df04d3fa450f152e05bd8b32257d1baf57a273f1b2",
  vaultId: "0x18567d8fd471eff3893adb48a45da43a81b6eb8e00d93631b134fb564251a284",
  /** Step 23: the launch's recorded tier. */
  tickSpacing: 60,
  feeRate: "3000",
  migrationDigest: "9Yc61QT8R32rSPQngPyqPy2ZCEY2zH1e9ZMUJGaHEPut",
  /** The pool as migration (checkpoint 31, version 1016519806) left it. */
  pool: {
    objectId:
      "0x119ad44916d4c15ef778923be095aefd80d242e49e7c3218148046a5c2eed108",
    type: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool<0x29ba3dd8f91b6a5cd83c0046f563e24e0a1ac3605c5923baa9786aaa44069ced::meme::MEME,0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>",
    initialSharedVersion: "1016519806",
    content:
      "119ad44916d4c15ef778923be095aefd80d242e49e7c3218148046a5c2eed1080853414c412d535549dbdf81d2cdac0000a00c342e05000000b80b000000000000400d0300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c000000d76221be12aa36b277dcc8144eef6b81c748f922e874c74cc63edba8a233842f020000000000000097b1d4deadeb71bd9ab82de9e9b87bae1f54b455ea23896aad34e7c180edd641020000000000000001ab64b66a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000010000000000000001000000000000000fd9f426f432c50200000000000000005f9efeff4c036db8de010000000000000000000000002a68747470733a2f2f626c756566696e2e696f2f696d616765732f6e6674732f64656661756c742e6769660100000000000000000000000000000001000000000000000000000000000000",
    checks: { tickSpacing: 60, liquidity: "2056088519500" },
  },
  /** Step 46: w1 buys through `pool::swap` (b2a, by amount in, 500000000). */
  buy: {
    checkpoint: "32",
    transactionDigest: "E1YaP5pjHt1daBn5qP1utnQCDPB2KqpNQNfBSJhCW23a",
    sender:
      "0xfa9cbb9ac8d8b1d912be45fc4aac964488f4ac3c5a19553ab226d8c448d92634",
    eventIndex: 0,
    bcs: "119ad44916d4c15ef778923be095aefd80d242e49e7c3218148046a5c2eed108000065cd1d000000009c0f2f68c90300003fd0526a04a90000a071014c0500000060e31600000000004c036db8de01000000000000000000004c036db8de01000000000000000000000fd9f426f432c50200000000000000004f77dbc49916d50200000000000000001aa0feff0002000000000000000000000000000000",
    checks: { a2b: false, amountIn: "500000000" },
  },
  /** Step 47: w2 sells through `pool::swap` (a2b, by amount in). */
  sell: {
    checkpoint: "33",
    transactionDigest: "4adyBxGTJ1FTPfQdLRYqUbRZUqyzNKAqQ8xm2F7DuTu5",
    sender:
      "0x9f33a6fc03a9dca7e431f38f3fcd5c1f2f646061aaa2b21bc22d7a760d067aac",
    eventIndex: 0,
    bcs: "119ad44916d4c15ef778923be095aefd80d242e49e7c3218148046a5c2eed10801dbc0eeb1d007000037f0c03b000000001a91411cd5b000006981401005000000fba68800060000004c036db8de01000000000000000000004c036db8de01000000000000000000004f77dbc49916d5020000000000000000382460426d22b5020000000000000000949cfeff0003000000000000000000000000000000",
    checks: { a2b: true, amountIn: "8592919806171" },
  },
  /** Step 48: w3 buys through `pool::flash_swap` (b2a, by amount in), which emits `FlashSwap`. */
  flashBuy: {
    checkpoint: "34",
    transactionDigest: "6b3NAV3F8TEsSUHbuhWFYuV8Vm1BzCrmgrmRLGAT3Uw8",
    sender:
      "0x19e889f3a5620aadde8f93461c04bef7cac0ede49f11e6002c172fd62c8ae7d5",
    eventIndex: 0,
    bcs: "119ad44916d4c15ef778923be095aefd80d242e49e7c3218148046a5c2eed10800002f685900000000b6903681600b000020aa4400000000004c036db8de01000000000000000000004c036db8de0100000000000000000000382460426d22b5020000000000000000fafe131c5ecde4020000000000000000c7a1feff0004000000000000000000000000000000",
    checks: { a2b: false, amountIn: "1500000000" },
  },
} as const;
