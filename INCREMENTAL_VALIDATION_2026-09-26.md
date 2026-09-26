# Incremental snapshot validation — September 26, 2026

Completed locally. No commits, pushes or deployment. Ready for the separately requested final publication audit.

## Head and scan provenance

- Old authoritative head: **121,309,670**; historical start: **95,916,239**.
- Fresh pinned head: **124,399,779**.
- Pinned head hash: `0x4ac4a3ca08fe235d7a2427088dece9127b70b0ffd44911f1544224e6334da88e`.
- Exact delta: **121,309,671–124,399,779**, **3,090,109 blocks**.
- Head observed: `2026-09-26T03:44:00.592Z`.
- Scan began: `2026-09-25T16:46:29.885Z`; completed: `2026-09-26T03:52:52.510Z`.
- Aggregate derived: `2026-09-26T03:56:53.856Z`.
- The interrupted September 25 target, 124,199,582, was checked for canonical stability before refreshing the target. Its preflight evidence and complete chunks were retained. Only uncovered ranges were fetched.

## Reconciled delta and authoritative totals

| Metric | New delta | New total |
|---|---:|---:|
| launchRecords | 63,118 | 160,851 |
| buyEvents | 902,753 | 2,468,717 |
| sellEvents | 422,538 | 849,914 |
| lifecycleEvents | 3,320 | 78,779 |
| uniqueTransactionCount | 1,333,081 | 3,431,107 |
| launchTransactionCount | 63,118 | 160,851 |
| tradeTransactionCount | 1,325,291 | 3,318,631 |
| lifecycleTransactionCount | 3,084 | 65,932 |
| sharedAcrossCategories | 58,412 | 114,307 |
| foreignCurveLogs | 34 | 536 |

Lifecycle delta: **2,850 CreatorFeesForwarded**, **234 CurveCompleted**, **236 Graduated**. No TokenLaunchedQuoted or LaunchFeesClaimed events were found in the delta. The raw topic scan returned 902,765 Bought, 422,555 Sold and 3,325 lifecycle events; project attribution excluded 34 foreign logs.

| Participant metric | New total |
|---|---:|
| indexedActorAddressCount | 118,251 |
| indexedParticipantAddressCount | 118,251 |
| distinctCreatorAddressCount | 65,705 |
| distinctBuyerSellerAddressCount | 111,054 |
| distinctBuyRecipientAddressCount | 112,403 |
| distinctTradeParticipantAddressCount | 112,406 |
| creatorBuyerSellerOverlap | 58,508 |
| creatorTradeParticipantOverlap | 59,860 |
| multiProjectActorAddressCount | 83,462 |
| multiProjectParticipantAddressCount | 83,462 |
| recipientOnlyAddressCount | 0 |

Actors remain creators UNION Bought.buyer UNION Sold.seller. Participants add Bought.recipient. Every address is normalized before deduplication, and contracts remain included. The equal headline counts reflect zero globally recipient-only addresses; their definitions remain separate. Multi-project actor attribution excludes recipient-only project occurrences. No time-windowed metrics were added.

All malformed, zero, unusable and unmapped-trade diagnostics are **0**, including all per-role counters.

| Generation | Delta launches | Total launches | Last launch block |
|---|---:|---:|---:|
| retired | 6 | 14,806 | 124,399,056 |
| legacy | 1,682 | 44,902 | 124,399,590 |
| current | 61,430 | 101,143 | 124,399,775 |

## Factory and dependency checks

No new legitimate factory/generation was discovered. The operator configuration still names the configured current and legacy factories; the delisted retired factory was retained. Published infrastructure addresses and pinned adapter/treasury getters match configuration. The application deployment version changed to `testnet-v5-r3.4b890b41-20260925.1`. All known launch-event signatures were scanned across the entire delta without an address filter; no unknown launch emitter was found. Topic matches alone were never classified as Vibe/Vibe factories.

All delta launches were decoded and validated before the curve scan. Full factory-scoped launch IDs remain dense and exactly match launchCount() captured at the new pinned head. Curve attribution uses the combined old and new registry. **513,547 included curve events came from newly discovered curves**; an old-curve-only filter would have lost them. Same-block initial trades preceding a launch log are explicitly tested.

## Prefix, coverage and artifact integrity

The historical prefix reproduced **97,733 launches**, **2,098,026 indexed transactions**, **75,459 lifecycle events**, **88,781 actor addresses** and **88,781 participant addresses** exactly. Every original manifest input hash matched; authoritative lifecycle identities/content and all original component counts matched. The archived source and original published artifacts were not overwritten.

Coverage is proved by contiguous chunk bounds: **156 factory chunks** and **303 curve chunks** cover exactly the adjacent delta. Every chunk hash, row count, raw-event count and strict decoded schema was checked. Stable transaction-hash/log-index identity removes identical duplicates and rejects conflicting copies; duplicate events removed in this dataset: **0**. Global transaction and address sets were rebuilt across both ranges. No category sum was used as a global unique address count.

Historical event anchor and pinned target hashes matched before and after scanning. The latest stored historical event hash is at **121,309,669**; the old-head event-free suffix through 121,309,670 is inherited from the previously validated run. Its header was observed during advancement, not claimed to have been captured in the original run.

The new snapshot was emitted only after all gates passed, via an atomic directory rename. A second entirely offline replay reproduced all four files **byte-for-byte**.

| Intentional public artifact | SHA-256 |
|---|---|
| [incremental-proof.json](sample-output/current-124399779/incremental-proof.json) | `508f48dd130ab7388e4ef909275b8874d94d6bc8320fac6ab38a2fa5fd6effb7` |
| [overview.json](sample-output/current-124399779/overview.json) | `7532d11fa7a60fb1cc9515b5ab066e0aa8d3e00096c1f4b96903d9714b398a54` |
| [participants-input-manifest.json](sample-output/current-124399779/participants-input-manifest.json) | `a0b4f8fd31dd8361c88e41e1fa4d443f8abe7c70f58ec4f61bed2c638ca21eb2` |
| [participants.json](sample-output/current-124399779/participants.json) | `e682b05b4bd521d4ef9e4af0ffbf553908ba7a0e26dd33840895cdbcbed2f34e` |

## Dashboard and validation

Overview now consumes the dated indexer participant and Overview artifacts through runtime validation against fixed source/count/hash pins. It displays actor addresses as the primary metric, participant details separately, and the exact incremental range and head hash. Fee models retain September 18 verification; graduation targets and original address-book deployment evidence retain September 13 dates. No burn or project-state enrichment scan is claimed.

Explore remains unchanged at **head 120,753,391**, **96,490 launches**, September 17, 2026. Its data shards and source declaration have no diff.

| Validation | Result |
|---|---|
| Indexer typecheck | Passed |
| Indexer full tests | 153 passed |
| Strict compilation of advancement/replay scripts and integrity/artifact tests | Passed |
| Historical-prefix reproduction, delta integrity, transaction/address unions, artifact hashes | Passed |
| Complete offline reproduction of all four new outputs | Byte-for-byte match |
| Dashboard typecheck | Passed |
| Dashboard lint | Passed |
| Dashboard full tests | 251 passed, 6 files |
| Dashboard production build | Passed; static Overview and Explore |
| Responsive production checks | 320, 390, 768, 1440 px; no horizontal overflow |
| Visual inspection | Desktop/mobile metrics and mobile provenance checked |
| Browser errors | None |
| Git diff whitespace checks | Passed in both repositories |

The in-app browser runtime failed to initialize, so responsive checks used the installed headless Chromium/Playwright runtime. No new dependency was installed. One Explore shard test exceeded its existing five-second timeout during the concurrent disk replay; the unchanged full suite passed afterward in under one second. No timeout was weakened.

One zero-byte delta chunk left by the interruption was rejected before publication, preserved under the ignored incomplete directory, and its uncovered range refetched. Complete chunks were retained. Subsequent writes use temporary files and rename. The incident is recorded in the proof; the historical prefix was unaffected.

## Remaining limits and release hygiene

Full history means the configured launch/curve event surfaces, not all chain activity or every conceivable factory. Discovery remains bounded by published configuration and known event signatures. New foreign emitters were excluded by project attribution and were not represented as having undergone the prior historical bytecode review. There are **536 excluded logs from 97 distinct foreign contracts** cumulatively; the delta has 34 logs from 12 contracts.

New-head runtime hashes are recorded; no September 18 runtime comparison is claimed. The pinned head is an observation checked for canonical stability, not a finality guarantee or continuously updating feed. No transaction receipts, tx.from, identity enrichment, contract filtering, post-graduation DEX activity or time-windowed metrics were added.

Another full-history RPC scan remains **unnecessary**. Frozen prefix plus retained delta can reproduce this snapshot offline.

Changed-file review found no credential-shaped values or machine-local paths in the prospective source/artifact set. No cache, recovery, temporary, screenshot, log, build or dependency file is in that set. The four dated indexer aggregate/proof/manifest files and three dashboard JSON copies are intentional public artifacts. All raw delta chunks, interrupted-file evidence and QA screenshots remain ignored under recovery/. Nothing is staged. Repository HEAD commits are unchanged.

## Exact working-tree file inventory

This inventory includes the preserved, previously validated participant implementation as well as the incremental additions. M denotes a tracked modification; new files remain untracked. No existing work was reset or discarded.

### vibevibe-testnet-indexer

- `.gitignore`
- `INCREMENTAL_VALIDATION_2026-09-26.md`
- `README.md`
- `docs/data-model.md`
- `docs/incremental-snapshots.md`
- `docs/known-limitations.md`
- `docs/participants.md`
- `package.json`
- `sample-output/current-124399779/incremental-proof.json`
- `sample-output/current-124399779/overview.json`
- `sample-output/current-124399779/participants-input-manifest.json`
- `sample-output/current-124399779/participants.json`
- `sample-output/participants-input-manifest.json`
- `sample-output/participants.json`
- `scripts/advance-snapshot.ts`
- `scripts/participant-replay-integrity.ts`
- `scripts/replay-participants.ts`
- `src/cli.ts`
- `src/derive/incrementalIntegrity.ts`
- `src/derive/participantArtifact.ts`
- `src/derive/participantSource.ts`
- `src/derive/participants.ts`
- `src/derive/projects.ts`
- `src/emit/outputs.ts`
- `src/stages/decode.ts`
- `src/stages/launches.ts`
- `src/stages/trades.ts`
- `test/incremental-integrity.test.ts`
- `test/participant-artifact.test.ts`
- `test/participant-replay.test.ts`
- `test/participants.test.ts`

### vibevibe-testnet-dashboard

- `README.md`
- `src/app/page.tsx`
- `src/components/limitations-note.tsx`
- `src/components/metric-tiles.tsx`
- `src/components/participation-details.tsx`
- `src/components/provenance-panel.tsx`
- `src/data/incremental.ts`
- `src/data/index.ts`
- `src/data/participants.ts`
- `src/data/snapshots/2026-09-18-121309670.ts`
- `src/data/snapshots/2026-09-26-124399779.ts`
- `src/data/snapshots/overview-2026-09-26-124399779.json`
- `src/data/snapshots/participants-2026-09-18-121309670.json`
- `src/data/snapshots/participants-2026-09-26-124399779.json`
- `src/data/snapshots/proof-2026-09-26-124399779.json`
- `src/data/snapshots/source-2026-09-26-124399779.ts`
- `src/data/types.ts`
- `test/current-snapshot.test.ts`
- `test/explore.test.ts`
- `test/incremental.test.ts`
- `test/participants.test.ts`
- `test/snapshot.test.ts`

Ignored execution records are deliberately excluded from that prospective source set. Exact delta chunk filenames/hashes are enumerated in `sample-output/current-124399779/participants-input-manifest.json` (`deltaInputs`); their local base is `recovery/incremental-current/`. Preflight, delta-manifest, recovery-incident, interrupted-file and QA evidence remain in that ignored directory.
