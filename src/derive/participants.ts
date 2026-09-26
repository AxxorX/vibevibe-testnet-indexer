import type { ScanScope } from "./activity.js";
import type { TradeScanResult } from "../stages/trades.js";

/** Minimal shapes also accepted by the offline, streaming cache replay. */
export interface ParticipantLaunch {
  key: string;
  factory: unknown;
  curve: unknown;
  creator: unknown;
  deploymentBlock: number;
  isQuotedLaunch?: boolean;
}

export interface ParticipantTrade {
  curve: unknown;
  side: "buy" | "sell";
  trader: unknown;
  recipient: unknown;
  blockNumber: number;
}

export interface ParticipantCounts {
  actorAddressCount: number;
  participantAddressCount: number;
  creatorAddressCount: number;
  tradeActorAddressCount: number;
  tradeParticipantAddressCount: number;
  buyRecipientAddressCount: number;
  creatorTraderOverlapCount: number;
  creatorTradeParticipantOverlapCount: number;
  recipientOnlyAddressCount: number;
  multiProjectActorAddressCount: number;
  multiProjectParticipantAddressCount: number;
}

export interface ParticipantSummary {
  schemaVersion: 1;
  definitionVersion: 1;
  scope: "configured-launch-and-curve-event-addresses";
  isFullHistory: boolean;
  launchScan: ScanScope;
  curveScan: ScanScope;
  counts: ParticipantCounts;
  definitions: { actor: string; participant: string };
  includedRoles: { actors: string[]; additionalParticipants: string[] };
  excludedRoles: string[];
  exclusions: string[];
  limitations: string[];
  normalization: string;
  contractInclusionPolicy: string;
  integrity: {
    launchRecords: number;
    tradeRecords: number;
    unusableAddressValues: number;
    malformedAddressValues: number;
    zeroAddressValues: number;
    rejectedByRole: Record<string, number>;
    rejectedByReason: { malformed: number; zero: number };
    rejectedByRoleAndReason: Record<string, { malformed: number; zero: number }>;
    unmappedTradeEvents: number;
  };
}

export interface ParticipantAccumulatorInput {
  launches: readonly ParticipantLaunch[];
  launchScan: ScanScope;
  curveScan: ScanScope;
  headBlock: number;
  /** Explicit input keeps this derivation independent of RPC/config imports. */
  earliestDeploymentBlock: number;
}

export interface ParticipantAccumulator {
  addTrade(record: ParticipantTrade): void;
  finish(): ParticipantSummary;
}

export interface ParticipantInput extends Omit<ParticipantAccumulatorInput, "curveScan"> {
  tradeScan: Pick<TradeScanResult, "trades" | "fromBlock" | "toBlock" | "isFullHistory">;
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ADDRESS = /^[0-9a-f]{40}$/;
const CREATOR = 1;
const TRADE_ACTOR = 2;
const BUY_RECIPIENT = 4;
const ACTOR_ROLES = ["TokenLaunched.creator", "TokenLaunchedQuoted.creator", "Bought.buyer", "Sold.seller"];
const RECIPIENT_ROLE = "Bought.recipient";

/** Case-insensitive exact 20-byte address; zero is not a usable participant. */
export function normalizeParticipantAddress(value: unknown): string | null {
  const result = parseAddress(value);
  return result.address;
}

function parseAddress(value: unknown): { address: string | null; reason?: "malformed" | "zero" } {
  if (typeof value !== "string") return { address: null, reason: "malformed" };
  const lowered = value.trim().toLowerCase();
  const bare = lowered.startsWith("0x") ? lowered.slice(2) : lowered;
  if (!ADDRESS.test(bare)) return { address: null, reason: "malformed" };
  const address = `0x${bare}`;
  return address === ZERO_ADDRESS ? { address: null, reason: "zero" } : { address };
}

function assertBlock(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function validateScope(scope: ScanScope, name: string, head: number, earliest: number): ScanScope {
  assertBlock(scope.fromBlock, `${name}.fromBlock`);
  assertBlock(scope.toBlock, `${name}.toBlock`);
  if (scope.fromBlock > scope.toBlock) throw new Error(`${name} has reversed block bounds`);
  if (scope.toBlock !== head) throw new Error(`${name} must end at headBlock ${head}`);
  if (typeof scope.isFullHistory !== "boolean") throw new Error(`${name}.isFullHistory must be boolean`);
  if (scope.isFullHistory && scope.fromBlock > earliest) {
    throw new Error(`${name} claims full history but starts after earliest deployment ${earliest}`);
  }
  return { ...scope };
}

function validateRecordBlock(block: number, scope: ScanScope, name: string): void {
  assertBlock(block, `${name}.blockNumber`);
  if (block < scope.fromBlock || block > scope.toBlock) throw new Error(`${name} is outside its declared scan bounds`);
}

/**
 * One map represents the global address union, with role bits for intersections.
 * Only first projects and multiple-project flags are needed per address: the
 * metrics ask whether there are at least two projects, not for a project count.
 * Actor projects are tracked separately so a passive receipt on another project
 * does not make an address a multi-project actor.
 * Trade rows are consumed and discarded, so full-history replay stays bounded
 * by unique addresses and launch mappings instead of millions of trade records.
 */
export function createParticipantAccumulator(input: ParticipantAccumulatorInput): ParticipantAccumulator {
  assertBlock(input.headBlock, "headBlock");
  assertBlock(input.earliestDeploymentBlock, "earliestDeploymentBlock");
  if (input.headBlock < input.earliestDeploymentBlock) throw new Error("headBlock precedes earliest deployment");
  const launchScan = validateScope(input.launchScan, "launchScan", input.headBlock, input.earliestDeploymentBlock);
  const curveScan = validateScope(input.curveScan, "curveScan", input.headBlock, input.earliestDeploymentBlock);
  const curves = new Map<string, string>();
  const projectCurves = new Map<string, string>();
  const projectDeployment = new Map<string, number>();
  const addresses = new Map<string, {
    roles: number;
    firstProject: string;
    multipleProjects: boolean;
    firstActorProject: string | null;
    multipleActorProjects: boolean;
  }>();
  const integrity: ParticipantSummary["integrity"] = {
    launchRecords: 0,
    tradeRecords: 0,
    unusableAddressValues: 0,
    malformedAddressValues: 0,
    zeroAddressValues: 0,
    rejectedByRole: Object.fromEntries([...ACTOR_ROLES, RECIPIENT_ROLE].map((role) => [role, 0])),
    rejectedByReason: { malformed: 0, zero: 0 },
    rejectedByRoleAndReason: Object.fromEntries([...ACTOR_ROLES, RECIPIENT_ROLE].map((role) => [role, { malformed: 0, zero: 0 }])),
    unmappedTradeEvents: 0,
  };

  function collect(value: unknown, role: string, bit: number, project: string): void {
    const parsed = parseAddress(value);
    if (parsed.address === null) {
      integrity.unusableAddressValues++;
      integrity.rejectedByRole[role]++;
      const reason = parsed.reason!;
      integrity.rejectedByReason[reason]++;
      integrity.rejectedByRoleAndReason[role][reason]++;
      if (parsed.reason === "zero") integrity.zeroAddressValues++;
      else integrity.malformedAddressValues++;
      return;
    }
    const existing = addresses.get(parsed.address);
    if (existing) {
      existing.roles |= bit;
      if (existing.firstProject !== project) existing.multipleProjects = true;
      if (bit & (CREATOR | TRADE_ACTOR)) {
        if (existing.firstActorProject === null) existing.firstActorProject = project;
        else if (existing.firstActorProject !== project) existing.multipleActorProjects = true;
      }
    } else {
      addresses.set(parsed.address, {
        roles: bit,
        firstProject: project,
        multipleProjects: false,
        firstActorProject: bit & (CREATOR | TRADE_ACTOR) ? project : null,
        multipleActorProjects: false,
      });
    }
  }

  for (const launch of input.launches) {
    validateRecordBlock(launch.deploymentBlock, launchScan, "launch");
    const factory = normalizeParticipantAddress(launch.factory);
    const curve = normalizeParticipantAddress(launch.curve);
    if (!factory || !curve) throw new Error("Launch project attribution requires valid nonzero factory and curve addresses");
    if (typeof launch.key !== "string" || !launch.key || launch.key !== launch.key.trim()) {
      throw new Error("Launch project attribution requires a nonempty canonical project key");
    }
    // Include the factory explicitly, even if an imported key omitted generation.
    const project = `${factory}:${launch.key}`;
    const mappedProject = curves.get(curve);
    const mappedCurve = projectCurves.get(project);
    if ((mappedProject && mappedProject !== project) || (mappedCurve && mappedCurve !== curve)) {
      throw new Error("Ambiguous curve-to-project mapping in launch records");
    }
    const deployedAt = projectDeployment.get(project);
    if (deployedAt !== undefined && deployedAt !== launch.deploymentBlock) {
      throw new Error("Conflicting deployment block for the same project identity");
    }
    curves.set(curve, project);
    projectCurves.set(project, curve);
    projectDeployment.set(project, launch.deploymentBlock);
    integrity.launchRecords++;
    collect(launch.creator, launch.isQuotedLaunch ? "TokenLaunchedQuoted.creator" : "TokenLaunched.creator", CREATOR, project);
  }

  return {
    addTrade(trade) {
      validateRecordBlock(trade.blockNumber, curveScan, "trade");
      if (trade.side !== "buy" && trade.side !== "sell") throw new Error("Trade side must be buy or sell");
      const curve = normalizeParticipantAddress(trade.curve);
      const project = curve ? curves.get(curve) : undefined;
      if (!project) {
        integrity.tradeRecords++;
        integrity.unmappedTradeEvents++;
        return;
      }
      if (trade.blockNumber < projectDeployment.get(project)!) throw new Error("Trade precedes its project deployment block");
      integrity.tradeRecords++;
      collect(trade.trader, trade.side === "buy" ? "Bought.buyer" : "Sold.seller", TRADE_ACTOR, project);
      if (trade.side === "buy") collect(trade.recipient, RECIPIENT_ROLE, BUY_RECIPIENT, project);
    },
    finish() {
      const counts: ParticipantCounts = {
        actorAddressCount: 0,
        participantAddressCount: addresses.size,
        creatorAddressCount: 0,
        tradeActorAddressCount: 0,
        tradeParticipantAddressCount: 0,
        buyRecipientAddressCount: 0,
        creatorTraderOverlapCount: 0,
        creatorTradeParticipantOverlapCount: 0,
        recipientOnlyAddressCount: 0,
        multiProjectActorAddressCount: 0,
        multiProjectParticipantAddressCount: 0,
      };
      for (const { roles, multipleProjects, multipleActorProjects } of addresses.values()) {
        const creator = Boolean(roles & CREATOR);
        const trader = Boolean(roles & TRADE_ACTOR);
        const recipient = Boolean(roles & BUY_RECIPIENT);
        if (creator || trader) counts.actorAddressCount++;
        if (creator) counts.creatorAddressCount++;
        if (trader) counts.tradeActorAddressCount++;
        if (trader || recipient) counts.tradeParticipantAddressCount++;
        if (recipient) counts.buyRecipientAddressCount++;
        if (creator && trader) counts.creatorTraderOverlapCount++;
        if (creator && (trader || recipient)) counts.creatorTradeParticipantOverlapCount++;
        if (recipient && !creator && !trader) counts.recipientOnlyAddressCount++;
        if (multipleActorProjects) counts.multiProjectActorAddressCount++;
        if (multipleProjects) counts.multiProjectParticipantAddressCount++;
      }
      return {
        schemaVersion: 1,
        definitionVersion: 1,
        scope: "configured-launch-and-curve-event-addresses",
        isFullHistory: launchScan.isFullHistory && curveScan.isFullHistory,
        launchScan: { ...launchScan },
        curveScan: { ...curveScan },
        counts,
        definitions: {
          actor: "Distinct normalized nonzero addresses in the global union of TokenLaunched/TokenLaunchedQuoted.creator, Bought.buyer and Sold.seller. Actor describes an event role, not a transaction sender or a person.",
          participant: "Distinct normalized nonzero addresses in the global union of actor addresses and Bought.recipient. A recipient may receive tokens without initiating activity. Each address counts once across all included roles and projects.",
        },
        includedRoles: { actors: [...ACTOR_ROLES], additionalParticipants: [RECIPIENT_ROLE] },
        excludedRoles: [
          "TokenLaunched/TokenLaunchedQuoted.creatorFeeRecipient",
          "TokenLaunched/TokenLaunchedQuoted.creatorVault",
          "TokenLaunched/TokenLaunchedQuoted.token",
          "TokenLaunched/TokenLaunchedQuoted.curve",
          "TokenLaunchedQuoted.quoteCurrency",
          "factory/log-emitter address",
          "CreatorFeesForwarded.vault",
          "LaunchFeesClaimed.treasury",
          "other infrastructure/configuration addresses without an included event role",
        ],
        exclusions: [
          "Configured destinations and infrastructure fields: creatorFeeRecipient, creatorVault, token, curve, factory, quoteCurrency, CreatorFeesForwarded.vault and LaunchFeesClaimed.treasury. These are role exclusions, not contract-address classification.",
          "CurveCompleted and Graduated expose no initiating participant address. CreatorFeesForwarded exposes only a vault destination, so lifecycle-only transaction senders are not measured.",
          "Post-graduation swaps, transfers, approvals, buyback/burn activity, failed calls and transactions without an included participant-bearing event.",
          "Activity from factories outside the configured launch registry and curve logs not attributable to its indexed launches.",
        ],
        limitations: [
          "Addresses do not establish people, wallet ownership or real-world identity. One person may control several addresses; an address may represent a contract or intermediary.",
          "All usable addresses in included event roles are retained, including contracts. No EOA/contract classification, identity enrichment or transaction-sender inference is performed.",
          "Counts describe the declared scan ranges through the snapshot head. A windowed contributing scan prevents a full-history claim.",
          "Unusable participant address values and unmapped trade events are reported in integrity and must be reviewed before publication. Complete cached block coverage and source-run reconciliation require separate validation.",
        ],
        normalization: "Trim whitespace, accept an optional case-insensitive 0x prefix, require exactly 40 hexadecimal characters, and lowercase before deduplication. Reject malformed and zero addresses with separate counters; do not filter valid contracts.",
        contractInclusionPolicy: "Preserve every valid nonzero address in an included role, including contract and intermediary addresses. Do not classify EOA versus contract. An infrastructure address counts if it independently appears in an included role.",
        integrity: {
          ...integrity,
          rejectedByRole: { ...integrity.rejectedByRole },
          rejectedByReason: { ...integrity.rejectedByReason },
          rejectedByRoleAndReason: Object.fromEntries(Object.entries(integrity.rejectedByRoleAndReason).map(([role, counts]) => [role, { ...counts }])),
        },
      };
    },
  };
}

export function summariseParticipants(input: ParticipantInput): ParticipantSummary {
  const accumulator = createParticipantAccumulator({
    launches: input.launches,
    launchScan: input.launchScan,
    curveScan: {
      fromBlock: input.tradeScan.fromBlock,
      toBlock: input.tradeScan.toBlock,
      isFullHistory: input.tradeScan.isFullHistory,
    },
    headBlock: input.headBlock,
    earliestDeploymentBlock: input.earliestDeploymentBlock,
  });
  for (const trade of input.tradeScan.trades) accumulator.addTrade(trade);
  return accumulator.finish();
}
