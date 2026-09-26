import { GENERATIONS } from "../../config/factories.js";
import { AUTHORITATIVE_COUNTS, AUTHORITATIVE_RUN } from "./participantSource.js";

export interface IncrementalRange { fromBlock: number; toBlock: number }
export interface IncrementalEvidence {
  prefix: {
    sourceRun: { chainId: number; headBlock: number; startedAt: string; finishedAt: string };
    counts: { [K in keyof typeof AUTHORITATIVE_COUNTS]: number };
    /** Digest of the preserved manifest whose inputs were verified during replay. */
    inputManifestSha256: string;
  };
  headBlock: number;
  delta: IncrementalRange & {
    factoryChunks: readonly IncrementalRange[];
    curveChunks: readonly IncrementalRange[];
  };
  anchors: {
    /**
     * A block hash preserved in a raw log in the reconciled historical tail.
     * The last stored event is at 121309669; a header for event-free block
     * 121309670 first observed during advancement is not a historical hash proof.
     */
    prefix: { blockNumber: number; storedHash: string; beforeHash: string; afterHash: string };
    /** The fixed target must still have its original canonical hash after scanning. */
    head: { blockNumber: number; beforeHash: string; afterHash: string };
  };
  factories: readonly {
    factory: string;
    generation: string;
    /** launchCount() read at the pinned target head, never at a moving latest tag. */
    launchCount: number;
    launchIds: readonly string[];
  }[];
  /** Unknown launch emitters found by the topic-only discovery pass. */
  unknownLaunchEmitters: readonly string[];
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incremental integrity: ${message}`);
}

function assertCoverage(chunks: readonly IncrementalRange[], range: IncrementalRange, surface: string): void {
  let next = range.fromBlock;
  for (const chunk of [...chunks].sort((a, b) => a.fromBlock - b.fromBlock)) {
    invariant(Number.isSafeInteger(chunk.fromBlock) && Number.isSafeInteger(chunk.toBlock) &&
      chunk.toBlock >= chunk.fromBlock && chunk.toBlock <= range.toBlock, `${surface} invalid chunk bounds`);
    invariant(chunk.fromBlock === next, `${surface} coverage has a gap or overlap at ${next}`);
    next = chunk.toBlock + 1;
  }
  invariant(next === range.toBlock + 1, `${surface} coverage is incomplete at ${next}`);
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
function checkedHash(value: string, label: string): string {
  invariant(typeof value === "string" && HASH.test(value) && !/^0x0{64}$/.test(value), `${label} invalid block hash`);
  return value.toLowerCase();
}

/**
 * Pure publication gate for a replayed immutable prefix plus a bounded delta.
 * The scanner must verify manifest bytes, per-chunk decoded logs and identities
 * before constructing this evidence. This gate does not make network requests.
 */
export function assertIncrementalEvidence(evidence: IncrementalEvidence): void {
  const { prefix, headBlock, delta, anchors, factories, unknownLaunchEmitters } = evidence;
  for (const key of ["chainId", "headBlock", "startedAt", "finishedAt"] as const) {
    invariant(prefix.sourceRun[key] === AUTHORITATIVE_RUN[key], `historical source mismatch: ${key}`);
  }
  for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
    invariant(prefix.counts[key] === AUTHORITATIVE_COUNTS[key], `historical count mismatch: ${key}`);
  }
  invariant(/^[a-f0-9]{64}$/.test(prefix.inputManifestSha256), "missing historical input manifest digest");
  invariant(Number.isSafeInteger(headBlock) && headBlock > AUTHORITATIVE_RUN.headBlock, "target must advance the historical head");
  invariant(delta.fromBlock === AUTHORITATIVE_RUN.headBlock + 1 && delta.toBlock === headBlock,
    "delta must immediately follow the historical prefix and end at the pinned head");
  assertCoverage(delta.factoryChunks, delta, "factory");
  assertCoverage(delta.curveChunks, delta, "curve");

  invariant(Number.isSafeInteger(anchors.prefix.blockNumber) && anchors.prefix.blockNumber >= AUTHORITATIVE_RUN.tailFromBlock &&
    anchors.prefix.blockNumber <= AUTHORITATIVE_RUN.headBlock, "historical anchor is outside the reconciled tail");
  const stored = checkedHash(anchors.prefix.storedHash, "historical stored");
  invariant(checkedHash(anchors.prefix.beforeHash, "historical before") === stored &&
    checkedHash(anchors.prefix.afterHash, "historical after") === stored, "historical canonical hash changed");
  invariant(anchors.head.blockNumber === headBlock, "target anchor is not the pinned head");
  invariant(checkedHash(anchors.head.beforeHash, "target before") === checkedHash(anchors.head.afterHash, "target after"),
    "target canonical hash changed during scan");

  invariant(Array.isArray(unknownLaunchEmitters) && unknownLaunchEmitters.length === 0,
    "unclassified launch emitters require factory configuration review");
  invariant(factories.length === GENERATIONS.length, "configured factory set mismatch");
  const configured = new Map(GENERATIONS.map(generation => [generation.factory.toLowerCase(), generation.generation]));
  const prefixLaunchCounts: Record<string, number> = { retired: 14_800, legacy: 43_220, current: 39_713 };
  const seen = new Set<string>();
  let total = 0;
  for (const factory of factories) {
    const address = factory.factory.toLowerCase();
    invariant(configured.get(address) === factory.generation && !seen.has(address), "unknown, duplicate or mislabelled factory");
    seen.add(address);
    invariant(Number.isSafeInteger(factory.launchCount) && factory.launchCount >= (prefixLaunchCounts[factory.generation] ?? 0),
      `${factory.generation} launchCount regressed or is invalid`);
    invariant(factory.launchIds.length === factory.launchCount, `${factory.generation} launchCount differs from indexed launches`);
    const ids = new Set(factory.launchIds);
    invariant(ids.size === factory.launchIds.length, `${factory.generation} duplicate launch IDs`);
    for (let id = 0; id < factory.launchCount; id++) {
      invariant(ids.has(String(id)), `${factory.generation} launch IDs are not dense from zero: missing ${id}`);
    }
    total += factory.launchCount;
  }
  invariant(Number.isSafeInteger(total) && total >= prefix.counts.launchRecords, "full launch count is invalid");
}
