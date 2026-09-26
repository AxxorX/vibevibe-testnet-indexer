# Indexed address participation

The public labels are **Indexed actor addresses** and **Indexed participant addresses**.
Both count normalized event-role addresses, cumulatively through the source head.

## Definitions

Let C be launch creators, A be Bought buyers and Sold sellers, and R be Bought recipients.
Actors = C union A. Participants = C union A union R. Trade participants = A union R.
The implementation uses one global address map with role membership; it never sums
per-project or category counts to derive either headline. Creator/buyer-seller overlap
is C intersect A; creator/trade-participant overlap is C intersect (A union R).

An address is a multi-project actor only when its creator/buyer/seller roles identify
more than one project. The participant measure additionally accepts recipient roles.
Each project is identified by normalized factory plus the existing generation-scoped
launch key. Trades join through a validated normalized curve-to-project mapping.
Multiple events or roles within one project count as one project.

## Normalization and exclusions

Trim whitespace; accept exactly 40 hexadecimal characters with an optional `0x` prefix
(case-insensitive); canonicalize to lowercase `0x` form before comparing. Reject
malformed or missing values and the zero-address sentinel. Diagnostics count rejected
field values, by event role and reason; an expected null sell recipient is not a rejected
field. Valid contract and intermediary addresses remain included. No account-type
classification, name resolution, social enrichment or identity inference is performed.

Excluded roles: creatorFeeRecipient, creatorVault, lifecycle vault, token, curve, factory,
quoteCurrency and fee-claim treasury. These are field-role exclusions: an identical
address counts if it independently occurs in an included creator/buyer/seller/recipient
role. CurveCompleted and Graduated reveal no initiating address. Lifecycle initiators
cannot be measured from these records.

Event actors are not necessarily transaction senders. Buyer and recipient can differ.
Addresses may represent people, contracts or intermediaries; address equality does not
establish real-world identity. Post-graduation DEX swaps, approvals, ordinary transfers,
burns, failed calls and unconfigured factories remain outside scope. Categories overlap.
Daily/weekly/monthly activity, new/returning actors and other time-series measures are
not implemented.

## Artifact

`participants.json` uses schemaVersion 1 and definitionVersion 1. It contains:

- `chain`, source start/head, original `sourceRun` timestamps and separate `derivedAt`;
- `indexedActorAddressCount`, `indexedParticipantAddressCount`;
- `distinctCreatorAddressCount`, `distinctBuyerSellerAddressCount`,
  `distinctBuyRecipientAddressCount`, `distinctTradeParticipantAddressCount`;
- `creatorBuyerSellerOverlap`, `creatorTradeParticipantOverlap`;
- `multiProjectActorAddressCount`, `multiProjectParticipantAddressCount`,
  `recipientOnlyAddressCount`;
- contributing scan bounds, definitions, included/excluded roles, normalization and
  contract-inclusion policies, public exclusions and limitations;
- rejected values by role/reason, zero diagnostics, attribution diagnostics and
  coverage/reconciliation evidence, including a hashed input manifest for frozen replay.

Only aggregates are public. Complete validated runs can publish counts. The regular
indexer emits an explicit unavailable stub for windowed runs or failed checks, replacing
any stale artifact. The frozen replay refuses to produce metrics on missing coverage,
unusable addresses, unassigned activity or reconciliation failure. Consumers must
validate source identity and coverage, not only the schema's shape.

## Reproducing the 2026-09-18 source run

The immutable target is chain 46630, blocks 95,916,239–121,309,670, started
2026-09-18T16:27:46.209Z and finished 2026-09-18T17:00:25.492Z. Existing caches cover
through 121,296,238. The scanner did not persist the final chunk because it touched
the tip safety region. A completed checkpoint alone is not proof of persisted coverage.

`npm run replay:participants -- --recover-tail` fetches only factory and curve logs
for 121,296,239–121,309,670, stores them under the ignored recovery directory, and
replays the frozen cache using the same pure decoders as normal indexing. It never
reads receipts or transaction senders and never requests a new full-history scan.
Run without `--recover-tail` to replay completely offline after recovery.

The mandatory gate reproduces 97,733 launches (14,800 retired; 43,220 legacy;
39,713 current), 1,565,964 buys, 427,376 sells, 75,459 lifecycle events, 502 ignored
foreign curve logs and 2,098,026 distinct indexed transactions. Category transaction
counts must be 97,733 launch, 1,993,340 trade and 62,848 lifecycle, with overlap overcount
55,895. Source metadata, dense factory-scoped launch IDs, file-range coverage and
stable event identities are also checked. Failure must not establish a replacement
baseline or update the dashboard snapshot.

The original dashboard snapshot retains this source run. A later Overview can
advance it through the validated [incremental path](incremental-snapshots.md),
which publishes a separately named artifact with immutable-prefix and delta proof.
Explore retains its older enriched run at head 120,753,391; no Explore regeneration
is needed for these aggregates.
