import { test } from "node:test";
import assert from "node:assert/strict";
import { createParticipantAccumulator } from "../src/derive/participants.js";
import { createParticipantArtifact, type ParticipantSourceRun, type ParticipantValidation } from "../src/derive/participantArtifact.js";
import { AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS } from "../src/derive/participantSource.js";

const START = 95_916_239, HEAD = 121_309_770;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function fixture() {
  const summary = createParticipantAccumulator({
    launches: [{ key: "current:0", factory: a(1), curve: a(2), creator: a(3), deploymentBlock: START }],
    launchScan: { fromBlock: START, toBlock: HEAD, isFullHistory: true },
    curveScan: { fromBlock: START, toBlock: HEAD, isFullHistory: true },
    headBlock: HEAD, earliestDeploymentBlock: START,
  }).finish();
  const sourceRun: ParticipantSourceRun = {
    chainId: 46630, headBlock: HEAD,
    startedAt: "2026-09-18T16:27:46.209Z", finishedAt: "2026-09-18T17:00:25.492Z",
  };
  const validation: ParticipantValidation = { coverageComplete: true, reconciled: true, method: "indexed-run", counts: {
    launchRecords: 1, buyEvents: 0, sellEvents: 0, lifecycleEvents: 0, foreignCurveLogs: 0,
    uniqueTransactionCount: 1, launchTransactionCount: 1, tradeTransactionCount: 0,
    lifecycleTransactionCount: 0, sharedAcrossCategories: 0, unusableTransactionHashes: 0,
  } };
  return { summary, sourceRun, validation, generatedAt: "2026-09-25T00:00:00.000Z" };
}

test("publication maps both derived unions and preserves original versus derivation timestamps", () => {
  const input = fixture();
  const artifact = createParticipantArtifact(input);
  assert.equal(artifact.indexedActorAddressCount, 1);
  assert.equal(artifact.indexedParticipantAddressCount, 1);
  assert.equal(artifact.multiProjectActorAddressCount, 0);
  assert.equal(artifact.sourceRun.finishedAt, input.sourceRun.finishedAt);
  assert.equal(artifact.derivedAt, input.generatedAt);
  assert.equal(artifact.sourceRunStartBlock, START);
  assert.ok(!("addresses" in artifact), "public output is aggregate only");
});

test("publication rejects missing coverage or reconciliation", () => {
  for (const flag of ["coverageComplete", "reconciled"] as const) {
    const input = fixture(); input.validation[flag] = false;
    assert.throws(() => createParticipantArtifact(input), /unreconciled coverage/);
  }
});

test("publication rejects windowed or contradictory full-history ranges", () => {
  const input = fixture(); input.summary.curveScan.isFullHistory = false;
  assert.throws(() => createParticipantArtifact(input), /windowed/);
  const late = fixture(); late.summary.curveScan.fromBlock++;
  assert.throws(() => createParticipantArtifact(late), /windowed/);
});

test("publication rejects chain, head and timestamp provenance mismatches", () => {
  const chain = fixture(); chain.sourceRun.chainId = 1;
  assert.throws(() => createParticipantArtifact(chain), /chain/);
  const head = fixture(); head.sourceRun.headBlock++;
  assert.throws(() => createParticipantArtifact(head), /head/);
  const date = fixture(); date.sourceRun.finishedAt = "invalid";
  assert.throws(() => createParticipantArtifact(date), /timestamps/);
  const before = fixture(); before.generatedAt = "2026-09-17T00:00:00Z";
  assert.throws(() => createParticipantArtifact(before), /precedes/);
});

test("publication rejects rejected addresses, unassigned curves and unusable transaction hashes", () => {
  for (const field of ["unusableAddressValues", "unmappedTradeEvents"] as const) {
    const input = fixture(); input.summary.integrity[field]++;
    assert.throws(() => createParticipantArtifact(input), /unusable values/);
  }
  const hashes = fixture(); hashes.validation.counts.unusableTransactionHashes++;
  assert.throws(() => createParticipantArtifact(hashes), /unusable values/);
});

test("publication rejects inconsistent records and unions", () => {
  const records = fixture(); records.validation.counts.launchRecords++;
  assert.throws(() => createParticipantArtifact(records), /input records/);
  const txs = fixture(); txs.validation.counts.uniqueTransactionCount++;
  assert.throws(() => createParticipantArtifact(txs), /transaction union/);
  const participants = fixture(); participants.summary.counts.participantAddressCount++;
  assert.throws(() => createParticipantArtifact(participants), /set counts/);
});

test("frozen replay requires a hashed input manifest", () => {
  const input = fixture(); input.validation.method = "frozen-cache-replay";
  assert.throws(() => createParticipantArtifact(input), /hashed input manifest/);
  input.validation.inputManifest = "participants-input-manifest.json";
  input.validation.inputManifestSha256 = "a".repeat(64);
  assert.throws(() => createParticipantArtifact(input), /provenance mismatch/);
  input.sourceRun.headBlock = AUTHORITATIVE_RUN.headBlock;
  input.summary.launchScan.toBlock = input.summary.curveScan.toBlock = AUTHORITATIVE_RUN.headBlock;
  assert.throws(() => createParticipantArtifact(input), /reconciliation mismatch/);
  input.validation.counts = { ...AUTHORITATIVE_COUNTS };
  input.summary.integrity.launchRecords = AUTHORITATIVE_COUNTS.launchRecords;
  input.summary.integrity.tradeRecords = AUTHORITATIVE_COUNTS.buyEvents + AUTHORITATIVE_COUNTS.sellEvents;
  assert.equal(createParticipantArtifact(input).validation.method, "frozen-cache-replay");
});

test("validated artifact is isolated from subsequent input mutation", () => {
  const input = fixture();
  const artifact = createParticipantArtifact(input);
  input.summary.curveScan.toBlock++;
  input.summary.integrity.rejectedByRole["Bought.buyer"]++;
  input.validation.counts.launchRecords++;
  assert.equal(artifact.curveScan.toBlock, HEAD);
  assert.equal(artifact.integrity.rejectedByRole["Bought.buyer"], 0);
  assert.equal(artifact.validation.counts.launchRecords, 1);
});

test("arithmetic equality cannot excuse overlaps larger than their component sets", () => {
  const input = fixture();
  input.summary.counts.creatorAddressCount = 3;
  input.summary.counts.tradeActorAddressCount = 2;
  input.summary.counts.tradeParticipantAddressCount = 2;
  input.summary.counts.creatorTraderOverlapCount = 5;
  input.summary.counts.creatorTradeParticipantOverlapCount = 5;
  input.summary.counts.actorAddressCount = 0;
  input.summary.counts.participantAddressCount = 0;
  assert.throws(() => createParticipantArtifact(input), /set counts/);
});

function incrementalFixture() {
  const input = fixture();
  input.sourceRun.headBlockHash = "0x" + "1".repeat(64);
  input.sourceRun.startedAt = "2026-09-25T00:00:00.000Z";
  input.sourceRun.finishedAt = "2026-09-25T01:00:00.000Z";
  input.generatedAt = "2026-09-25T02:00:00.000Z";
  input.validation = {
    ...input.validation, method: "incremental-cache-replay", counts: { ...AUTHORITATIVE_COUNTS },
    inputManifest: "participants-input-manifest.json", inputManifestSha256: "a".repeat(64),
    incremental: {
      prefixHeadBlock: AUTHORITATIVE_RUN.headBlock, deltaFromBlock: AUTHORITATIVE_RUN.headBlock + 1, deltaToBlock: HEAD,
      prefixManifestSha256: "b".repeat(64), deltaManifestSha256: "c".repeat(64),
      proofFile: "incremental-proof.json", proofSha256: "d".repeat(64),
    },
  };
  input.summary.integrity.launchRecords = AUTHORITATIVE_COUNTS.launchRecords;
  input.summary.integrity.tradeRecords = AUTHORITATIVE_COUNTS.buyEvents + AUTHORITATIVE_COUNTS.sellEvents;
  return input;
}

test("incremental publication preserves the adjacent delta, hashed lineage and fresh source timestamps", () => {
  const input = incrementalFixture();
  const artifact = createParticipantArtifact(input);
  assert.equal(artifact.validation.method, "incremental-cache-replay");
  assert.deepEqual(artifact.validation.incremental, input.validation.incremental);
  assert.equal(artifact.sourceRunHeadBlock, HEAD);
  assert.equal(artifact.sourceRunStartBlock, START);
  assert.equal(artifact.sourceRun.startedAt, "2026-09-25T00:00:00.000Z");
  input.validation.incremental!.proofSha256 = "e".repeat(64);
  assert.equal(artifact.validation.incremental!.proofSha256, "d".repeat(64));
});

test("incremental publication requires a hashed manifest independently from its proof", () => {
  for (const change of [
    { inputManifest: undefined }, { inputManifest: "" }, { inputManifestSha256: undefined },
    { inputManifestSha256: "not-a-digest" }, { inputManifestSha256: "a".repeat(63) },
  ]) {
    const input = incrementalFixture();
    Object.assign(input.validation, change);
    assert.throws(() => createParticipantArtifact(input), /hashed input manifest/);
  }
});

test("incremental publication requires a well-formed pinned head hash", () => {
  const input = incrementalFixture();
  delete input.sourceRun.headBlockHash;
  assert.throws(() => createParticipantArtifact(input), /head block hash/);
  input.sourceRun.headBlockHash = "invalid";
  assert.throws(() => createParticipantArtifact(input), /head block hash/);
});

test("incremental publication rejects missing, discontinuous or unanchored lineage", () => {
  const absent = incrementalFixture();
  delete absent.validation.incremental;
  assert.throws(() => createParticipantArtifact(absent), /contiguous prefix\/delta provenance/);
  for (const change of [
    { prefixHeadBlock: AUTHORITATIVE_RUN.headBlock - 1 },
    { deltaFromBlock: AUTHORITATIVE_RUN.headBlock },
    { deltaFromBlock: AUTHORITATIVE_RUN.headBlock + 2 },
    { deltaToBlock: HEAD - 1 }, { deltaToBlock: HEAD + 1 },
    { proofFile: "" }, { prefixManifestSha256: "" },
    { deltaManifestSha256: "unchecked" }, { proofSha256: "d".repeat(63) },
  ]) {
    const input = incrementalFixture();
    Object.assign(input.validation.incremental!, change);
    assert.throws(() => createParticipantArtifact(input), /contiguous prefix\/delta provenance/);
  }
  const noAdvance = incrementalFixture();
  noAdvance.sourceRun.headBlock = AUTHORITATIVE_RUN.headBlock;
  noAdvance.summary.launchScan.toBlock = noAdvance.summary.curveScan.toBlock = AUTHORITATIVE_RUN.headBlock;
  noAdvance.validation.incremental!.deltaToBlock = AUTHORITATIVE_RUN.headBlock;
  assert.throws(() => createParticipantArtifact(noAdvance), /contiguous prefix\/delta provenance/);
});

test("incremental method cannot bypass existing coverage, union or diagnostics gates", () => {
  const windowed = incrementalFixture(); windowed.summary.curveScan.isFullHistory = false;
  assert.throws(() => createParticipantArtifact(windowed), /windowed/);
  const unreconciled = incrementalFixture(); unreconciled.validation.reconciled = false;
  assert.throws(() => createParticipantArtifact(unreconciled), /unreconciled coverage/);
  const omittedPrefix = incrementalFixture(); omittedPrefix.summary.launchScan.fromBlock = AUTHORITATIVE_RUN.headBlock + 1;
  assert.throws(() => createParticipantArtifact(omittedPrefix), /incomplete/);
  const txUnion = incrementalFixture(); txUnion.validation.counts.uniqueTransactionCount++;
  assert.throws(() => createParticipantArtifact(txUnion), /transaction union/);
  const invalidAddress = incrementalFixture(); invalidAddress.summary.integrity.unusableAddressValues++;
  assert.throws(() => createParticipantArtifact(invalidAddress), /unusable values/);
  const unknownProject = incrementalFixture(); unknownProject.summary.integrity.unmappedTradeEvents++;
  assert.throws(() => createParticipantArtifact(unknownProject), /unassigned project/);
});

test("incremental publication cannot regress any nonzero historical event or transaction count", () => {
  for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
    if (AUTHORITATIVE_COUNTS[key] === 0) continue;
    const input = incrementalFixture();
    const counts = input.validation.counts;
    counts[key]--;
    input.summary.integrity.launchRecords = counts.launchRecords;
    input.summary.integrity.tradeRecords = counts.buyEvents + counts.sellEvents;
    if (key === "sharedAcrossCategories") {
      counts.uniqueTransactionCount = counts.launchTransactionCount + counts.tradeTransactionCount + counts.lifecycleTransactionCount - counts.sharedAcrossCategories;
    } else {
      counts.sharedAcrossCategories = counts.launchTransactionCount + counts.tradeTransactionCount + counts.lifecycleTransactionCount - counts.uniqueTransactionCount;
    }
    assert.throws(() => createParticipantArtifact(input), /Incremental historical count regression/);
  }
});

test("new incremental method leaves the frozen baseline exactness requirement intact", () => {
  const input = incrementalFixture();
  input.validation.method = "frozen-cache-replay";
  assert.throws(() => createParticipantArtifact(input), /Authoritative source provenance mismatch/);
});
