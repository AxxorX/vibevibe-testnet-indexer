# Advancing the validated event snapshot

The September 18 prefix is immutable: chain 46630, blocks 95,916,239 through
121,309,670. Its cached factory and curve logs, recovered terminal chunks,
participant artifact and hashed input manifest permit a complete offline replay.
An RPC rescan of that history is unnecessary for an event-derived update.

## Run and reproduce

```
npm run advance:snapshot -- --fetch
node --max-old-space-size=4096 --import tsx scripts/advance-snapshot.ts --source-dir "PATH_TO_FROZEN_RUN"
```

The first command explicitly authorizes network reads. It pins the current block
number and hash once; it never follows the moving head. It captures factory
launchCount, infrastructure getters and runtime hashes while the pinned state is
still available on the non-archive RPC. The operator configuration is a factory
discovery cross-check only, never the source of metric counts. Delisted factories
remain configured. A new published factory, changed infrastructure or unclassified
launch emitter stops the update before curve scanning/publication.

An interrupted, unpublished run resumes from its complete chunks. If a later
continuation explicitly needs a fresh target, `--fetch --refresh-head` first
checks the previous target's canonical hash, archives its preflight evidence,
and pins a newer head. It retains the same start block and reuses complete
chunks, fetching only uncovered ranges. A finalized delta cannot be repinned.
Chunk writes use a temporary file followed by rename; incomplete temporary files
are never counted as coverage. Invalid existing JSON stops replay for investigation.

Only the adjacent range starting at 121,309,671 is scanned. First, all known
factory event signatures are queried across all emitters. All launch records and
new curve identities are collected before the curve pass. Then all known curve
event signatures are queried across all emitters. This includes initial trades
emitted before the factory's launch log in the same transaction and later trades
or lifecycle events from newly created curves. Attribution uses the complete
historical-plus-delta curve registry, never only the old curve set. Topic matches
alone do not establish a new Vibe/Vibe factory.

Raw RPC rows are strictly decoded individually, so an incompatible payload cannot
silently disappear behind a decoder filter. Oversized queries shrink adaptively;
a capped result fails or shrinks. Every complete chunk, including the terminal
chunk, is persisted under `recovery/incremental-current/`. No archived file is
overwritten. Final head and historical event-anchor hashes must remain unchanged.

The second command performs no network requests. It verifies original publication
hashes, replays the prefix with the original decoders, matches every original
input hash, reconciles all baseline counts and lifecycle records, and reproduces
the original participant totals. It then checks each delta chunk's hash, row
count, range and raw-event totals. Full launch IDs must remain dense per factory
and match the pinned on-chain counters.

Events are deduplicated by transaction hash and log index; conflicting duplicates
fail. Transaction hashes use global category sets and a global union. Addresses
use the existing participant derivation over all historical and delta records.
Category counts are never added to manufacture an address total. A transaction
appearing in both disjoint block ranges is an integrity failure.

Only after all checks pass does the script atomically expose
`sample-output/current-<head>/` with `overview.json`, `participants.json`,
`incremental-proof.json` and `participants-input-manifest.json`. Repeating the
offline command reproduces and compares all four files without overwriting them.
The original September 18 artifacts remain unchanged.

## Scope and limits

Full history means continuous coverage of the configured launch and curve event
surfaces, combining the validated prefix and adjacent delta. It does not mean all
chain activity or all possible factory deployments. The operator's published
configuration and a topic-only launch-discovery pass bound the factory check;
there is no canonical factory registry and an unpublished factory with different
event signatures remains outside this discovery method.

The last preserved event hash is at block 121,309,669. The old source head was
121,309,670; its event-free suffix is inherited from the validated historical run.
The old-head header is observed during advancement, rather than misrepresented
as a hash captured in September 18's original artifact. The new target hash is
checked before and after scanning, but no finality claim is added.

New-head factory runtime hashes are observations, not a historical bytecode
comparison. Fee models retain September 18 verification, and graduation targets
retain September 13 verification. No project-state enrichment or burn scan is
performed by this path. Explore retains its separately enriched source at head
120,753,391. Participant definitions and all address exclusions are unchanged;
no time-windowed metrics are added.
