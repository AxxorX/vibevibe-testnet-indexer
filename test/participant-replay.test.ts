import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS, EventDeduplicator,
  assertAuthoritativeRun, assertCompleteCoverage, assertDenseLaunchIds,
  assertReconciliation, parseChunkRange, validateRawLog,
} from "../scripts/participant-replay-integrity.js";

const fullRange = { fromBlock: 100, toBlock: 199, file: "100-199.json" };
const address = `0x${"1".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const bought = {
  address, blockNumber: 150, blockHash: hash, transactionHash: hash, logIndex: 1, eventName: "Bought",
  args: { buyer: address, recipient: address, grossEthUsed: "1", curveQuote: "1", tokenAmount: "1", creatorFee: "0", protocolFee: "0" },
};
const sourceRun = {
  chainId: AUTHORITATIVE_RUN.chainId, headBlock: AUTHORITATIVE_RUN.headBlock,
  startedAt: AUTHORITATIVE_RUN.startedAt, finishedAt: AUTHORITATIVE_RUN.finishedAt,
  tradeFromBlock: AUTHORITATIVE_RUN.fromBlock, tradeToBlock: AUTHORITATIVE_RUN.headBlock, tradesAreFullHistory: true,
};

test("replay requires continuous complete coverage including the audited final tail", () => {
  const prefix = { fromBlock: AUTHORITATIVE_RUN.fromBlock, toBlock: AUTHORITATIVE_RUN.cachedThroughBlock, file: "history" };
  const tail = { fromBlock: AUTHORITATIVE_RUN.tailFromBlock, toBlock: AUTHORITATIVE_RUN.headBlock, file: "tail" };
  assert.throws(() => assertCompleteCoverage([prefix], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock), /missing cached range 121296239/);
  assert.doesNotThrow(() => assertCompleteCoverage([tail, prefix], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock));
  assert.throws(() => assertCompleteCoverage([{ ...prefix, toBlock: prefix.toBlock - 1 }, tail], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock), /missing cached range/);
  assert.throws(() => assertCompleteCoverage([prefix, { ...tail, fromBlock: prefix.toBlock }], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock), /overlapping cached range/);
  assert.throws(() => assertCompleteCoverage([prefix, { ...tail, toBlock: tail.toBlock + 1 }], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock), /beyond frozen head/);
  assert.throws(() => assertCompleteCoverage([], AUTHORITATIVE_RUN.fromBlock, AUTHORITATIVE_RUN.headBlock), /missing cached range/);
});

test("chunk filename and interval validation reject invalid or ambiguous cache entries", () => {
  assert.deepEqual(parseChunkRange("100-199.json"), fullRange);
  assert.throws(() => parseChunkRange("head.json"), /unrecognized/);
  assert.throws(() => parseChunkRange("200-100.json"), /invalid chunk range/);
  assert.throws(() => parseChunkRange("9007199254740992-9007199254740993.json"), /invalid chunk range/);
  assert.throws(() => assertCompleteCoverage([{ ...fullRange, toBlock: 99 }], 100, 199), /invalid bounds/);
});

test("frozen provenance rejects a different head, start, chain, timestamps or windowed run", () => {
  assert.doesNotThrow(() => assertAuthoritativeRun(sourceRun));
  for (const change of [
    { headBlock: sourceRun.headBlock + 1 }, { tradeFromBlock: sourceRun.tradeFromBlock + 1 },
    { tradeToBlock: sourceRun.tradeToBlock - 1 }, { chainId: 1 }, { tradesAreFullHistory: false },
    { startedAt: "2026-09-19T16:27:46.209Z" }, { finishedAt: "2026-09-19T17:00:25.492Z" },
  ]) assert.throws(() => assertAuthoritativeRun({ ...sourceRun, ...change }), /mismatch|incomplete/);
});

test("publication reconciliation rejects tampering with every canonical count", () => {
  assert.doesNotThrow(() => assertReconciliation({ ...AUTHORITATIVE_COUNTS }));
  for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
    assert.throws(() => assertReconciliation({ ...AUTHORITATIVE_COUNTS, [key]: AUTHORITATIVE_COUNTS[key] + 1 }), new RegExp(key));
  }
});

test("raw log schema checks bounds, hashes, event surface, and all decoded ABI fields", () => {
  assert.equal(validateRawLog(bought, fullRange, "curve").args.buyer, address);
  assert.throws(() => validateRawLog({ ...bought, blockNumber: 200 }, fullRange, "curve"), /outside/);
  assert.throws(() => validateRawLog({ ...bought, blockNumber: 150.5 }, fullRange, "curve"), /outside/);
  assert.throws(() => validateRawLog({ ...bought, transactionHash: "0x1234" }, fullRange, "curve"), /transactionHash/);
  assert.throws(() => validateRawLog({ ...bought, blockHash: null }, fullRange, "curve"), /blockHash/);
  assert.throws(() => validateRawLog({ ...bought, logIndex: -1 }, fullRange, "curve"), /logIndex/);
  assert.throws(() => validateRawLog(bought, fullRange, "factory"), /unexpected factory event/);
  assert.throws(() => validateRawLog({ ...bought, args: { ...bought.args, buyer: "undefined" } }, fullRange, "curve"), /buyer address/);
  assert.throws(() => validateRawLog({ ...bought, args: { ...bought.args, creatorFee: "-1" } }, fullRange, "curve"), /creatorFee integer/);
  assert.throws(() => validateRawLog({ ...bought, args: { ...bought.args, tokenAmount: (1n << 256n).toString() } }, fullRange, "curve"), /out-of-range/);
  assert.throws(() => validateRawLog({ ...bought, args: {} }, fullRange, "curve"), /buyer address/);
});

test("raw log validation preserves the zero address for derivation diagnostics", () => {
  const zero = `0x${"0".repeat(40)}`;
  assert.equal(validateRawLog({ ...bought, args: { ...bought.args, buyer: zero } }, fullRange, "curve").args.buyer, zero);
  assert.throws(() => validateRawLog({ ...bought, address: zero }, fullRange, "curve"), /invalid emitting address/);
});

test("stable event identity deduplicates exact records and rejects conflicting copies", () => {
  const seen = new EventDeduplicator();
  const event = validateRawLog(bought, fullRange, "curve");
  assert.equal(seen.add(event), true);
  assert.equal(seen.add({ ...event, args: Object.fromEntries(Object.entries(event.args).reverse()) }), false);
  assert.equal(seen.duplicates, 1);
  assert.throws(() => seen.add({ ...event, args: { ...event.args, buyer: `0x${"2".repeat(40)}` } }), /conflicting duplicate/);
  assert.throws(() => seen.add({ ...event, blockNumber: event.blockNumber + 1 }), /conflicting duplicate/);
  assert.equal(seen.add({ ...event, logIndex: 2 }), true);
});

test("ABI normalization deduplicates checksummed address and bigint/string representations", () => {
  const mixed = `0x${"Ab".repeat(20)}`;
  const event = validateRawLog({ ...bought, args: { ...bought.args, buyer: mixed, tokenAmount: 1n } }, fullRange, "curve");
  const equivalent = validateRawLog({ ...bought, args: { ...bought.args, buyer: mixed.toLowerCase(), tokenAmount: "1" } }, fullRange, "curve");
  const seen = new EventDeduplicator();
  assert.equal(seen.add(event), true);
  assert.equal(seen.add(equivalent), false);
});

test("authoritative launch IDs must be dense independently in each factory generation", () => {
  const generations = new Map([
    ["retired", new Set(Array.from({ length: 14_800 }, (_, n) => String(n)))],
    ["legacy", new Set(Array.from({ length: 43_220 }, (_, n) => String(n)))],
    ["current", new Set(Array.from({ length: 39_713 }, (_, n) => String(n)))],
  ]);
  assert.doesNotThrow(() => assertDenseLaunchIds(generations));
  generations.get("current")!.delete("39712");
  assert.throws(() => assertDenseLaunchIds(generations), /count mismatch for current/);
  generations.get("current")!.add("39713");
  assert.throws(() => assertDenseLaunchIds(generations), /missing current:39712/);
});
