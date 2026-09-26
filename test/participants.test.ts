import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createParticipantAccumulator,
  normalizeParticipantAddress,
  summariseParticipants,
  type ParticipantAccumulatorInput,
  type ParticipantLaunch,
  type ParticipantTrade,
} from "../src/derive/participants.js";
import type { TradeRecord } from "../src/stages/trades.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const A = address(0xabcdef), B = address(0xbbbbbb), C = address(0xcccccc), D = address(0xdddddd);
const FACTORY = address(1001), OTHER_FACTORY = address(1002);
const CURVE = address(2001), OTHER_CURVE = address(2002);
const FULL = { fromBlock: 100, toBlock: 200, isFullHistory: true };

function launch(overrides: Partial<ParticipantLaunch> = {}): ParticipantLaunch {
  return { key: "current:0", factory: FACTORY, curve: CURVE, creator: A, deploymentBlock: 100, ...overrides };
}

function trade(overrides: Partial<ParticipantTrade> = {}): ParticipantTrade {
  return { curve: CURVE, side: "buy", trader: A, recipient: A, blockNumber: 150, ...overrides };
}

function input(launches: ParticipantLaunch[] = [launch()], overrides: Partial<ParticipantAccumulatorInput> = {}): ParticipantAccumulatorInput {
  return { launches, launchScan: FULL, curveScan: FULL, headBlock: 200, earliestDeploymentBlock: 100, ...overrides };
}

function derive(launches: ParticipantLaunch[], trades: ParticipantTrade[]) {
  const accumulator = createParticipantAccumulator(input(launches));
  for (const record of trades) accumulator.addTrade(record);
  return accumulator.finish();
}

describe("participant address normalization", () => {
  test("canonicalizes supported prefixed, unprefixed, mixed-case and whitespace forms", () => {
    for (const value of [A, A.toUpperCase(), A.slice(2), A.slice(2).toUpperCase(), ` \t${A}\n`]) {
      assert.equal(normalizeParticipantAddress(value), A);
    }
    assert.equal(normalizeParticipantAddress(B), B, "distinct values must remain distinct");
  });

  test("rejects malformed input without coercing non-string values", () => {
    for (const value of [null, undefined, 123, false, {}, [], "", "0x", "a".repeat(39), "a".repeat(41), `0x${"g".repeat(40)}`, `0x${"a".repeat(20)} ${"a".repeat(20)}`, `0xx${"a".repeat(40)}`, "０".repeat(40)]) {
      assert.equal(normalizeParticipantAddress(value), null, String(value));
    }
  });

  test("excludes the zero-address sentinel in every supported representation", () => {
    for (const value of [address(0), "0".repeat(40), ` ${address(0).toUpperCase()} `]) {
      assert.equal(normalizeParticipantAddress(value), null);
    }
  });
});

describe("global actor and participant unions", () => {
  test("duplicates and mixed case across every category count once", () => {
    const summary = derive(
      [launch({ creator: A.toUpperCase() }), launch({ creator: A.slice(2) })],
      [trade(), trade({ trader: A.slice(2), recipient: A.toUpperCase() }), trade({ side: "sell", trader: ` ${A} `, recipient: null })],
    );
    assert.equal(summary.counts.actorAddressCount, 1);
    assert.equal(summary.counts.participantAddressCount, 1);
    assert.equal(summary.counts.creatorTraderOverlapCount, 1);
    assert.equal(summary.counts.creatorTradeParticipantOverlapCount, 1);
    assert.equal(summary.counts.multiProjectActorAddressCount, 0);
    assert.equal(summary.counts.multiProjectParticipantAddressCount, 0);
    assert.equal(summary.integrity.unusableAddressValues, 0);
  });

  test("buyer != recipient: both global unions and overlaps use distinct role membership", () => {
    const summary = derive(
      [launch(), launch({ key: "legacy:0", factory: OTHER_FACTORY, curve: OTHER_CURVE, creator: B })],
      [trade({ recipient: C }), trade({ curve: OTHER_CURVE, trader: D, recipient: A }), trade({ side: "sell", trader: B, recipient: null })],
    );
    assert.deepEqual(summary.counts, {
      actorAddressCount: 3,
      participantAddressCount: 4,
      creatorAddressCount: 2,
      tradeActorAddressCount: 3,
      tradeParticipantAddressCount: 4,
      buyRecipientAddressCount: 2,
      creatorTraderOverlapCount: 2,
      creatorTradeParticipantOverlapCount: 2,
      recipientOnlyAddressCount: 1,
      multiProjectActorAddressCount: 1,
      multiProjectParticipantAddressCount: 2,
    });
    assert.notEqual(summary.counts.actorAddressCount, summary.counts.creatorAddressCount + summary.counts.tradeActorAddressCount);
    assert.notEqual(summary.counts.participantAddressCount, summary.counts.creatorAddressCount + summary.counts.tradeParticipantAddressCount);
    assert.equal(summary.counts.actorAddressCount, summary.counts.creatorAddressCount + summary.counts.tradeActorAddressCount - summary.counts.creatorTraderOverlapCount);
    assert.equal(summary.counts.participantAddressCount, summary.counts.actorAddressCount + summary.counts.recipientOnlyAddressCount);
  });

  test("creator/recipient overlap is broader than creator/buyer-seller overlap", () => {
    const summary = derive([launch()], [trade({ trader: B, recipient: A })]);
    assert.equal(summary.counts.creatorTraderOverlapCount, 0);
    assert.equal(summary.counts.creatorTradeParticipantOverlapCount, 1);
    assert.equal(summary.counts.actorAddressCount, 2);
    assert.equal(summary.counts.participantAddressCount, 2);
    assert.equal(summary.counts.recipientOnlyAddressCount, 0, "a creator is already an actor even when present only as a trade recipient");
  });

  test("recipient-only addresses contribute to participants but not actors", () => {
    const summary = derive([launch()], [trade({ recipient: B })]);
    assert.equal(summary.counts.actorAddressCount, 1);
    assert.equal(summary.counts.participantAddressCount, 2);
    assert.equal(summary.counts.recipientOnlyAddressCount, 1);
  });

  test("empty inputs produce explicit zero counts and zero diagnostics", () => {
    const summary = derive([], []);
    assert.ok(Object.values(summary.counts).every((count) => count === 0));
    assert.equal(summary.integrity.launchRecords, 0);
    assert.equal(summary.integrity.tradeRecords, 0);
    assert.equal(summary.integrity.unusableAddressValues, 0);
    assert.equal(summary.isFullHistory, true, "coverage claims need separate source-row reconciliation before publication");
  });

  test("unusable values are counted by event role and rejection reason", () => {
    const summary = derive(
      [launch({ creator: undefined }), launch({ key: "current:1", curve: OTHER_CURVE, creator: address(0), isQuotedLaunch: true })],
      [trade({ trader: "bad", recipient: address(0) }), trade({ side: "sell", trader: null, recipient: null }), trade({ curve: OTHER_CURVE, trader: B, recipient: C })],
    );
    assert.equal(summary.counts.actorAddressCount, 1);
    assert.equal(summary.counts.participantAddressCount, 2);
    assert.equal(summary.integrity.unusableAddressValues, 5);
    assert.equal(summary.integrity.malformedAddressValues, 3);
    assert.equal(summary.integrity.zeroAddressValues, 2);
    assert.deepEqual(summary.integrity.rejectedByReason, { malformed: 3, zero: 2 });
    assert.deepEqual(summary.integrity.rejectedByRoleAndReason["TokenLaunched.creator"], { malformed: 1, zero: 0 });
    assert.deepEqual(summary.integrity.rejectedByRoleAndReason["TokenLaunchedQuoted.creator"], { malformed: 0, zero: 1 });
    assert.deepEqual(summary.integrity.rejectedByRoleAndReason["Bought.recipient"], { malformed: 0, zero: 1 });
    assert.equal(Object.values(summary.integrity.rejectedByRole).reduce((a, b) => a + b, 0), 5);
  });

  test("infrastructure roles alone do not count; valid contracts in actor/recipient roles do", () => {
    const record = { ...launch(), creatorFeeRecipient: B, creatorVault: C, quoteCurrency: D, token: address(3001) };
    const accumulator = createParticipantAccumulator(input([record]));
    assert.equal(accumulator.finish().counts.participantAddressCount, 1);
    accumulator.addTrade(trade({ trader: FACTORY, recipient: CURVE }));
    accumulator.addTrade(trade({ side: "sell", trader: C, recipient: D }));
    const summary = accumulator.finish();
    assert.equal(summary.counts.actorAddressCount, 3, "creator, factory as buyer, and configured vault as seller");
    assert.equal(summary.counts.participantAddressCount, 4, "curve independently observed as buy recipient");
    assert.equal(summary.counts.buyRecipientAddressCount, 1, "Sold has no recipient role even if an imported row has a value");
    assert.ok(summary.excludedRoles.includes("CreatorFeesForwarded.vault"));
    assert.match(summary.contractInclusionPolicy, /Do not classify EOA versus contract/);
    assert.ok(!summary.includedRoles.actors.some((role) => role.startsWith("CreatorFeesForwarded")));
  });
});

describe("multi-project attribution", () => {
  test("repeated events and multiple roles within one project count as one project", () => {
    const summary = derive([launch()], Array.from({ length: 10 }, (_, n) => trade({ side: n % 2 ? "buy" : "sell" })));
    assert.equal(summary.counts.actorAddressCount, 1);
    assert.equal(summary.counts.multiProjectActorAddressCount, 0);
    assert.equal(summary.counts.multiProjectParticipantAddressCount, 0);
  });

  test("factory-scoped project identities preserve overlapping launch IDs and normalize curves", () => {
    const summary = derive(
      [launch(), launch({ key: "current:0", factory: OTHER_FACTORY.toUpperCase(), curve: OTHER_CURVE })],
      [trade({ curve: CURVE.toUpperCase() }), trade({ curve: OTHER_CURVE.slice(2) })],
    );
    assert.equal(summary.counts.multiProjectActorAddressCount, 1);
    assert.equal(summary.counts.multiProjectParticipantAddressCount, 1);
    assert.equal(summary.integrity.unmappedTradeEvents, 0);
  });

  test("a recipient project cannot make a single-project actor a multi-project actor", () => {
    const accumulator = createParticipantAccumulator(input([
      launch({ creator: B }),
      launch({ key: "current:1", curve: OTHER_CURVE, creator: C }),
      launch({ key: "current:2", curve: address(2003), creator: D }),
    ]));
    accumulator.addTrade(trade({ trader: B, recipient: A }));
    accumulator.addTrade(trade({ curve: OTHER_CURVE, trader: A, recipient: C }));
    assert.equal(accumulator.finish().counts.multiProjectParticipantAddressCount, 1);
    assert.equal(accumulator.finish().counts.multiProjectActorAddressCount, 0);
    accumulator.addTrade(trade({ curve: address(2003), side: "sell", trader: A, recipient: null }));
    assert.equal(accumulator.finish().counts.multiProjectActorAddressCount, 1);
  });

  test("unknown or unusable curve mappings reject trade participation and report the event", () => {
    const summary = derive([launch()], [trade({ curve: address(9001), trader: B, recipient: C }), trade({ curve: "bad", trader: D })]);
    assert.equal(summary.integrity.unmappedTradeEvents, 2);
    assert.equal(summary.integrity.tradeRecords, 2);
    assert.equal(summary.counts.participantAddressCount, 1);
  });

  test("conflicting curve/project attribution and deployment provenance are rejected", () => {
    assert.throws(() => createParticipantAccumulator(input([launch(), launch({ key: "current:1" })])), /Ambiguous/);
    assert.throws(() => createParticipantAccumulator(input([launch(), launch({ curve: OTHER_CURVE })])), /Ambiguous/);
    assert.throws(() => createParticipantAccumulator(input([launch(), launch({ deploymentBlock: 101 })])), /Conflicting deployment block/);
    for (const overrides of [{ factory: "bad" }, { curve: address(0) }, { key: "" }, { key: " current:0" }]) {
      assert.throws(() => createParticipantAccumulator(input([launch(overrides)])), /project attribution/);
    }
  });

  test("a trade before its mapped project deployment is rejected", () => {
    const accumulator = createParticipantAccumulator(input([launch({ deploymentBlock: 160 })]));
    assert.throws(() => accumulator.addTrade(trade({ blockNumber: 150 })), /precedes its project deployment/);
  });
});

describe("scope and streaming integrity", () => {
  test("head mismatch, reversed bounds and invalid blocks are rejected", () => {
    assert.throws(() => createParticipantAccumulator(input([], { curveScan: { ...FULL, toBlock: 199 } })), /must end at headBlock/);
    assert.throws(() => createParticipantAccumulator(input([], { launchScan: { ...FULL, toBlock: 201 } })), /must end at headBlock/);
    assert.throws(() => createParticipantAccumulator(input([], { curveScan: { ...FULL, fromBlock: 201 } })), /reversed block bounds/);
    assert.throws(() => createParticipantAccumulator(input([], { headBlock: NaN })), /safe integer/);
    assert.throws(() => createParticipantAccumulator(input([], { earliestDeploymentBlock: 201 })), /precedes earliest deployment/);
  });

  test("late starting scans cannot claim full history", () => {
    for (const name of ["launchScan", "curveScan"] as const) {
      assert.throws(() => createParticipantAccumulator(input([], { [name]: { ...FULL, fromBlock: 101 } })), /claims full history/);
    }
  });

  test("legitimate windowed inputs remain explicitly non-full-history", () => {
    for (const name of ["launchScan", "curveScan"] as const) {
      const summary = createParticipantAccumulator(input([], { [name]: { ...FULL, fromBlock: 150, isFullHistory: false } })).finish();
      assert.equal(summary.isFullHistory, false);
      assert.equal(summary[name].isFullHistory, false);
    }
    const summary = createParticipantAccumulator(input([], { curveScan: { ...FULL, isFullHistory: false } })).finish();
    assert.equal(summary.isFullHistory, false, "bounds alone cannot upgrade an explicitly incomplete source");
  });

  test("out-of-scope records and unsupported trade sides are rejected", () => {
    assert.throws(() => createParticipantAccumulator(input([launch({ deploymentBlock: 99 })])), /outside its declared scan bounds/);
    const accumulator = createParticipantAccumulator(input());
    assert.throws(() => accumulator.addTrade(trade({ blockNumber: 201 })), /outside its declared scan bounds/);
    assert.throws(() => accumulator.addTrade({ ...trade(), side: "other" } as unknown as ParticipantTrade), /side must be buy or sell/);
  });

  test("streaming accumulator and convenience derivation agree", () => {
    const launches = [launch()];
    const records = [trade({ recipient: B }), trade({ side: "sell", trader: C, recipient: null })];
    const streamed = derive(launches, records);
    const convenience = summariseParticipants({
      ...input(launches),
      tradeScan: { ...FULL, trades: records as TradeRecord[] },
    });
    assert.deepEqual(convenience, streamed);
  });

  test("returned diagnostics and scope are snapshots, not mutable accumulator state", () => {
    const accumulator = createParticipantAccumulator(input());
    accumulator.addTrade(trade({ trader: "bad", recipient: address(0) }));
    const before = accumulator.finish();
    before.integrity.rejectedByRoleAndReason["Bought.buyer"].malformed = 99;
    before.integrity.rejectedByReason.malformed = 99;
    before.launchScan.fromBlock = 0;
    assert.equal(accumulator.finish().integrity.rejectedByReason.malformed, 1);
    assert.equal(accumulator.finish().integrity.rejectedByRoleAndReason["Bought.buyer"].malformed, 1);
    assert.equal(accumulator.finish().launchScan.fromBlock, 100);
  });
});
