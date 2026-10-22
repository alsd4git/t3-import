export const v2Profiles: Readonly<Record<number, { directory: string; release: string }>> = {
  62: { directory: "t3-v010", release: "0.1.0" },
  67: { directory: "t3-v011", release: "0.1.1" },
};
export const v2Migrations = new Map([
  [55, "OrchestrationV2"], [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"], [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"], [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"], [62, "ThreadFailureLookupIndex"],
  [63, "DropUnusedV1Projections"], [64, "CanonicalizeThreadPullRequestLinks"],
  [65, "CodexUsageNativeTurnIndex"], [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"],
]);
