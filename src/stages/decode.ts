import type { Address, Hex } from "viem";
import { FACTORY_BY_ADDRESS } from "../../config/factories.js";
import type { RawLog } from "../lib/logscan.js";
import type { LaunchRecord } from "./launches.js";
import type { LifecycleEvent, TradeRecord } from "./trades.js";

/** Shared event-to-record decoding for network scans and frozen cache replay. */
export function decodeLaunchLog(log: RawLog): LaunchRecord | null {
  if (log.eventName !== "TokenLaunched" && log.eventName !== "TokenLaunchedQuoted") return null;
  const gen = FACTORY_BY_ADDRESS.get(log.address.toLowerCase());
  if (!gen) return null;
  const a = log.args;
  const quoted = log.eventName === "TokenLaunchedQuoted";
  return {
    key: `${gen.generation}:${String(a.launchId)}`,
    generation: gen.generation,
    factory: gen.factory,
    launchId: String(a.launchId),
    token: String(a.token).toLowerCase() as Address,
    curve: String(a.curve).toLowerCase() as Address,
    creator: String(a.creator).toLowerCase() as Address,
    creatorFeeRecipient: String(a.creatorFeeRecipient).toLowerCase() as Address,
    creatorVault: String(a.creatorVault).toLowerCase() as Address,
    quoteCurrency: quoted ? String(a.quoteCurrency).toLowerCase() as Address : null,
    isQuotedLaunch: quoted,
    initialBuy: String(a.initialBuy ?? "0"),
    initialTokensBought: String(a.initialTokensBought ?? "0"),
    metadataSchemaVersion: Number(a.metadataSchemaVersion ?? 0),
    metadataDigest: a.metadataDigest as Hex,
    metadataURI: String(a.metadataURI ?? ""),
    deploymentBlock: log.blockNumber,
    deploymentTxHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

export function decodeCurveLog(
  log: RawLog,
  curveToToken: ReadonlyMap<string, Address>,
): { trade?: TradeRecord; lifecycle?: LifecycleEvent; foreign: boolean } {
  const curve = log.address.toLowerCase() as Address;
  const token = curveToToken.get(curve);
  if (!token) return { foreign: true };
  const a = log.args;
  const base = { curve, token, blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex };
  if (log.eventName === "Bought" || log.eventName === "Sold") {
    const buy = log.eventName === "Bought";
    const creatorFee = BigInt(String(a.creatorFee ?? 0));
    const protocolFee = BigInt(String(a.protocolFee ?? 0));
    return { foreign: false, trade: {
      ...base,
      side: buy ? "buy" : "sell",
      trader: String(buy ? a.buyer : a.seller).toLowerCase() as Address,
      recipient: buy ? String(a.recipient).toLowerCase() as Address : null,
      grossWei: String((buy ? a.grossEthUsed : a.grossCurveQuote) ?? 0),
      curveQuoteWei: String((buy ? a.curveQuote : a.grossCurveQuote) ?? 0),
      ethReceivedWei: buy ? null : String(a.ethReceived ?? 0),
      tokenAmount: String(a.tokenAmount ?? 0),
      creatorFeeWei: creatorFee.toString(),
      protocolFeeWei: protocolFee.toString(),
      totalFeeWei: (creatorFee + protocolFee).toString(),
    } };
  }
  if (log.eventName === "CurveCompleted") return { foreign: false, lifecycle: {
    ...base, kind: "CurveCompleted", netEthReserve: String(a.netEthReserve ?? 0), timestamp: String(a.timestamp ?? 0),
  } };
  if (log.eventName === "Graduated") return { foreign: false, lifecycle: {
    ...base, kind: "Graduated", poolId: a.poolId as Hex,
    ethAmount: String(a.ethAmount ?? 0), tokenAmount: String(a.tokenAmount ?? 0),
  } };
  if (log.eventName === "CreatorFeesForwarded") return { foreign: false, lifecycle: {
    ...base, kind: "CreatorFeesForwarded", vault: String(a.vault).toLowerCase() as Address, amount: String(a.amount ?? 0),
  } };
  return { foreign: false };
}
