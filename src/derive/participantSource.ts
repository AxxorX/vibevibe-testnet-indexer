/** Immutable baseline for the approved historical replay, shared by every gate. */
export const AUTHORITATIVE_RUN = {
  chainId: 46630,
  fromBlock: 95_916_239,
  headBlock: 121_309_670,
  cachedThroughBlock: 121_296_238,
  tailFromBlock: 121_296_239,
  startedAt: "2026-09-18T16:27:46.209Z",
  finishedAt: "2026-09-18T17:00:25.492Z",
} as const;

export const AUTHORITATIVE_COUNTS = {
  launchRecords: 97_733,
  buyEvents: 1_565_964,
  sellEvents: 427_376,
  lifecycleEvents: 75_459,
  foreignCurveLogs: 502,
  uniqueTransactionCount: 2_098_026,
  launchTransactionCount: 97_733,
  tradeTransactionCount: 1_993_340,
  lifecycleTransactionCount: 62_848,
  sharedAcrossCategories: 55_895,
  unusableTransactionHashes: 0,
} as const;
