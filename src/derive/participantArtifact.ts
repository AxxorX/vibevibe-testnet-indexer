import type { ParticipantSummary } from "./participants.js";
import { AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS } from "./participantSource.js";

export interface ParticipantSourceRun {
  chainId: number;
  headBlock: number;
  headBlockHash?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ParticipantValidation {
  coverageComplete: boolean;
  reconciled: boolean;
  method: "frozen-cache-replay" | "indexed-run" | "incremental-cache-replay";
  incremental?: {
    prefixHeadBlock: number; deltaFromBlock: number; deltaToBlock: number;
    prefixManifestSha256: string; deltaManifestSha256: string;
    proofFile: string; proofSha256: string;
  };
  counts: {
    launchRecords: number;
    buyEvents: number;
    sellEvents: number;
    lifecycleEvents: number;
    foreignCurveLogs: number;
    uniqueTransactionCount: number;
    launchTransactionCount: number;
    tradeTransactionCount: number;
    lifecycleTransactionCount: number;
    sharedAcrossCategories: number;
    unusableTransactionHashes: number;
  };
  inputManifest?: string;
  inputManifestSha256?: string;
}

/** Aggregate publication boundary. This function performs no counting or I/O. */
export function createParticipantArtifact(input: {
  summary: ParticipantSummary;
  sourceRun: ParticipantSourceRun;
  validation: ParticipantValidation;
  generatedAt?: string;
}) {
  const { summary: s, sourceRun, validation } = input;
  if (sourceRun.chainId !== 46630) throw new Error("Participant source chain must be testnet 46630");
  if (sourceRun.headBlockHash !== undefined && !/^0x[0-9a-f]{64}$/.test(sourceRun.headBlockHash)) throw new Error("Invalid source head block hash");
  if (!Number.isSafeInteger(sourceRun.headBlock) || sourceRun.headBlock < 0 ||
      s.launchScan.toBlock !== sourceRun.headBlock || s.curveScan.toBlock !== sourceRun.headBlock) {
    throw new Error("Participant source head does not match contributing scans");
  }
  if (!Number.isFinite(Date.parse(sourceRun.startedAt)) || !Number.isFinite(Date.parse(sourceRun.finishedAt)) ||
      Date.parse(sourceRun.finishedAt) < Date.parse(sourceRun.startedAt)) throw new Error("Invalid source-run timestamps");
  if (!s.isFullHistory || !s.launchScan.isFullHistory || !s.curveScan.isFullHistory ||
      s.launchScan.fromBlock !== 95_916_239 || s.curveScan.fromBlock !== 95_916_239 ||
      !validation.coverageComplete || !validation.reconciled) {
    throw new Error("Refusing participant publication: incomplete, windowed or unreconciled coverage");
  }
  if (s.integrity.unusableAddressValues !== 0 || s.integrity.unmappedTradeEvents !== 0 ||
      validation.counts.unusableTransactionHashes !== 0) {
    throw new Error("Refusing participant publication: unusable values or unassigned project activity");
  }
  for (const value of [...Object.values(s.counts), ...Object.values(validation.counts)]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid participant or reconciliation count");
  }
  if (s.integrity.launchRecords !== validation.counts.launchRecords ||
      s.integrity.tradeRecords !== validation.counts.buyEvents + validation.counts.sellEvents) {
    throw new Error("Participant input records do not match reconciled source counts");
  }
  if (validation.counts.launchTransactionCount + validation.counts.tradeTransactionCount +
      validation.counts.lifecycleTransactionCount - validation.counts.sharedAcrossCategories !== validation.counts.uniqueTransactionCount) {
    throw new Error("Reconciled transaction union is inconsistent");
  }
  if (validation.method === "frozen-cache-replay" || validation.method === "incremental-cache-replay") {
    if (!validation.inputManifest || !/^[a-f0-9]{64}$/.test(validation.inputManifestSha256 ?? "")) {
      throw new Error("Frozen replay requires a hashed input manifest");
    }
  }
  if (validation.method === "incremental-cache-replay") {
    if (!sourceRun.headBlockHash) throw new Error("Incremental source requires a head block hash");
    const i = validation.incremental;
    if (!i || i.prefixHeadBlock !== AUTHORITATIVE_RUN.headBlock ||
        i.deltaFromBlock !== AUTHORITATIVE_RUN.headBlock + 1 || i.deltaToBlock !== sourceRun.headBlock ||
        i.deltaToBlock < i.deltaFromBlock || !i.proofFile ||
        ![i.prefixManifestSha256, i.deltaManifestSha256, i.proofSha256].every(h => /^[a-f0-9]{64}$/.test(h))) {
      throw new Error("Incremental replay requires contiguous prefix/delta provenance and hashed proof");
    }
    for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
      if (validation.counts[key] < AUTHORITATIVE_COUNTS[key]) throw new Error(`Incremental historical count regression: ${key}`);
    }
  }
  if (validation.method === "frozen-cache-replay" || sourceRun.headBlock === AUTHORITATIVE_RUN.headBlock) {
    for (const key of ["chainId", "headBlock", "startedAt", "finishedAt"] as const) {
      if (sourceRun[key] !== AUTHORITATIVE_RUN[key]) throw new Error(`Authoritative source provenance mismatch: ${key}`);
    }
    for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof typeof AUTHORITATIVE_COUNTS)[]) {
      if (validation.counts[key] !== AUTHORITATIVE_COUNTS[key]) throw new Error(`Authoritative reconciliation mismatch: ${key}`);
    }
  }
  const c = s.counts;
  if (c.actorAddressCount !== c.creatorAddressCount + c.tradeActorAddressCount - c.creatorTraderOverlapCount ||
      c.participantAddressCount !== c.creatorAddressCount + c.tradeParticipantAddressCount - c.creatorTradeParticipantOverlapCount ||
      c.participantAddressCount !== c.actorAddressCount + c.recipientOnlyAddressCount ||
      c.multiProjectActorAddressCount > c.actorAddressCount ||
      c.multiProjectParticipantAddressCount > c.participantAddressCount ||
      c.multiProjectActorAddressCount > c.multiProjectParticipantAddressCount ||
      c.creatorTraderOverlapCount > Math.min(c.creatorAddressCount, c.tradeActorAddressCount) ||
      c.creatorTradeParticipantOverlapCount > Math.min(c.creatorAddressCount, c.tradeParticipantAddressCount) ||
      c.creatorTraderOverlapCount > c.creatorTradeParticipantOverlapCount ||
      c.tradeParticipantAddressCount < Math.max(c.tradeActorAddressCount, c.buyRecipientAddressCount) ||
      c.tradeParticipantAddressCount > c.tradeActorAddressCount + c.buyRecipientAddressCount ||
      c.recipientOnlyAddressCount > c.buyRecipientAddressCount ||
      c.creatorAddressCount > validation.counts.launchRecords ||
      c.tradeActorAddressCount > validation.counts.buyEvents + validation.counts.sellEvents ||
      c.buyRecipientAddressCount > validation.counts.buyEvents) {
    throw new Error("Participant set counts are inconsistent");
  }
  const derivedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(derivedAt)) || Date.parse(derivedAt) < Date.parse(sourceRun.finishedAt)) {
    throw new Error("Derivation timestamp precedes its source run");
  }
  return structuredClone({
    schemaVersion: s.schemaVersion,
    definitionVersion: s.definitionVersion,
    chain: { chainId: sourceRun.chainId, network: "TESTNET" as const },
    sourceRunStartBlock: s.launchScan.fromBlock,
    sourceRunHeadBlock: sourceRun.headBlock,
    sourceRun: { ...sourceRun },
    derivedAt,
    indexedActorAddressCount: c.actorAddressCount,
    indexedParticipantAddressCount: c.participantAddressCount,
    distinctCreatorAddressCount: c.creatorAddressCount,
    distinctBuyerSellerAddressCount: c.tradeActorAddressCount,
    distinctBuyRecipientAddressCount: c.buyRecipientAddressCount,
    distinctTradeParticipantAddressCount: c.tradeParticipantAddressCount,
    creatorBuyerSellerOverlap: c.creatorTraderOverlapCount,
    creatorTradeParticipantOverlap: c.creatorTradeParticipantOverlapCount,
    multiProjectActorAddressCount: c.multiProjectActorAddressCount,
    multiProjectParticipantAddressCount: c.multiProjectParticipantAddressCount,
    recipientOnlyAddressCount: c.recipientOnlyAddressCount,
    scope: s.scope,
    isFullHistory: s.isFullHistory,
    launchScan: s.launchScan,
    curveScan: s.curveScan,
    definitions: s.definitions,
    includedRoles: s.includedRoles,
    excludedRoles: s.excludedRoles,
    normalization: s.normalization,
    contractInclusionPolicy: s.contractInclusionPolicy,
    exclusions: s.exclusions,
    limitations: s.limitations,
    integrity: s.integrity,
    validation,
  });
}

export type ParticipantArtifact = ReturnType<typeof createParticipantArtifact>;
