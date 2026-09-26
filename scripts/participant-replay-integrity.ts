import { createHash } from "node:crypto";
import type { AbiEvent } from "viem";
import { FACTORY_EVENTS, CURVE_EVENTS } from "../config/abis.js";
import type { RawLog } from "../src/lib/logscan.js";

import { AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS } from "../src/derive/participantSource.js";
export { AUTHORITATIVE_RUN, AUTHORITATIVE_COUNTS };

export type ReconciliationCounts = { [K in keyof typeof AUTHORITATIVE_COUNTS]: number };
export interface ChunkRange { fromBlock: number; toBlock: number; file: string }
export type LogSurface = "factory" | "curve";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Participant replay integrity: ${message}`);
}

export function parseChunkRange(file: string): ChunkRange {
  const match = /^(\d+)-(\d+)\.json$/.exec(file);
  invariant(match, `unrecognized chunk filename ${file}`);
  const fromBlock = Number(match[1]);
  const toBlock = Number(match[2]);
  invariant(Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock <= toBlock,
    `invalid chunk range ${file}`);
  return { fromBlock, toBlock, file };
}

/** Coverage is established by all chunk bounds, never a checkpoint alone. */
export function assertCompleteCoverage(ranges: readonly ChunkRange[], fromBlock: number, toBlock: number): void {
  invariant(Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock <= toBlock,
    "invalid requested coverage");
  let next = fromBlock;
  for (const range of [...ranges].sort((a, b) => a.fromBlock - b.fromBlock)) {
    invariant(Number.isSafeInteger(range.fromBlock) && Number.isSafeInteger(range.toBlock) && range.toBlock >= range.fromBlock,
      `invalid bounds in ${range.file}`);
    invariant(range.fromBlock === next,
      `${range.fromBlock > next ? "missing cached range" : "overlapping cached range"}: expected ${next}, found ${range.fromBlock} (${range.file})`);
    invariant(range.toBlock <= toBlock, `chunk extends beyond frozen head ${toBlock}: ${range.file}`);
    next = range.toBlock + 1;
  }
  invariant(next === toBlock + 1, `missing cached range ${next}..${toBlock}`);
}

export function assertAuthoritativeRun(run: {
  chainId: number; headBlock: number; startedAt: string; finishedAt: string;
  tradeFromBlock: number; tradeToBlock: number; tradesAreFullHistory: boolean;
}): void {
  for (const key of ["chainId", "headBlock", "startedAt", "finishedAt"] as const) {
    invariant(run[key] === AUTHORITATIVE_RUN[key], `source provenance mismatch for ${key}`);
  }
  invariant(run.tradeFromBlock === AUTHORITATIVE_RUN.fromBlock, "source start block mismatch");
  invariant(run.tradeToBlock === AUTHORITATIVE_RUN.headBlock, "source curve head mismatch");
  invariant(run.tradesAreFullHistory === true, "windowed/incomplete source coverage");
}

export function assertReconciliation(actual: ReconciliationCounts): void {
  for (const key of Object.keys(AUTHORITATIVE_COUNTS) as (keyof ReconciliationCounts)[]) {
    invariant(actual[key] === AUTHORITATIVE_COUNTS[key],
      `authoritative reconciliation failed: ${key} expected ${AUTHORITATIVE_COUNTS[key]}, observed ${actual[key]}`);
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = `0x${"0".repeat(40)}`;
const EVENTS = {
  factory: new Map<string, AbiEvent>(FACTORY_EVENTS.map(event => [event.name, event as AbiEvent])),
  curve: new Map<string, AbiEvent>(CURVE_EVENTS.map(event => [event.name, event as AbiEvent])),
};

function object(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Reject corrupt cached wire records before the shared event decoder sees them. */
export function validateRawLog(value: unknown, range: ChunkRange, surface: LogSurface): RawLog {
  const raw = object(value, "raw log");
  invariant(Number.isSafeInteger(raw.blockNumber) && (raw.blockNumber as number) >= range.fromBlock &&
    (raw.blockNumber as number) <= range.toBlock, `log block outside ${range.file}`);
  invariant(Number.isSafeInteger(raw.logIndex) && (raw.logIndex as number) >= 0, "invalid logIndex");
  invariant(typeof raw.blockHash === "string" && HASH.test(raw.blockHash), "invalid blockHash");
  invariant(typeof raw.transactionHash === "string" && HASH.test(raw.transactionHash), "invalid transactionHash");
  invariant(typeof raw.address === "string" && ADDRESS.test(raw.address) && raw.address.toLowerCase() !== ZERO,
    "invalid emitting address");
  invariant(typeof raw.eventName === "string" && EVENTS[surface].has(raw.eventName), `unexpected ${surface} event ${raw.eventName}`);
  const event = EVENTS[surface].get(raw.eventName)!;
  const args = object(raw.args, "event args");
  const normalizedArgs: Record<string, unknown> = {};
  for (const input of event.inputs) {
    const name = input.name!;
    const arg = args[name];
    if (input.type === "address") {
      invariant(typeof arg === "string" && ADDRESS.test(arg), `invalid ${raw.eventName}.${name} address`);
      normalizedArgs[name] = arg.toLowerCase();
    } else if (input.type.startsWith("uint")) {
      invariant((typeof arg === "string" && /^\d+$/.test(arg)) ||
        (typeof arg === "bigint" && arg >= 0n) ||
        (typeof arg === "number" && Number.isSafeInteger(arg) && arg >= 0), `invalid ${raw.eventName}.${name} integer`);
      const integer = BigInt(arg as string | number | bigint);
      const bits = Number(input.type.slice(4) || 256);
      invariant(integer < (1n << BigInt(bits)), `out-of-range ${raw.eventName}.${name}`);
      normalizedArgs[name] = integer.toString();
    } else if (input.type === "bytes32") {
      invariant(typeof arg === "string" && HASH.test(arg), `invalid ${raw.eventName}.${name} bytes32`);
      normalizedArgs[name] = arg.toLowerCase();
    } else if (input.type === "string") {
      invariant(typeof arg === "string", `invalid ${raw.eventName}.${name} string`);
      normalizedArgs[name] = arg;
    } else throw new Error(`Unsupported replay ABI type ${input.type}`);
  }
  return {
    blockNumber: raw.blockNumber as number,
    blockHash: raw.blockHash.toLowerCase() as RawLog["blockHash"],
    transactionHash: raw.transactionHash.toLowerCase() as RawLog["transactionHash"],
    logIndex: raw.logIndex as number,
    address: raw.address.toLowerCase() as RawLog["address"],
    eventName: raw.eventName,
    args: normalizedArgs,
  };
}

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Repeated identical events count once; conflicting versions fail closed. */
export class EventDeduplicator {
  private readonly fingerprints = new Map<string, string>();
  duplicates = 0;

  add(log: RawLog): boolean {
    const identity = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    const fingerprint = sha256(JSON.stringify({
      blockNumber: log.blockNumber, blockHash: log.blockHash, address: log.address,
      eventName: log.eventName,
      args: Object.fromEntries(Object.entries(log.args).sort(([a], [b]) => a.localeCompare(b))),
    }));
    const previous = this.fingerprints.get(identity);
    if (previous !== undefined) {
      invariant(previous === fingerprint, `conflicting duplicate event ${identity}`);
      this.duplicates++;
      return false;
    }
    this.fingerprints.set(identity, fingerprint);
    return true;
  }
}

export function assertDenseLaunchIds(byGeneration: ReadonlyMap<string, ReadonlySet<string>>): void {
  const expected: Record<string, number> = { retired: 14_800, legacy: 43_220, current: 39_713 };
  invariant(byGeneration.size === 3, "unexpected factory generation set");
  for (const [generation, count] of Object.entries(expected)) {
    const ids = byGeneration.get(generation);
    invariant(ids?.size === count, `launch count mismatch for ${generation}`);
    for (let id = 0; id < count; id++) invariant(ids.has(String(id)), `missing ${generation}:${id}`);
  }
}
