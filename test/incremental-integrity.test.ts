import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERATIONS } from "../config/factories.js";
import { assertIncrementalEvidence, type IncrementalEvidence } from "../src/derive/incrementalIntegrity.js";
import { AUTHORITATIVE_COUNTS, AUTHORITATIVE_RUN } from "../src/derive/participantSource.js";
import { decodeCurveLog, decodeLaunchLog } from "../src/stages/decode.js";
import { createParticipantAccumulator } from "../src/derive/participants.js";
import type { RawLog } from "../src/lib/logscan.js";
import type { Address } from "viem";

const hash = `0x${"a".repeat(64)}`;
const otherHash = `0x${"b".repeat(64)}`;
const fromBlock = AUTHORITATIVE_RUN.headBlock + 1;
const headBlock = fromBlock + 99;
const prefixCounts: Record<string, number> = { retired: 14_800, legacy: 43_220, current: 39_713 };
function valid(): IncrementalEvidence {
  const chunks = [{ fromBlock, toBlock: fromBlock + 49 }, { fromBlock: fromBlock + 50, toBlock: headBlock }];
  return {
    prefix: {
      sourceRun: {
        chainId: AUTHORITATIVE_RUN.chainId, headBlock: AUTHORITATIVE_RUN.headBlock,
        startedAt: AUTHORITATIVE_RUN.startedAt, finishedAt: AUTHORITATIVE_RUN.finishedAt,
      },
      counts: { ...AUTHORITATIVE_COUNTS }, inputManifestSha256: "c".repeat(64),
    },
    headBlock,
    delta: { fromBlock, toBlock: headBlock, factoryChunks: chunks.map(c => ({ ...c })), curveChunks: chunks.map(c => ({ ...c })) },
    anchors: {
      prefix: { blockNumber: AUTHORITATIVE_RUN.headBlock - 1, storedHash: hash, beforeHash: hash, afterHash: hash },
      head: { blockNumber: headBlock, beforeHash: otherHash, afterHash: otherHash },
    },
    factories: GENERATIONS.map(generation => ({
      factory: generation.factory, generation: generation.generation,
      launchCount: prefixCounts[generation.generation] + 1,
      launchIds: Array.from({ length: prefixCounts[generation.generation] + 1 }, (_, id) => String(id)),
    })),
    unknownLaunchEmitters: [],
  };
}

test("incremental gate accepts independently complete delta surfaces and factory-scoped IDs", () => {
  const evidence = valid();
  evidence.delta.factoryChunks = [...evidence.delta.factoryChunks].reverse();
  evidence.anchors.prefix.beforeHash = `0x${"A".repeat(64)}`;
  assert.doesNotThrow(() => assertIncrementalEvidence(evidence));
});

test("incremental gate requires every frozen prefix count and provenance field unchanged", () => {
  for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
    const evidence = valid();
    evidence.prefix.counts = { ...evidence.prefix.counts, [key]: evidence.prefix.counts[key] + 1 };
    assert.throws(() => assertIncrementalEvidence(evidence), new RegExp(`historical count mismatch: ${key}`));
  }
  for (const change of [
    { chainId: 1 }, { headBlock: AUTHORITATIVE_RUN.headBlock - 1 },
    { startedAt: "2026-09-19T00:00:00.000Z" }, { finishedAt: "2026-09-19T00:00:00.000Z" },
  ]) {
    const evidence = valid();
    Object.assign(evidence.prefix.sourceRun, change);
    assert.throws(() => assertIncrementalEvidence(evidence), /historical source mismatch/);
  }
  const evidence = valid();
  evidence.prefix.inputManifestSha256 = "unchecked";
  assert.throws(() => assertIncrementalEvidence(evidence), /manifest digest/);
});

test("incremental gate rejects gaps, overlaps, omitted tip and invalid chunks independently per surface", () => {
  for (const surface of ["factoryChunks", "curveChunks"] as const) {
    for (const chunks of [
      [], [{ fromBlock: fromBlock + 1, toBlock: headBlock }], [{ fromBlock, toBlock: headBlock - 1 }],
      [{ fromBlock, toBlock: headBlock + 1 }], [{ fromBlock, toBlock: fromBlock - 1 }],
      [{ fromBlock, toBlock: fromBlock + 50 }, { fromBlock: fromBlock + 50, toBlock: headBlock }],
      [{ fromBlock: fromBlock + 0.5, toBlock: headBlock }],
    ]) {
      const evidence = valid();
      evidence.delta[surface] = chunks;
      assert.throws(() => assertIncrementalEvidence(evidence), /coverage|chunk bounds/);
    }
  }
});

test("incremental delta cannot overlap, skip or replace the frozen prefix or move its fixed head", () => {
  for (const change of [{ fromBlock: fromBlock - 1 }, { fromBlock: fromBlock + 1 }, { toBlock: headBlock + 1 }]) {
    const evidence = valid();
    Object.assign(evidence.delta, change);
    assert.throws(() => assertIncrementalEvidence(evidence), /delta must immediately follow/);
  }
  for (const head of [AUTHORITATIVE_RUN.headBlock, AUTHORITATIVE_RUN.headBlock - 1, NaN, headBlock + 0.5]) {
    const evidence = valid();
    evidence.headBlock = head;
    assert.throws(() => assertIncrementalEvidence(evidence), /target must advance/);
  }
});

test("incremental gate rejects a reorg of the stored historical anchor or pinned target", () => {
  for (const field of ["beforeHash", "afterHash", "storedHash"] as const) {
    const evidence = valid();
    evidence.anchors.prefix[field] = otherHash;
    assert.throws(() => assertIncrementalEvidence(evidence), /historical canonical hash changed/);
  }
  const evidence = valid();
  evidence.anchors.head.afterHash = hash;
  assert.throws(() => assertIncrementalEvidence(evidence), /target canonical hash changed/);
});

test("incremental anchors must contain usable hashes and refer to their stated coverage", () => {
  for (const invalid of ["0x1234", `0x${"0".repeat(64)}`]) {
    const evidence = valid();
    evidence.anchors.head.afterHash = invalid;
    assert.throws(() => assertIncrementalEvidence(evidence), /invalid block hash/);
  }
  const historical = valid();
  historical.anchors.prefix.blockNumber = AUTHORITATIVE_RUN.tailFromBlock - 1;
  assert.throws(() => assertIncrementalEvidence(historical), /outside the reconciled tail/);
  const target = valid();
  target.anchors.head.blockNumber--;
  assert.throws(() => assertIncrementalEvidence(target), /not the pinned head/);
});

test("incremental discovery cannot silently exclude an unknown launch emitter", () => {
  const evidence = valid();
  evidence.unknownLaunchEmitters = [`0x${"d".repeat(40)}`];
  assert.throws(() => assertIncrementalEvidence(evidence), /unclassified launch emitters/);
});

test("factory verification requires the complete configured set without duplicates or generation swaps", () => {
  const omitted = valid();
  omitted.factories = omitted.factories.slice(1);
  assert.throws(() => assertIncrementalEvidence(omitted), /configured factory set mismatch/);
  const duplicate = valid();
  duplicate.factories = [duplicate.factories[0], duplicate.factories[0], duplicate.factories[2]];
  assert.throws(() => assertIncrementalEvidence(duplicate), /duplicate or mislabelled factory/);
  const unknown = valid();
  unknown.factories[0].factory = `0x${"d".repeat(40)}`;
  assert.throws(() => assertIncrementalEvidence(unknown), /unknown, duplicate or mislabelled factory/);
  const swapped = valid();
  swapped.factories[0].generation = "current";
  assert.throws(() => assertIncrementalEvidence(swapped), /unknown, duplicate or mislabelled factory/);
});

test("factory launchCount must match all reconstructed dense IDs, including the new launch", () => {
  const regressed = valid();
  regressed.factories[0].launchCount = prefixCounts.retired - 1;
  assert.throws(() => assertIncrementalEvidence(regressed), /regressed/);
  const missing = valid();
  missing.factories[0].launchIds = missing.factories[0].launchIds.slice(0, -1);
  assert.throws(() => assertIncrementalEvidence(missing), /differs from indexed/);
  const hole = valid();
  hole.factories[0].launchIds = [...hole.factories[0].launchIds.slice(1), String(hole.factories[0].launchCount)];
  assert.throws(() => assertIncrementalEvidence(hole), /not dense from zero/);
  const duplicate = valid();
  duplicate.factories[0].launchIds = ["0", ...duplicate.factories[0].launchIds.slice(0, -1)];
  assert.throws(() => assertIncrementalEvidence(duplicate), /duplicate launch IDs/);
});

test("merged launch discovery attributes same-delta initial buys and later lifecycle events to new curves", () => {
  const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
  const oldCreator = address("1"), newCreator = address("2"), recipient = address("3");
  const oldCurve = address("4"), newCurve = address("5"), oldToken = address("6"), newToken = address("7");
  const launchLog = (isNew: boolean): RawLog => ({
    blockNumber: isNew ? fromBlock : AUTHORITATIVE_RUN.fromBlock,
    blockHash: hash as RawLog["blockHash"], transactionHash: (isNew ? otherHash : hash) as RawLog["transactionHash"],
    address: GENERATIONS[isNew ? 2 : 0].factory, logIndex: isNew ? 4 : 0, eventName: "TokenLaunched",
    args: {
      launchId: isNew ? "39713" : "0", creator: isNew ? newCreator : oldCreator,
      curve: isNew ? newCurve : oldCurve, token: isNew ? newToken : oldToken,
      creatorFeeRecipient: isNew ? newCreator : oldCreator, creatorVault: address("8"),
      initialBuy: "1", initialTokensBought: "1", metadataSchemaVersion: 0,
      metadataDigest: hash, metadataURI: "",
    },
  });
  const historicalLaunch = decodeLaunchLog(launchLog(false))!;
  const freshLaunch = decodeLaunchLog(launchLog(true))!;
  const bought: RawLog = {
    blockNumber: fromBlock, blockHash: hash as RawLog["blockHash"],
    transactionHash: otherHash as RawLog["transactionHash"], address: newCurve, logIndex: 2, eventName: "Bought",
    args: { buyer: newCreator, recipient, grossEthUsed: "1", curveQuote: "1", tokenAmount: "1", creatorFee: "0", protocolFee: "0" },
  };
  const forwarded: RawLog = {
    ...bought, blockNumber: fromBlock + 1, logIndex: 0, eventName: "CreatorFeesForwarded",
    args: { vault: address("8"), amount: "1" },
  };
  // An initial buy can be emitted before its TokenLaunched log in the same
  // transaction. Discovery is a complete first pass, not a log-order filter.
  assert.ok(bought.logIndex < freshLaunch.logIndex);
  const oldMapping = new Map([[historicalLaunch.curve, historicalLaunch.token]]);
  assert.equal(decodeCurveLog(bought, oldMapping).foreign, true);
  assert.equal(decodeCurveLog(forwarded, oldMapping).foreign, true);
  const allLaunches = [historicalLaunch, freshLaunch];
  const mergedMapping = new Map(allLaunches.map(launch => [launch.curve, launch.token]));
  const trade = decodeCurveLog(bought, mergedMapping);
  const lifecycle = decodeCurveLog(forwarded, mergedMapping);
  assert.equal(trade.foreign, false);
  assert.equal(trade.trade?.token, newToken);
  assert.equal(lifecycle.foreign, false);
  assert.equal(lifecycle.lifecycle?.kind, "CreatorFeesForwarded");
  assert.equal(lifecycle.lifecycle?.token, newToken);
  const scope = { fromBlock: AUTHORITATIVE_RUN.fromBlock, toBlock: headBlock, isFullHistory: true };
  const accumulator = createParticipantAccumulator({
    launches: allLaunches, launchScan: scope, curveScan: scope, headBlock,
    earliestDeploymentBlock: AUTHORITATIVE_RUN.fromBlock,
  });
  accumulator.addTrade(trade.trade!);
  const result = accumulator.finish();
  assert.equal(result.integrity.tradeRecords, 1);
  assert.equal(result.integrity.unmappedTradeEvents, 0);
  assert.equal(result.counts.actorAddressCount, 2);
  assert.equal(result.counts.participantAddressCount, 3);
  assert.equal(result.counts.recipientOnlyAddressCount, 1);
  assert.equal(result.counts.creatorTraderOverlapCount, 1);
});
