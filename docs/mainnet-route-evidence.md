# Canonical mainnet route evidence

SDK 0.2.1 uses the canonical Blast package and shared object IDs. The manifest
adds the Cetus and Bluefin package and shared-object references used by the
canonical migrators. The venue and quote admission transaction finalized at
checkpoint 342367197.
[Admission receipt](https://suiscan.xyz/mainnet/tx/7HHZeepG6z5MJDjcnJ517cjN7uAuLdqt5HCpQxmTQZw9)

All 22 venue fork tests passed on a fresh mainnet snapshot using the pinned
canonical source at `86ee8cf9df8e9b2ec920f9564e2fda8afbf82106`. Live canonical
package and shared object identities were checked against the SDK manifest.
Launchpad, Presale and Vault reported pause masks 7, 7 and 1 at verification.

## Fee rates and tick spacings

The Cetus mainnet config lists all 16 pairs below at checkpoint 343264437.
Blast's Cetus route uses the venue's permissioned pair registry. At that
checkpoint, the registry allowed spacing 200 for SUI, USDC, USDsui and WAL
and had no entry for DEEP. The app reads the registry for the selected quote.

Bluefin's canonical Blast migrator accepts any integer spacing from 1 to 400
and any integer fee rate from 1 to 20000 millionths (0.0001% to 2%). The app
offers the 15 presets below. Their spacings all fit Bluefin's mainnet tick
bounds of −443636 to 443636 at the same checkpoint.

| Tick spacing | Pool fee | Rate in millionths | Blast Cetus | Blast Bluefin |
| ---: | ---: | ---: | :---: | :---: |
| 2 | 0.01% | 100 | — | ✓ |
| 4 | 0.02% | 200 | — | ✓ |
| 6 | 0.03% | 300 | — | ✓ |
| 8 | 0.04% | 400 | — | ✓ |
| 10 | 0.05% | 500 | — | ✓ |
| 20 | 0.10% | 1000 | — | ✓ |
| 30 | 0.15% | 1500 | — | ✓ |
| 40 | 0.20% | 2000 | — | ✓ |
| 60 | 0.25% | 2500 | — | ✓ |
| 80 | 0.30% | 3000 | — | ✓ |
| 100 | 0.40% | 4000 | — | ✓ |
| 120 | 0.60% | 6000 | — | ✓ |
| 160 | 0.80% | 8000 | — | ✓ |
| 200 | 1.00% | 10000 | ✓ | ✓ |
| 220 | 2.00% | 20000 | — | ✓ |
| 260 | 4.00% | 40000 | — | — |

## Mainnet rehearsal

All four migrations used spacing 200 and a 1% fee. They ran on separate
rehearsal packages from a dedicated wallet. The first-party contract sources
matched the pinned canonical source with the Vault fee-split notice changed
from 48 hours to zero for rehearsal. The rehearsal Vault was unpaused.

| Venue | Product | Quote | Signed migration checkpoint | Unsigned SDK simulation digest |
| --- | --- | --- | --- | --- |
| Bluefin | Launchpad | TEST_SUI | [343256659](https://suiscan.xyz/mainnet/tx/HgjC76qSBPApYYNM6GernvR3NpgdfpEXZCyPqi2B5sZt) | `Fp4K5LCuGYA7rVzi9ZGCAFvGapoCZ65czWkkbQTGxk6h` |
| Bluefin | Presale | TEST_SUI | [343256751](https://suiscan.xyz/mainnet/tx/5iT1hSmrJX26n5qFWMFkKZdo4MrqqrH26vjSm2MB13mZ) | `AyVyearMMWZDEJrTnKz3nA74RZeiephkgxD6CKm7NPRW` |
| Cetus | Launchpad | USDC (coin A) | [343256659](https://suiscan.xyz/mainnet/tx/HgjC76qSBPApYYNM6GernvR3NpgdfpEXZCyPqi2B5sZt) | `2o6zyXsizyEbFkuTBZ4MTuBT5vteuPKSnjEr1rFWp8s3` |
| Cetus | Presale | SUI (coin B) | [343256751](https://suiscan.xyz/mainnet/tx/5iT1hSmrJX26n5qFWMFkKZdo4MrqqrH26vjSm2MB13mZ) | `83U2byHeY1EJEDJhRwZvga6v89yt86uKtrZ2egbQz9aj` |

Each signed migration reconciled pool principal, residual balances and vault
position custody. SDK 0.2.0 then built unsigned mainnet simulations that
verified same-transaction fee-split application with zero delay, fee collection
under both splits, buyback and burn, and compounding on all four positions.
Production continues to enforce its on-chain 48-hour notice and pause flags.
