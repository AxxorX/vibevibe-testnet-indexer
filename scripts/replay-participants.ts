/**
 * Frozen source replay. Default: disk only. --recover-tail opts in to the two
 * audited missing event surfaces, never a live-head scan or transaction lookup.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address } from "viem";
import { FACTORY_EVENTS, CURVE_EVENTS } from "../config/abis.js";
import { FACTORY_ADDRESSES, FACTORY_BY_ADDRESS } from "../config/factories.js";
import { config } from "../config/network.js";
import { scrubCredentials } from "../src/lib/redact.js";
import { createParticipantAccumulator } from "../src/derive/participants.js";
import { createParticipantArtifact } from "../src/derive/participantArtifact.js";
import { decodeLaunchLog, decodeCurveLog } from "../src/stages/decode.js";
import type { LaunchRecord } from "../src/stages/launches.js";
import type { LifecycleEvent, TradeRecord } from "../src/stages/trades.js";
import {
  AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS, EventDeduplicator,
  assertAuthoritativeRun, assertCompleteCoverage, assertDenseLaunchIds,
  assertReconciliation, parseChunkRange, sha256, validateRawLog,
  type ChunkRange, type LogSurface, type ReconciliationCounts,
} from "./participant-replay-integrity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECOVERY = path.join(ROOT, "recovery", "2026-09-18-121309670");
const PUBLIC_OUTPUT = path.join(ROOT, "sample-output");
const TAIL_FILE = `${AUTHORITATIVE_RUN.tailFromBlock}-${AUTHORITATIVE_RUN.headBlock}.json`;
const TAIL_RANGE = { ...parseChunkRange(TAIL_FILE), file: TAIL_FILE };
const NAMESPACES = {
  factory: "launches-all-generations",
  curve: `trades-${AUTHORITATIVE_RUN.fromBlock}-${AUTHORITATIVE_RUN.headBlock}`,
};
const SOURCE_RUN = {
  chainId: AUTHORITATIVE_RUN.chainId,
  headBlock: AUTHORITATIVE_RUN.headBlock,
  startedAt: AUTHORITATIVE_RUN.startedAt,
  finishedAt: AUTHORITATIVE_RUN.finishedAt,
};

interface ManifestInput {
  source: string;
  sha256: string;
  bytes: number;
  fromBlock?: number;
  toBlock?: number;
  rows?: number;
}
interface ReplayChunk extends ChunkRange { absolutePath: string; source: string }

function fail(message: string): never { throw new Error(`Participant replay: ${message}`); }
function invariant(value: unknown, message: string): asserts value { if (!value) fail(message); }
function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
}
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) :
    item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : item;
  return JSON.stringify(sorted(value));
}
function readInput(file: string, source: string, manifest: ManifestInput[]): unknown {
  const bytes = fs.readFileSync(file);
  manifest.push({ source, sha256: sha256(bytes), bytes: bytes.length });
  return JSON.parse(bytes.toString("utf8"));
}
function listCache(sourceRoot: string, surface: LogSurface): ReplayChunk[] {
  const namespace = NAMESPACES[surface];
  const directory = path.join(sourceRoot, "data", "cache", namespace);
  const chunks = fs.readdirSync(directory).map(file => ({
    ...parseChunkRange(file), absolutePath: path.join(directory, file), source: `cache/${namespace}/${file}`,
  })).sort((a, b) => a.fromBlock - b.fromBlock);
  assertCompleteCoverage(chunks, AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.cachedThroughBlock);
  return chunks;
}
function tailChunk(surface: LogSurface): ReplayChunk {
  return {
    ...TAIL_RANGE,
    absolutePath: path.join(RECOVERY, NAMESPACES[surface], TAIL_FILE),
    source: `recovered-tail/${NAMESPACES[surface]}/${TAIL_FILE}`,
  };
}

async function recoverTail(): Promise<void> {
  const existing = ["factory", "curve"].map(surface => tailChunk(surface as LogSurface).absolutePath);
  invariant(existing.every(file => !fs.existsSync(file)), "refusing to overwrite an existing recovered tail; replay it without --recover-tail");
  const rpc = createPublicClient({ transport: http(config.rpcUrl, { timeout: 120_000, retryCount: 2 }) });
  const chainId = await rpc.getChainId();
  invariant(chainId === AUTHORITATIVE_RUN.chainId, `RPC chain ${chainId} differs from frozen chain ${AUTHORITATIVE_RUN.chainId}`);
  console.log(`Recovering only blocks ${AUTHORITATIVE_RUN.tailFromBlock}..${AUTHORITATIVE_RUN.headBlock}: factory and curve eth_getLogs.`);
  // Exactly this fixed historical range. No head query, receipt, tx.from, state,
  // API enrichment, or fallback to the expensive indexing CLI is permitted.
  const bounds = { fromBlock: BigInt(AUTHORITATIVE_RUN.tailFromBlock), toBlock: BigInt(AUTHORITATIVE_RUN.headBlock) };
  const factoryLogs = await rpc.getLogs({ ...bounds, address: FACTORY_ADDRESSES as Address[], events: FACTORY_EVENTS, strict: true });
  const curveLogs = await rpc.getLogs({ ...bounds, events: CURVE_EVENTS, strict: true });
  const recovered: Record<LogSurface, unknown[]> = { factory: factoryLogs, curve: curveLogs };
  const results: { surface: LogSurface; rows: unknown[]; bytes: string; sha256: string }[] = [];
  for (const surface of ["factory", "curve"] as const) {
    const rows = recovered[surface].map(value => {
      const row = value as Record<string, unknown>;
      invariant(typeof row.blockNumber === "bigint" && row.logIndex !== null && row.removed !== true, "unusable RPC log");
      return validateRawLog({ ...row, blockNumber: Number(row.blockNumber), logIndex: Number(row.logIndex) }, TAIL_RANGE, surface);
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const bytes = jsonText(rows);
    results.push({ surface, rows, bytes, sha256: sha256(bytes) });
  }
  // Do not write partial query results when the second query fails.
  for (const result of results) {
    const file = tailChunk(result.surface).absolutePath;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result.bytes, { flag: "wx" });
  }
  const provenance = {
    sourceRun: SOURCE_RUN,
    sourceRunStartBlock: AUTHORITATIVE_RUN.fromBlock,
    fromBlock: AUTHORITATIVE_RUN.tailFromBlock,
    toBlock: AUTHORITATIVE_RUN.headBlock,
    chainId,
    recoveredAt: new Date().toISOString(),
    method: "eth_getLogs",
    surfaces: results.map(result => ({ surface: result.surface, source: tailChunk(result.surface).source, rows: result.rows.length, sha256: result.sha256 })),
  };
  fs.writeFileSync(path.join(RECOVERY, "tail-provenance.json"), jsonText(provenance), { flag: "wx" });
}

function validateTail(manifest: ManifestInput[]): Record<LogSurface, { rows: number; sha256: string }> {
  const file = path.join(RECOVERY, "tail-provenance.json");
  invariant(fs.existsSync(file), "missing bounded tail. Run with --recover-tail to explicitly permit the audited recovery");
  const provenance = readInput(file, "recovered-tail/tail-provenance.json", manifest) as {
    sourceRun: typeof SOURCE_RUN; sourceRunStartBlock: number; fromBlock: number; toBlock: number; chainId: number; method: string;
    surfaces: { surface: LogSurface; source: string; rows: number; sha256: string }[];
  };
  invariant(canonical(provenance.sourceRun) === canonical(SOURCE_RUN) && provenance.sourceRunStartBlock === AUTHORITATIVE_RUN.fromBlock,
    "tail source-run provenance mismatch");
  invariant(provenance.chainId === AUTHORITATIVE_RUN.chainId && provenance.fromBlock === AUTHORITATIVE_RUN.tailFromBlock &&
    provenance.toBlock === AUTHORITATIVE_RUN.headBlock && provenance.method === "eth_getLogs", "tail range/chain/method mismatch");
  invariant(Array.isArray(provenance.surfaces) && provenance.surfaces.length === 2, "tail surface manifest mismatch");
  const result = {} as Record<LogSurface, { rows: number; sha256: string }>;
  for (const surface of ["factory", "curve"] as const) {
    const entries = provenance.surfaces.filter(entry => entry.surface === surface);
    invariant(entries.length === 1 && entries[0].source === tailChunk(surface).source && Number.isSafeInteger(entries[0].rows) && entries[0].rows >= 0,
      `invalid tail ${surface} manifest`);
    result[surface] = entries[0];
  }
  return result;
}

function* streamChunks(chunks: readonly ReplayChunk[], surface: LogSurface, manifest: ManifestInput[], tail: { rows: number; sha256: string }) {
  for (const chunk of chunks) {
    const bytes = fs.readFileSync(chunk.absolutePath);
    const digest = sha256(bytes);
    const rows: unknown = JSON.parse(bytes.toString("utf8"));
    invariant(Array.isArray(rows), `${chunk.source} is not a log array`);
    if (chunk.fromBlock === AUTHORITATIVE_RUN.tailFromBlock) invariant(digest === tail.sha256 && rows.length === tail.rows, `recovered ${surface} tail hash/count mismatch`);
    manifest.push({ source: chunk.source, sha256: digest, bytes: bytes.length, fromBlock: chunk.fromBlock, toBlock: chunk.toBlock, rows: rows.length });
    for (const row of rows) yield validateRawLog(row, chunk, surface);
  }
}

/** Observers consume records in memory; publish:false never changes the frozen artifacts. */
export async function replayParticipants(argv = process.argv.slice(2), options: {
  publish?: boolean;
  onLaunches?: (launches: readonly LaunchRecord[]) => void;
  onTrade?: (trade: TradeRecord) => void;
} = {}) {
  let sourceRoot = ROOT;
  let shouldRecover = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--recover-tail") shouldRecover = true;
    else if (argv[i] === "--source-dir" && argv[i + 1]) sourceRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: tsx scripts/replay-participants.ts [--source-dir PATH] [--recover-tail]\nDefault is offline frozen replay. --recover-tail permits eth_chainId and bounded factory/curve eth_getLogs only.");
      return;
    } else fail(`unknown/incomplete argument ${argv[i]}`);
  }
  const manifest: ManifestInput[] = [];
  const factories = readInput(path.join(sourceRoot, "output", "factories.json"), "authoritative-output/factories.json", manifest) as {
    run: Parameters<typeof assertAuthoritativeRun>[0]; generations: { launchesIndexed: number }[];
  };
  assertAuthoritativeRun(factories.run);
  invariant(factories.generations.reduce((total, generation) => total + generation.launchesIndexed, 0) === AUTHORITATIVE_COUNTS.launchRecords,
    "authoritative factory artifact launch count mismatch");
  const activity = readInput(path.join(sourceRoot, "output", "activity.json"), "authoritative-output/activity.json", manifest) as Record<string, unknown>;
  invariant(activity.chainId === AUTHORITATIVE_RUN.chainId && activity.headBlock === AUTHORITATIVE_RUN.headBlock && activity.isFullHistory === true,
    "authoritative activity provenance mismatch");
  for (const name of ["launchScan", "curveScan"]) {
    const scan = activity[name] as { fromBlock: number; toBlock: number; isFullHistory: boolean };
    invariant(scan?.fromBlock === AUTHORITATIVE_RUN.fromBlock && scan.toBlock === AUTHORITATIVE_RUN.headBlock && scan.isFullHistory === true,
      `authoritative activity ${name} coverage mismatch`);
  }
  for (const key of ["uniqueTransactionCount", "launchTransactionCount", "tradeTransactionCount", "lifecycleTransactionCount", "sharedAcrossCategories", "unusableTransactionHashes"] as const) {
    invariant(activity[key] === AUTHORITATIVE_COUNTS[key], `authoritative activity ${key} mismatch`);
  }
  const storedLifecycle = readInput(path.join(sourceRoot, "output", "lifecycle.json"), "authoritative-output/lifecycle.json", manifest) as { count: number; lifecycle: LifecycleEvent[] };
  invariant(storedLifecycle.count === AUTHORITATIVE_COUNTS.lifecycleEvents && Array.isArray(storedLifecycle.lifecycle) && storedLifecycle.lifecycle.length === storedLifecycle.count,
    "authoritative lifecycle artifact count mismatch");
  const lifecycleIdentities = new Map(storedLifecycle.lifecycle.map(event => [`${event.txHash.toLowerCase()}:${event.logIndex}`, canonical(event)]));
  invariant(lifecycleIdentities.size === storedLifecycle.count, "duplicate authoritative lifecycle identity");
  const cache = { factory: listCache(sourceRoot, "factory"), curve: listCache(sourceRoot, "curve") };
  if (shouldRecover) await recoverTail();
  const tail = validateTail(manifest);
  const chunks = { factory: [...cache.factory, tailChunk("factory")], curve: [...cache.curve, tailChunk("curve")] };
  for (const surface of ["factory", "curve"] as const) assertCompleteCoverage(chunks[surface], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock);

  const seen = new EventDeduplicator();
  const launches: LaunchRecord[] = [];
  const launchKeys = new Set<string>();
  const generationIds = new Map<string, Set<string>>();
  const curveToToken = new Map<string, Address>();
  const launchTransactions = new Set<string>();
  const tradeTransactions = new Set<string>();
  const lifecycleTransactions = new Set<string>();
  const rawEventCounts: Record<string, number> = {};
  const foreignAddresses = new Set<string>();
  const recoveredEventCounts: Record<string, number> = {};
  const countRaw = (eventName: string, block: number) => {
    rawEventCounts[eventName] = (rawEventCounts[eventName] ?? 0) + 1;
    if (block >= AUTHORITATIVE_RUN.tailFromBlock) recoveredEventCounts[eventName] = (recoveredEventCounts[eventName] ?? 0) + 1;
  };
  for (const log of streamChunks(chunks.factory, "factory", manifest, tail.factory)) {
    invariant(FACTORY_BY_ADDRESS.has(log.address), `factory log from unconfigured emitter ${log.address}`);
    if (!seen.add(log)) continue;
    countRaw(log.eventName, log.blockNumber);
    const launch = decodeLaunchLog(log);
    if (!launch) continue;
    invariant(!launchKeys.has(launch.key), `duplicate factory-scoped launch ${launch.key}`);
    invariant(!curveToToken.has(launch.curve), `duplicate/ambiguous launch curve ${launch.curve}`);
    launchKeys.add(launch.key);
    curveToToken.set(launch.curve, launch.token);
    launches.push(launch);
    launchTransactions.add(launch.deploymentTxHash.toLowerCase());
    const ids = generationIds.get(launch.generation) ?? new Set<string>();
    ids.add(launch.launchId);
    generationIds.set(launch.generation, ids);
  }
  assertDenseLaunchIds(generationIds);
  options.onLaunches?.(launches);
  const scope = { fromBlock: AUTHORITATIVE_RUN.fromBlock, toBlock: AUTHORITATIVE_RUN.headBlock, isFullHistory: true };
  const accumulator = createParticipantAccumulator({ launches, launchScan: scope, curveScan: scope, headBlock: AUTHORITATIVE_RUN.headBlock, earliestDeploymentBlock: AUTHORITATIVE_RUN.fromBlock });
  let buyEvents = 0, sellEvents = 0, lifecycleEvents = 0, foreignCurveLogs = 0;
  console.log("Frozen launch coverage validated; replaying historical curve chunks from disk.");
  for (const log of streamChunks(chunks.curve, "curve", manifest, tail.curve)) {
    if (!seen.add(log)) continue;
    countRaw(log.eventName, log.blockNumber);
    const result = decodeCurveLog(log, curveToToken);
    if (result.foreign) { foreignCurveLogs++; foreignAddresses.add(log.address); continue; }
    if (result.trade) {
      const trade = result.trade;
      if (trade.side === "buy") buyEvents++; else sellEvents++;
      tradeTransactions.add(trade.txHash.toLowerCase());
      accumulator.addTrade(trade);
      options.onTrade?.(trade);
    } else if (result.lifecycle) {
      const event = result.lifecycle;
      lifecycleEvents++;
      lifecycleTransactions.add(event.txHash.toLowerCase());
      const identity = `${event.txHash.toLowerCase()}:${event.logIndex}`;
      invariant(lifecycleIdentities.get(identity) === canonical(event), `lifecycle mismatch against authoritative output at ${identity}`);
      lifecycleIdentities.delete(identity);
    } else fail(`known curve event was not decoded: ${log.eventName}`);
  }
  invariant(Number(lifecycleIdentities.size) === 0, "missing authoritative lifecycle events after replay");
  const outsideTrades = new Set<string>();
  for (const hash of launchTransactions) if (!tradeTransactions.has(hash)) outsideTrades.add(hash);
  for (const hash of lifecycleTransactions) if (!tradeTransactions.has(hash)) outsideTrades.add(hash);
  const uniqueTransactionCount = tradeTransactions.size + outsideTrades.size;
  const counts: ReconciliationCounts = {
    launchRecords: launches.length, buyEvents, sellEvents, lifecycleEvents, foreignCurveLogs,
    uniqueTransactionCount, launchTransactionCount: launchTransactions.size,
    tradeTransactionCount: tradeTransactions.size, lifecycleTransactionCount: lifecycleTransactions.size,
    sharedAcrossCategories: launchTransactions.size + tradeTransactions.size + lifecycleTransactions.size - uniqueTransactionCount,
    unusableTransactionHashes: 0,
  };
  // HARD PUBLICATION GATE: nothing containing participant counts is written or
  // logged before every frozen authoritative count has reconciled exactly.
  assertReconciliation(counts);
  invariant(rawEventCounts.TokenLaunched + (rawEventCounts.TokenLaunchedQuoted ?? 0) === 97_733 &&
    rawEventCounts.LaunchFeesClaimed === 6_939, "factory raw-event reconciliation failed");
  const summary = accumulator.finish();
  const generatedAt = new Date().toISOString();
  const inputManifest = {
    schemaVersion: 1,
    sourceRun: SOURCE_RUN,
    sourceRunStartBlock: AUTHORITATIVE_RUN.fromBlock,
    generatedAt,
    historicalCacheThroughBlock: AUTHORITATIVE_RUN.cachedThroughBlock,
    recoveredRange: { fromBlock: AUTHORITATIVE_RUN.tailFromBlock, toBlock: AUTHORITATIVE_RUN.headBlock },
    coverageComplete: true,
    reconciled: true,
    counts,
    duplicateEventsRemoved: seen.duplicates,
    rawEventCounts,
    recoveredEventCounts,
    inputs: manifest,
  };
  const manifestText = jsonText(inputManifest);
  const manifestName = "participants-input-manifest.json";
  const artifact = createParticipantArtifact({ summary, sourceRun: SOURCE_RUN, generatedAt, validation: {
    coverageComplete: true, reconciled: true, method: "frozen-cache-replay", counts,
    inputManifest: manifestName, inputManifestSha256: sha256(manifestText),
  } });
  if (options.publish === false) return { launches, launchTransactions, tradeTransactions, lifecycleTransactions,
    counts, summary, inputs: manifest, artifact, seen, foreignAddresses };
  fs.mkdirSync(PUBLIC_OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_OUTPUT, manifestName), manifestText);
  fs.writeFileSync(path.join(PUBLIC_OUTPUT, "participants.json"), jsonText(artifact));
  fs.writeFileSync(path.join(RECOVERY, "reconciliation.json"), jsonText({ sourceRun: SOURCE_RUN, sourceRunStartBlock: AUTHORITATIVE_RUN.fromBlock, counts, recoveredEventCounts, duplicateEventsRemoved: seen.duplicates, inputManifestSha256: sha256(manifestText) }));
  console.log(jsonText({ status: "reconciled", counts, recoveredEventCounts, output: "sample-output/participants.json", manifest: `sample-output/${manifestName}` }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  replayParticipants().catch(error => {
    console.error(scrubCredentials(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
