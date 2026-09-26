/** Incremental event snapshot: explicit --fetch permits only the new fixed range.
 * Default replay is offline. All writes are isolated from the archived prefix.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, decodeEventLog, toEventSelector, keccak256, type Address, type Hex } from "viem";
import { FACTORY_EVENTS, CURVE_EVENTS, FACTORY_READS } from "../config/abis.js";
import { GENERATIONS, FACTORY_BY_ADDRESS } from "../config/factories.js";
import { config } from "../config/network.js";
import { isRangeError, withRetry } from "../src/lib/rpc.js";
import { scrubCredentials } from "../src/lib/redact.js";
import { replayParticipants } from "./replay-participants.js";
import { AUTHORITATIVE_RUN, EventDeduplicator, assertCompleteCoverage, parseChunkRange, sha256, validateRawLog,
  type LogSurface, type ChunkRange, type ReconciliationCounts } from "./participant-replay-integrity.js";
import { createParticipantAccumulator, type ParticipantAccumulator } from "../src/derive/participants.js";
import { createParticipantArtifact } from "../src/derive/participantArtifact.js";
import { decodeLaunchLog, decodeCurveLog } from "../src/stages/decode.js";
import type { RawLog } from "../src/lib/logscan.js";
import type { LaunchRecord } from "../src/stages/launches.js";
import { assertIncrementalEvidence } from "../src/derive/incrementalIntegrity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "recovery", "incremental-current");
const PREFIX = path.join(ROOT, "sample-output");
const FROM = AUTHORITATIVE_RUN.headBlock + 1;
const PREFIX_MANIFEST_SHA = "45ac5115ff0dbfaed90f6a88f1d91a9d69da2ccf36d638049d55c8997a81e702";
const PREFIX_PARTICIPANT_SHA = "bd7bf075effc098e3256b594a018a7c1db81eb65bbc64defad010aae6066d564";
const EVENTS = { factory: FACTORY_EVENTS, curve: CURVE_EVENTS };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? x.toString() : x, 2) + "\n";
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));
function requireValue(v: unknown, message: string): asserts v { if (!v) throw new Error(`Incremental snapshot: ${message}`); }
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  requireValue(!fs.existsSync(file), `refusing to overwrite ${path.basename(file)}`);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, json(value), { flag: "wx" });
  fs.renameSync(temporary, file);
}
type Anchor = { number: number; hash: string; timestamp: number };
type Chunk = ChunkRange & { surface: LogSurface; sha256: string; rows: number };
interface Preflight {
  schemaVersion: 1; chainId: number; startedAt: string; head: Anchor; prefixHead: Anchor;
  prefixAnchor: { blockNumber: number; storedHash: string; beforeHash: string };
  prefixManifestSha256: string; prefixParticipantSha256: string;
  operatorConfig: any; operatorConfigCheckedAt: string;
  configurationChanges: string[];
  headObservedAt?: string;
  priorTargets?: { head: Anchor; checkedCanonicalHash: string; preflightSha256: string }[];
  factories: { factory: Address; generation: string; launchCount: number; runtimeHash: string; graduationAdapter: string; protocolTreasury: string }[];
}
interface DeltaManifest { schemaVersion: 1; preflight: Preflight; fromBlock: number; toBlock: number;
  chunks: Chunk[]; finishedAt: string; afterHeadHash: string; afterPrefixHash: string;
  rawEventCounts: Record<string, number>; unknownLaunchEmitters: string[] }

const rpc = createPublicClient({ transport: http(config.rpcUrl, { timeout: 90_000, retryCount: 0 }) });
async function header(number?: number): Promise<Anchor> {
  const block = await withRetry(() => rpc.getBlock(number === undefined ? { blockTag: "latest" } : { blockNumber: BigInt(number) }), "block header");
  requireValue(block.number !== null && block.hash, "missing canonical header");
  return { number: Number(block.number), hash: block.hash.toLowerCase(), timestamp: Number(block.timestamp) };
}
async function preflight(refreshHead = false): Promise<Preflight> {
  const file = path.join(DIR, "preflight.json");
  let previous: Preflight | undefined;
  if (fs.existsSync(file)) {
    const saved = read<Preflight>(file);
    requireValue((await header(saved.head.number)).hash === saved.head.hash, "pinned head changed; retained run cannot be resumed");
    if (!refreshHead) return saved;
    requireValue(!fs.existsSync(path.join(DIR, "delta-manifest.json")), "cannot repin a completed frozen delta");
    previous = saved;
  }
  const startedAt = new Date().toISOString();
  requireValue(await rpc.getChainId() === AUTHORITATIVE_RUN.chainId, "wrong chain");
  const response = await fetch(`${config.apiBase}/chains/46630/config`, { signal: AbortSignal.timeout(30_000) });
  requireValue(response.ok, "operator configuration unavailable; factory scope not established");
  const operatorConfig = await response.json() as any;
  const operatorConfigCheckedAt = new Date().toISOString();
  const published = operatorConfig.data;
  requireValue(published?.chain?.id === 46630 && published.deployments?.factory, "invalid operator configuration");
  const graphs = [published.deployments, ...(published.legacyPublicGraphs ?? []), ...(published.retiredPublicGraphs ?? [])];
  for (const graph of graphs) requireValue(FACTORY_BY_ADDRESS.has(String(graph.factory).toLowerCase()), `unconfigured published factory ${graph.factory}; stop for independent establishment`);
  const changes: string[] = [];
  for (const graph of graphs) {
    const configured = FACTORY_BY_ADDRESS.get(graph.factory.toLowerCase())!;
    for (const field of ["graduationAdapter", "feeHook", "liquidityLocker", "protocolTreasury"] as const) {
      requireValue(String(graph[field]).toLowerCase() === configured[field]?.toLowerCase(), `published ${configured.generation}.${field} changed; review scope before scanning`);
    }
  }
  if (published.deploymentVersion !== "testnet-v5-r3.bea975e9-20260917.2") changes.push(`Operator application deployment changed from testnet-v5-r3.bea975e9-20260917.2 to ${published.deploymentVersion}; published factory/infrastructure addresses match the configured generations.`);
  requireValue(published.protocol?.curveFeeBps === 125 && published.protocol?.creatorShareOfFeeBps === 7500 && published.protocol?.protocolShareOfFeeBps === 2500, "published fee configuration changed");
  const head = await header();
  const headObservedAt = new Date().toISOString();
  requireValue(head.number >= FROM, "no new range");
  requireValue(!previous || head.number >= previous.head.number, "refreshed head regressed");
  const prefixHead = await header(AUTHORITATIVE_RUN.headBlock);
  const oldTail = ["launches-all-generations", "trades-95916239-121309670"].flatMap(namespace =>
    read<RawLog[]>(path.join(ROOT, `recovery/2026-09-18-121309670/${namespace}/121296239-121309670.json`)));
  const last = oldTail.reduce((a, b) => a.blockNumber > b.blockNumber ? a : b);
  const prefixAnchor = { blockNumber: last.blockNumber, storedHash: last.blockHash, beforeHash: (await header(last.blockNumber)).hash };
  requireValue(prefixAnchor.storedHash === prefixAnchor.beforeHash, "historical prefix canonical anchor changed");
  const factories: Preflight["factories"] = [];
  for (const g of GENERATIONS) {
    const args = { address: g.factory, abi: FACTORY_READS, blockNumber: BigInt(head.number) };
    const launchCount = Number(await withRetry(() => rpc.readContract({ ...args, functionName: "launchCount" }), "factory launchCount"));
    const graduationAdapter = await withRetry(() => rpc.readContract({ ...args, functionName: "graduationAdapter" }), "factory adapter");
    const protocolTreasury = await withRetry(() => rpc.readContract({ ...args, functionName: "protocolTreasury" }), "factory treasury");
    requireValue(graduationAdapter.toLowerCase() === g.graduationAdapter?.toLowerCase() && protocolTreasury.toLowerCase() === g.protocolTreasury?.toLowerCase(), `onchain ${g.generation} configuration changed`);
    const code = await withRetry(() => rpc.getCode({ address: g.factory, blockNumber: BigInt(head.number) }), "factory bytecode");
    requireValue(code && code !== "0x", "factory missing bytecode");
    factories.push({ factory: g.factory, generation: g.generation, launchCount, graduationAdapter, protocolTreasury, runtimeHash: keccak256(code) });
  }
  const result: Preflight = { schemaVersion: 1, chainId: 46630, startedAt: previous?.startedAt ?? startedAt, head, headObservedAt, prefixHead, prefixAnchor, factories,
    prefixManifestSha256: sha256(fs.readFileSync(path.join(PREFIX, "participants-input-manifest.json"))),
    prefixParticipantSha256: sha256(fs.readFileSync(path.join(PREFIX, "participants.json"))), operatorConfig, operatorConfigCheckedAt, configurationChanges: changes };
  if (previous) {
    const oldBytes = fs.readFileSync(file);
    result.priorTargets = [...(previous.priorTargets ?? []), { head: previous.head, checkedCanonicalHash: previous.head.hash, preflightSha256: sha256(oldBytes) }];
    const archived = path.join(DIR, `preflight-${previous.head.number}.json`);
    if (!fs.existsSync(archived)) fs.writeFileSync(archived, oldBytes, { flag: "wx" });
    fs.writeFileSync(file, json(result));
  } else write(file, result);
  console.log(json({ status: "preflight-verified", oldHead: prefixHead.number, head, factories, configurationChanges: changes }));
  return result;
}

async function scan(surface: LogSurface, p: Preflight): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  const cacheDir = path.join(DIR, surface);
  const existing = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter(file => !file.endsWith(".tmp")).map(file => parseChunkRange(file)).sort((a,b) => a.fromBlock - b.fromBlock) : [];
  if (existing.length) assertCompleteCoverage(existing, FROM, existing[existing.length - 1].toBlock);
  const byStart = new Map(existing.map(c => [c.fromBlock, c]));
  let cursor = FROM, span = 20_000;
  while (cursor <= p.head.number) {
    const end = byStart.get(cursor)?.toBlock ?? Math.min(cursor + span - 1, p.head.number);
    requireValue(end <= p.head.number, "cached chunk exceeds pinned head");
    const chunk: ChunkRange = { fromBlock: cursor, toBlock: end, file: `${surface}/${cursor}-${end}.json` };
    const file = path.join(DIR, chunk.file);
    let logs: RawLog[];
    if (fs.existsSync(file)) logs = read<RawLog[]>(file).map(v => validateRawLog(v, chunk, surface));
    else {
      try {
        // Raw wire query, then strict decode EVERY result. No decoder filtering,
        // no address filter: unknown launch emitters cannot disappear silently.
        const wire = await withRetry(() => rpc.request({ method: "eth_getLogs", params: [{
          fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}`,
          topics: [EVENTS[surface].map(e => toEventSelector(e))],
        }] }), `delta ${surface} ${cursor}-${end}`);
        requireValue(wire.length < 10_000, "possible RPC result truncation at 10000 logs");
        logs = wire.map(log => {
          requireValue(!log.removed && log.blockNumber && log.logIndex, "removed or pending log");
          const decoded = decodeEventLog({ abi: EVENTS[surface], data: log.data, topics: log.topics, strict: true });
          return validateRawLog({ ...log, blockNumber: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)), ...decoded }, chunk, surface);
        }).sort((a,b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      } catch (error) {
        if ((isRangeError(error) || String(error).includes("truncation")) && span > 500) { span = Math.max(500, Math.floor(span / 2)); continue; }
        throw error;
      }
      write(file, logs);
    }
    if (surface === "factory") for (const log of logs) {
      if (log.eventName === "LaunchFeesClaimed") continue;
      requireValue(FACTORY_BY_ADDRESS.has(log.address), `unknown launch emitter ${log.address}; stop before curve scan/publication for independent factory review`);
    }
    chunks.push({ ...chunk, surface, sha256: sha256(fs.readFileSync(file)), rows: logs.length });
    cursor = end + 1;
    if (chunks.length % 10 === 0 || cursor > p.head.number) console.log(`${surface}: ${cursor - FROM}/${p.head.number - FROM + 1} blocks, ${chunks.length} complete chunks`);
  }
  assertCompleteCoverage(chunks, FROM, p.head.number);
  return chunks;
}
async function fetchDelta(refreshHead: boolean) {
  const p = await preflight(refreshHead);
  requireValue(!fs.existsSync(path.join(DIR, "delta-manifest.json")), "delta already frozen; use offline replay");
  const factory = await scan("factory", p);
  // Validate the complete launch delta BEFORE requesting any curve activity.
  const curveSet = new Set<string>(), keys = new Set<string>(), launchSeen = new EventDeduplicator();
  const byGeneration = new Map<string, number>();
  for (const chunk of factory) for (const log of read<RawLog[]>(path.join(DIR, chunk.file))) {
    if (!launchSeen.add(log)) continue;
    const launch = decodeLaunchLog(log); if (!launch) continue;
    requireValue(!curveSet.has(launch.curve) && !keys.has(launch.key), "duplicate delta launch/curve identity");
    curveSet.add(launch.curve); keys.add(launch.key);
    byGeneration.set(launch.generation, (byGeneration.get(launch.generation) ?? 0) + 1);
  }
  const oldCounts: Record<string, number> = { retired: 14800, legacy: 43220, current: 39713 };
  for (const g of p.factories) requireValue(g.launchCount === oldCounts[g.generation] + (byGeneration.get(g.generation) ?? 0), `delta ${g.generation} launch count differs from pinned onchain counter`);
  console.log(`Complete launch delta validated: ${keys.size} new projects/curves. Scanning curve topics across all addresses.`);
  const curve = await scan("curve", p);
  const afterHeadHash = (await header(p.head.number)).hash;
  const afterPrefixHash = (await header(p.prefixAnchor.blockNumber)).hash;
  requireValue(afterHeadHash === p.head.hash && afterPrefixHash === p.prefixAnchor.storedHash, "canonical anchor changed during scan");
  const rawEventCounts: Record<string, number> = {};
  for (const chunk of [...factory, ...curve]) for (const log of read<RawLog[]>(path.join(DIR, chunk.file))) rawEventCounts[log.eventName] = (rawEventCounts[log.eventName] ?? 0) + 1;
  write(path.join(DIR, "delta-manifest.json"), { schemaVersion: 1, preflight: p, fromBlock: FROM, toBlock: p.head.number,
    chunks: [...factory, ...curve], finishedAt: new Date().toISOString(), afterHeadHash, afterPrefixHash, rawEventCounts, unknownLaunchEmitters: [] } satisfies DeltaManifest);
  console.log(json({ status: "delta-frozen", head: p.head.number, rawEventCounts }));
}

function* deltaLogs(manifest: DeltaManifest, surface: LogSurface) {
  const chunks = manifest.chunks.filter(c => c.surface === surface);
  assertCompleteCoverage(chunks, FROM, manifest.toBlock);
  for (const chunk of chunks) {
    const bytes = fs.readFileSync(path.join(DIR, chunk.file));
    requireValue(sha256(bytes) === chunk.sha256, `delta hash mismatch ${chunk.file}`);
    const rows = JSON.parse(bytes.toString("utf8"));
    requireValue(Array.isArray(rows) && rows.length === chunk.rows, "delta chunk row mismatch");
    for (const row of rows) yield validateRawLog(row, chunk, surface);
  }
}

async function replay(sourceDir: string) {
  const manifestBytes = fs.readFileSync(path.join(DIR, "delta-manifest.json"));
  const m: DeltaManifest = JSON.parse(manifestBytes.toString("utf8"));
  const p = m.preflight;
  const oldManifestBytes = fs.readFileSync(path.join(PREFIX, "participants-input-manifest.json"));
  const oldParticipantBytes = fs.readFileSync(path.join(PREFIX, "participants.json"));
  requireValue(sha256(oldManifestBytes) === p.prefixManifestSha256 && sha256(oldParticipantBytes) === p.prefixParticipantSha256, "published historical prefix changed");
  requireValue(p.prefixManifestSha256 === PREFIX_MANIFEST_SHA && p.prefixParticipantSha256 === PREFIX_PARTICIPANT_SHA, "historical publication pins changed");
  const deltaLaunches: LaunchRecord[] = [];
  const launchSeen = new EventDeduplicator();
  for (const log of deltaLogs(m, "factory")) {
    if (!launchSeen.add(log)) continue;
    requireValue(log.eventName === "LaunchFeesClaimed" || FACTORY_BY_ADDRESS.has(log.address), "unconfigured launch emitter");
    const launch = decodeLaunchLog(log); if (launch) deltaLaunches.push(launch);
  }
  let accumulator: ParticipantAccumulator | undefined;
  let allLaunches: LaunchRecord[] = [];
  const fullScope = { fromBlock: AUTHORITATIVE_RUN.fromBlock, toBlock: p.head.number, isFullHistory: true };
  const prefix = await replayParticipants(["--source-dir", sourceDir], { publish: false,
    onLaunches(old) {
      allLaunches = [...old, ...deltaLaunches];
      accumulator = createParticipantAccumulator({ launches: allLaunches, launchScan: fullScope, curveScan: fullScope, headBlock: p.head.number, earliestDeploymentBlock: AUTHORITATIVE_RUN.fromBlock });
    }, onTrade(trade) { accumulator!.addTrade(trade); },
  });
  requireValue(prefix && accumulator, "missing validated prefix");
  const frozen = JSON.parse(oldParticipantBytes.toString("utf8"));
  for (const [key, value] of Object.entries(prefix.artifact)) if (typeof value === "number") requireValue(frozen[key] === value, `historical participant ${key} changed`);
  const originalManifest = JSON.parse(oldManifestBytes.toString("utf8"));
  requireValue(json(prefix.inputs) === json(originalManifest.inputs), "historical cache inputs do not match the preserved hashed manifest");
  const evidence = { prefix: { sourceRun: prefix.artifact.sourceRun, counts: prefix.counts, inputManifestSha256: p.prefixManifestSha256 }, headBlock: p.head.number,
    delta: { fromBlock: m.fromBlock, toBlock: m.toBlock, factoryChunks: m.chunks.filter(c => c.surface === "factory"), curveChunks: m.chunks.filter(c => c.surface === "curve") },
    anchors: { prefix: { ...p.prefixAnchor, afterHash: m.afterPrefixHash }, head: { blockNumber: p.head.number, beforeHash: p.head.hash, afterHash: m.afterHeadHash } },
    factories: p.factories.map(g => ({ ...g, launchIds: allLaunches.filter(l => l.generation === g.generation).map(l => l.launchId) })), unknownLaunchEmitters: m.unknownLaunchEmitters };
  assertIncrementalEvidence(evidence);
  const actualRawCounts: Record<string, number> = {};
  for (const surface of ["factory", "curve"] as const) for (const log of deltaLogs(m, surface)) {
    actualRawCounts[log.eventName] = (actualRawCounts[log.eventName] ?? 0) + 1;
  }
  for (const event of new Set([...Object.keys(actualRawCounts), ...Object.keys(m.rawEventCounts)]))
    requireValue(actualRawCounts[event] === m.rawEventCounts[event], `raw delta ${event} count mismatch`);
  const curveToToken = new Map<string, Address>(), curveToLaunch = new Map<string, LaunchRecord>(), tokenSet = new Set<string>();
  for (const launch of allLaunches) {
    requireValue(!curveToToken.has(launch.curve) && !tokenSet.has(launch.token), "duplicate full-history curve/token");
    curveToToken.set(launch.curve, launch.token); curveToLaunch.set(launch.curve, launch); tokenSet.add(launch.token);
  }
  const deltaTx = { launch: new Set<string>(), trade: new Set<string>(), lifecycle: new Set<string>() };
  for (const log of deltaLogs(m, "factory")) if (prefix.seen.add(log)) {
    const launch = decodeLaunchLog(log); if (launch) deltaTx.launch.add(launch.deploymentTxHash.toLowerCase());
  }
  let buyEvents = 0, sellEvents = 0, lifecycleEvents = 0, foreignCurveLogs = 0, eventsFromNewCurves = 0;
  const foreignAddresses = new Set<string>(), newCurves = new Set(deltaLaunches.map(l => l.curve)), lifecycleByKind: Record<string, number> = {};
  for (const log of deltaLogs(m, "curve")) {
    if (!prefix.seen.add(log)) continue;
    const decoded = decodeCurveLog(log, curveToToken);
    if (decoded.foreign) { foreignCurveLogs++; foreignAddresses.add(log.address); continue; }
    requireValue(log.blockNumber >= curveToLaunch.get(log.address)!.deploymentBlock, "curve event precedes launch block");
    if (newCurves.has(log.address)) eventsFromNewCurves++;
    if (decoded.trade) {
      if (decoded.trade.side === "buy") buyEvents++; else sellEvents++;
      deltaTx.trade.add(decoded.trade.txHash.toLowerCase()); accumulator.addTrade(decoded.trade);
    } else if (decoded.lifecycle) {
      lifecycleEvents++; deltaTx.lifecycle.add(decoded.lifecycle.txHash.toLowerCase());
      lifecycleByKind[decoded.lifecycle.kind] = (lifecycleByKind[decoded.lifecycle.kind] ?? 0) + 1;
    } else throw new Error("unhandled known-curve event");
  }
  const transactionCounts = (sets: typeof deltaTx) => {
    const union = new Set([...sets.launch, ...sets.trade, ...sets.lifecycle]);
    return { uniqueTransactionCount: union.size, launchTransactionCount: sets.launch.size, tradeTransactionCount: sets.trade.size, lifecycleTransactionCount: sets.lifecycle.size,
      sharedAcrossCategories: sets.launch.size + sets.trade.size + sets.lifecycle.size - union.size, unusableTransactionHashes: 0 };
  };
  const delta: ReconciliationCounts = { launchRecords: deltaLaunches.length, buyEvents, sellEvents, lifecycleEvents, foreignCurveLogs, ...transactionCounts(deltaTx) };
  const global = { launch: prefix.launchTransactions, trade: prefix.tradeTransactions, lifecycle: prefix.lifecycleTransactions };
  const oldTxUnion = new Set([...global.launch, ...global.trade, ...global.lifecycle]);
  for (const role of ["launch", "trade", "lifecycle"] as const) for (const hash of deltaTx[role]) {
    requireValue(!oldTxUnion.has(hash), "transaction occurs in both historical prefix and disjoint delta"); global[role].add(hash);
  }
  const counts: ReconciliationCounts = { launchRecords: allLaunches.length, buyEvents: prefix.counts.buyEvents + buyEvents, sellEvents: prefix.counts.sellEvents + sellEvents,
    lifecycleEvents: prefix.counts.lifecycleEvents + lifecycleEvents, foreignCurveLogs: prefix.counts.foreignCurveLogs + foreignCurveLogs, ...transactionCounts(global) };
  for (const key of Object.keys(counts) as (keyof ReconciliationCounts)[]) requireValue(counts[key] === prefix.counts[key] + delta[key], `disjoint prefix/delta ${key} reconciliation failed`);
  const sourceRun = { chainId: p.chainId, headBlock: p.head.number, headBlockHash: p.head.hash, startedAt: p.startedAt, finishedAt: m.finishedAt };
  const directory = path.join(ROOT, "sample-output", `current-${p.head.number}`);
  const proof = { schemaVersion: 1, sourceRun, sourceRunStartBlock: AUTHORITATIVE_RUN.fromBlock, prefix: evidence.prefix,
    prefixParticipantSha256: p.prefixParticipantSha256, delta: { fromBlock: FROM, toBlock: p.head.number, counts: delta, lifecycleByKind, eventsFromNewCurves, newCurves: newCurves.size, foreignAddresses: [...foreignAddresses].sort() },
    anchors: evidence.anchors, head: p.head, headObservedAt: p.headObservedAt, priorTargets: p.priorTargets ?? [], prefixHead: p.prefixHead,
    recoveryIncidents: fs.existsSync(path.join(DIR, "recovery-incidents.json")) ? read<unknown[]>(path.join(DIR, "recovery-incidents.json")) : [],
    configuredFactories: p.factories, configurationChanges: p.configurationChanges, operatorConfigCheckedAt: p.operatorConfigCheckedAt,
    operatorConfigSha256: sha256(json(p.operatorConfig)), operatorDeploymentVersion: p.operatorConfig.data.deploymentVersion,
    unknownLaunchEmitters: m.unknownLaunchEmitters, rawEventCounts: actualRawCounts, duplicateEventsRemoved: prefix.seen.duplicates,
    coverageComplete: true, prefixReconciled: true, deltaValidated: true, counts,
    checks: ["immutable prefix manifest and participant totals", "exact historical event and transaction reconciliation", "canonical prefix/head anchors unchanged", "gap-free factory and curve delta chunks", "topic-only launch discovery has no unconfigured emitter", "dense per-factory IDs equal pinned onchain launchCount", "new curves included before curve attribution", "strict raw log decoding and stable identity deduplication", "disjoint transaction sets and global union", "participant role unions and diagnostics"],
    limitations: ["Factory discovery remains bounded to published configuration and known launch event signatures; no canonical factory registry exists.", "Current-head snapshot is pinned to the observed block hash, not a claim of finality or a continuously updating feed.", "The preserved latest event hash anchors block " + p.prefixAnchor.blockNumber + "; the old-head header was observed during this advancement, not stored by the September 18 run. Its event-free suffix is inherited from that validated run.", "Factory runtime hashes were captured at the new head; no historical runtime-hash comparison is claimed.", "Fee/graduation economics retain their earlier verification dates; no burn scan or project state enrichment was run."] };
  const proofText = json(proof);
  const inputManifest = { schemaVersion: 1, sourceRun, prefixManifestSha256: p.prefixManifestSha256, deltaManifestSha256: sha256(manifestBytes),
    prefixInputs: prefix.inputs, deltaInputs: m.chunks, deltaPreflight: p, anchors: evidence.anchors, counts, coverageComplete: true };
  const inputText = json(inputManifest);
  const artifact = createParticipantArtifact({ summary: accumulator.finish(), sourceRun, validation: {
    method: "incremental-cache-replay", coverageComplete: true, reconciled: true, counts,
    inputManifest: "participants-input-manifest.json", inputManifestSha256: sha256(inputText),
    incremental: { prefixHeadBlock: AUTHORITATIVE_RUN.headBlock, deltaFromBlock: FROM, deltaToBlock: p.head.number, prefixManifestSha256: p.prefixManifestSha256,
      deltaManifestSha256: sha256(manifestBytes), proofFile: "incremental-proof.json", proofSha256: sha256(proofText) },
  }, generatedAt: fs.existsSync(path.join(directory, "participants.json"))
    ? read<{ derivedAt: string }>(path.join(directory, "participants.json")).derivedAt : undefined });
  const artifactText = json(artifact);
  const overview = { schemaVersion: 1, sourceRun, sourceRunStartBlock: AUTHORITATIVE_RUN.fromBlock, counts,
    generations: GENERATIONS.map(g => { const launches = allLaunches.filter(l => l.generation === g.generation); return {
      generation: g.generation, factory: g.factory, launchCount: launches.length, deltaLaunchCount: deltaLaunches.filter(l => l.generation === g.generation).length,
      lastObservedLaunchBlock: launches.reduce((max, l) => Math.max(max, l.deploymentBlock), 0), launchIdAudit: { min: 0, max: launches.length - 1, dense: true, duplicateIds: 0 } }; }),
    foreignCurveAddressCount: new Set([...prefix.foreignAddresses, ...foreignAddresses]).size,
    deltaForeignCurveAddressCount: foreignAddresses.size, participantSha256: sha256(artifactText), proofSha256: sha256(proofText),
    checks: { passed: proof.checks.length, total: proof.checks.length } };
  // Every integrity gate above must pass before ANY fresh public output exists.
  const outputs = { "incremental-proof.json": proof, "participants-input-manifest.json": inputManifest,
    "participants.json": artifact, "overview.json": overview };
  if (fs.existsSync(directory)) {
    for (const [name, content] of Object.entries(outputs)) requireValue(fs.readFileSync(path.join(directory, name), "utf8") === json(content), `offline reproduction mismatch ${name}`);
    console.log("Existing incremental snapshot reproduced byte-for-byte offline; no files changed.");
  } else {
    // Stage outside the public directory; a failure cannot publish half a snapshot.
    const staging = fs.mkdtempSync(path.join(DIR, "publication-"));
    for (const [name, content] of Object.entries(outputs)) write(path.join(staging, name), content);
    fs.renameSync(staging, directory);
  }
  console.log(json({ status: "incremental-snapshot-validated", directory, delta, counts, participantCounts: accumulator.finish().counts, generations: overview.generations }));
}

export async function advanceSnapshot(args = process.argv.slice(2)) {
  let sourceDir = ROOT, fetch = false, refreshHead = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") fetch = true;
    else if (args[i] === "--refresh-head") refreshHead = true;
    else if (args[i] === "--source-dir" && args[i+1]) sourceDir = path.resolve(args[++i]);
    else throw new Error(`Unknown/incomplete argument ${args[i]}`);
  }
  requireValue(!refreshHead || fetch, "--refresh-head requires --fetch");
  if (fetch) await fetchDelta(refreshHead); else await replay(sourceDir);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) advanceSnapshot().catch(error => {
  console.error(scrubCredentials(error instanceof Error ? error.message : String(error))); process.exitCode = 1;
});
