export const v2Profiles: Readonly<Record<number, { directory: string; release: string }>> = {
  62: { directory: "t3-v010", release: "0.1.0" },
  67: { directory: "t3-v012", release: "0.1.1 / 0.1.2" },
  69: { directory: "t3-v013", release: "0.1.3" },
  72: { directory: "t3-v015", release: "0.1.4 / 0.1.5" },
  76: { directory: "t3-v016", release: "0.1.6" },
};
export const v2Migrations = new Map([
  [55, "OrchestrationV2"], [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"], [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"], [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"], [62, "ThreadFailureLookupIndex"],
  [63, "DropUnusedV1Projections"], [64, "CanonicalizeThreadPullRequestLinks"],
  [65, "CodexUsageNativeTurnIndex"], [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"], [68, "ShellStopRequestIndex"], [69, "ThreadMessageSearch"],
  [70, "PeerLinks"], [71, "PeerLinkFence"], [72, "WaitingLinkRequestIndex"],
  [73, "ActiveTurnItemIndexes"], [74, "ExcludeAttachmentPlaceholdersFromSearch"],
  [75, "SubagentDeliveryState"], [76, "ProjectionProjectsPinArchive"],
]);
