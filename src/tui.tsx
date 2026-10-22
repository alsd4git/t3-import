import React, { useCallback, useEffect, useMemo, useState } from "react";
import Database from "better-sqlite3";
import { Box, Text, useApp, useInput } from "ink";
import type {
  CanonicalConversation,
  ConversationReplacePreview,
  ConversationSyncPreview,
  ImportRunResult,
  ImportSelection,
  ReplaceRunResult,
  ReplaceSelection,
  SourceName,
  SourceSummary,
  SyncRunResult,
  SyncSelection,
  TargetPaths,
} from "./core/types.js";
import { sourceAdapter } from "./sources/index.js";
import { compactThreadForImport, importConversations } from "./target/importer.js";
import { inspectConversationSync, syncConversations } from "./target/sync.js";
import { listProviderInstances } from "./target/config.js";
import { inspectRuntimeStatus, type RuntimeStatus } from "./target/runtimeControl.js";
import { runtimeActivityText } from "./target/runtimeActivity.js";
import { launchT3Code } from "./target/launch.js";
import { resetT3RebuildableCache } from "./target/cache.js";
import { inspectConversationReplacement, replaceConversations } from "./target/replace.js";
import { importDestination, type DestinationOptions } from "./target/destination.js";
import { sourceNames } from "./core/providers.js";
import { canonicalPath } from "./core/util.js";

export type Screen = "preflight" | "blocked" | "pause-confirm" | "maintenance" | "source" | "workspace" | "provider" | "threads" | "destination" | "review" | "running" | "result" | "launching" | "launch-error" | "error";

export interface TuiDestinationChoice {
  label: string;
  options?: DestinationOptions;
}

export function sourceLabel(source: SourceName): string {
  if (source === "codex") return "Codex";
  if (source === "claude") return "Claude Code";
  return "OpenCode";
}

/** Only offer destinations that the importer's canonical policy accepts. */
export function discoverTuiDestinations(paths: TargetPaths, workspace: string): TuiDestinationChoice[] {
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT project_id projectId, title, workspace_root workspaceRoot FROM projection_projects WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE, project_id").all() as Array<{ projectId: string; title: string; workspaceRoot: string }>;
    const matching = rows.filter((row) => canonicalPath(row.workspaceRoot) === canonicalPath(workspace));
    const choices: TuiDestinationChoice[] = [{ label: matching.length ? "Use the matching workspace project (default)" : "Create or use the workspace project (default)" }];
    for (const row of matching) {
      try {
        importDestination(db, paths, workspace, { targetProject: row.projectId });
        choices.push({ label: `${row.title} · ${row.workspaceRoot}`, options: { targetProject: row.projectId } });
      } catch {
        // A project that fails the importer's destination invariant is not selectable.
      }
    }
    try {
      importDestination(db, paths, workspace, { noProject: true });
      choices.push({ label: "No project (T3 scratch)", options: { noProject: true } });
    } catch {
      // Native scratch is only offered when the canonical policy permits it.
    }
    return choices;
  } finally {
    db.close();
  }
}

export function escapeDestination(screen: Screen, history: Screen[]): Screen | undefined {
  if (["source", "blocked", "result", "launch-error", "error"].includes(screen)) return undefined;
  return history.at(-1);
}

interface TuiProps {
  paths: TargetPaths;
  initialSource?: SourceName;
  initialWorkspace?: string;
  initialProvider?: string;
  mode?: "auto" | "sync" | "replace";
  resetCache?: boolean;
  initialManagedService?: string;
  onPauseRuntime?: () => Promise<string | undefined>;
  onOperation?: (operation: Promise<void>) => void;
}

export function helpTextForScreen(screen: Screen, searching = false): string | undefined {
  if (searching) return "Type to search  Backspace delete  Enter apply  Esc cancel";
  if (screen === "threads") return "↑/↓ or j/k move  Space select  a all  / search  Enter continue  Esc back/quit  q quit";
  if (screen === "source" || screen === "workspace" || screen === "provider" || screen === "destination") return "↑/↓ or j/k move  Enter choose  Esc back/quit  q quit";
  if (screen === "review") return "Enter confirm  Esc back  q quit";
  if (screen === "result") return "↑/↓ or j/k move  Enter confirm  q quit";
  return undefined;
}

function Help({ screen, searching }: { screen: Screen; searching: boolean }): React.JSX.Element | null {
  const text = helpTextForScreen(screen, searching);
  return text ? <Text dimColor>{text}</Text> : null;
}

export function selectionMarker(isSelected: boolean, isDisabled: boolean): string {
  if (isDisabled) return "⊘";
  return isSelected ? "◉" : "○";
}

function Menu({ items, index, selected, disabled }: { items: string[]; index: number; selected?: Set<number>; disabled?: Set<number> }): React.JSX.Element {
  return <Box flexDirection="column">{items.map((item, itemIndex) => {
    const isDisabled = disabled?.has(itemIndex) ?? false;
    return <Text key={`${itemIndex}:${item}`} dimColor={isDisabled} {...(itemIndex === index && !isDisabled ? { color: "cyan" as const } : {})}>
      {itemIndex === index ? "›" : " "} {selected ? selectionMarker(selected.has(itemIndex), isDisabled) : ""} {item}
    </Text>;
  })}</Box>;
}

export function StartT3Prompt({ index }: { index: number }): React.JSX.Element {
  return <>
    <Text bold>Start T3 Code now?</Text>
    <Menu items={["Yes", "No"]} index={index} />
    <Text dimColor>Press Enter to confirm.</Text>
  </>;
}

export function ReplacementReview({
  workspace,
  selections,
  previews,
  counts,
  resetCache,
}: {
  workspace: string | undefined;
  selections: ReplaceSelection[];
  previews: Map<string, ConversationReplacePreview>;
  counts: { tasks: number; turns: number; events: number; attachments: number };
  resetCache: boolean;
}): React.JSX.Element {
  const taskWord = counts.tasks === 1 ? "task" : "tasks";
  return <>
    <Text bold>Review replacement</Text>
    <Text>Workspace: {workspace}</Text>
    <Box marginTop={1} flexDirection="column">
      {selections.map((selection) => {
        const preview = previews.get(selection.conversation.summary.id);
        return <Box key={`replacement-review:${selection.conversation.summary.id}`} flexDirection="column">
          <Text bold>{selection.conversation.summary.title}</Text>
          <Text>Old T3 task: {preview?.oldThreadId}</Text>
          <Text>New T3 task: {preview?.newThreadId}</Text>
        </Box>;
      })}
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>The new {taskWord} will contain:</Text>
      <Text>  {counts.turns} turns · {counts.events} events · {counts.attachments} attachments</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>The provider, model, and resume connection will transfer to the new {taskWord}.</Text>
      <Text>The old {taskWord} will disappear from T3 but remain in its event history.</Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>When you confirm, t3-import will automatically:</Text>
      <Text>  • Create a verified backup of the T3 database</Text>
      <Text>  {resetCache ? "• Back up and reset T3's UI cache" : "• Keep T3's existing UI cache (--no-cache-reset)"}</Text>
    </Box>
    <Text color="yellow">T3 must remain closed.</Text>
    <Text bold>Press Enter to replace, or Escape to cancel.</Text>
  </>;
}

export function conversationStatusText(preview: ConversationSyncPreview | undefined, checking: boolean): string {
  if (!preview) return checking ? "checking…" : "unavailable";
  if (preview.status === "new") return "new";
  if (preview.status === "active-only") return "active turn only";
  if (preview.status === "syncable") {
    const added = `${preview.newTurns} new turn${preview.newTurns === 1 ? "" : "s"}`;
    const statuses: string[] = [];
    if (preview.newInterruptedTurns) statuses.push(preview.newTurns === 1 ? "interrupted" : `${preview.newInterruptedTurns} interrupted`);
    if (preview.newFailedTurns) statuses.push(preview.newTurns === 1 ? "failed" : `${preview.newFailedTurns} failed`);
    const detail = statuses.length ? ` · ${statuses.join(", ")}` : "";
    return preview.adoptedTurns ? `${added}${detail}, ${preview.adoptedTurns} adopted` : `${added}${detail}`;
  }
  if (preview.status === "up-to-date") return `up to date${preview.ignoredActiveTurns ? ` · ${preview.ignoredActiveTurns} active turn${preview.ignoredActiveTurns === 1 ? "" : "s"} ignored` : ""}`;
  if (preview.status === "history-diverged") return "history changed";
  if (preview.status === "branch-sync-unsupported") return "branch sync unsupported";
  return "target missing";
}

export function replacementStatusText(preview: ConversationReplacePreview | undefined, checking: boolean): string {
  if (!preview) return checking ? "checking…" : "unavailable";
  if (preview.status === "replaceable") return "replace available";
  if (preview.status === "already-current") return "already current";
  if (preview.status === "active-source") return "active source";
  if (preview.status === "branch-replace-unsupported") return "branch replacement unsupported";
  if (preview.status === "not-imported") return "not imported";
  return "target missing";
}

export function ConversationStatusDetails({ preview, replacement, checking, error, mode = "auto", review = false }: {
  preview?: ConversationSyncPreview | undefined;
  replacement?: ConversationReplacePreview | undefined;
  checking: boolean;
  error?: string | undefined;
  mode?: "auto" | "sync" | "replace";
  review?: boolean;
}): React.JSX.Element {
  let action: string;
  if (error) action = "Unavailable: inspection failed. Resolve the error and reopen this workspace.";
  else if (mode === "replace") action = replacement?.selectable
    ? "Select to review replacement. Existing history will be replaced only after confirmation."
    : checking && !replacement ? "Checking replacement eligibility…" : "Replacement is unavailable for this conversation.";
  else if (!preview) action = checking ? "Checking source history and target identity…" : "No reconciliation preview is available.";
  else if (preview.status === "new") action = mode === "sync"
    ? "No eligible sync target was found. Use import to review a new conversation."
    : "Select to import a new conversation. No eligible existing target was found.";
  else if (preview.status === "syncable") action = "Select to append the settled missing turns. Existing messages and local titles are preserved.";
  else if (preview.status === "up-to-date") action = "No settled messages need importing.";
  else if (preview.status === "active-only") action = "Wait for the source turn to finish, then reopen this workspace to check again.";
  else if (preview.status === "history-diverged") action = replacement?.selectable && mode === "auto"
    ? "Conflict: select to review replacement. Histories will not be merged automatically."
    : "Conflict: inspect the differing histories before choosing replacement.";
  else if (preview.status === "branch-sync-unsupported") action = "Conflict: branches require separate inspection; automatic sync is unavailable.";
  else action = "The previous target is missing. Inspect or restore it before retrying.";
  if (review && preview?.status === "new") action = "Will import a new conversation after confirmation.";
  if (review && preview?.status === "syncable") action = `Will append ${preview.newTurns} settled turn(s) after confirmation. Existing messages and local titles are preserved.`;
  const warnings = [...new Set([...(preview?.warnings ?? []), ...(replacement?.warnings ?? [])])];
  return <Box flexDirection="column" marginTop={1}>
    <Text>{action}</Text>
    {preview?.ignoredActiveTurns ? <Text color="yellow">{preview.ignoredActiveTurns} unfinished source turn(s) excluded; only settled history is eligible.</Text> : null}
    {error ? <Text color="yellow">Reason: {error}</Text> : null}
    {warnings.map((warning) => <Text key={warning} color="yellow">Reason: {warning}</Text>)}
  </Box>;
}

export function ImportTui({ paths, initialSource, initialWorkspace, initialProvider, mode = "auto", resetCache = false, initialManagedService, onPauseRuntime, onOperation }: TuiProps): React.JSX.Element {
  const app = useApp();
  const [screen, setScreen] = useState<Screen>("preflight");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [managedService, setManagedService] = useState(initialManagedService);
  const [maintenanceError, setMaintenanceError] = useState<string>();
  const [source, setSource] = useState<SourceName>(initialSource ?? "codex");
  const [summaries, setSummaries] = useState<SourceSummary[]>([]);
  const [workspace, setWorkspace] = useState<string>();
  const [provider, setProvider] = useState<string | undefined>(initialProvider);
  const [destinationChoices, setDestinationChoices] = useState<TuiDestinationChoice[]>([]);
  const [destinationError, setDestinationError] = useState<string>();
  const [destinationOptions, setDestinationOptions] = useState<DestinationOptions>({});
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [conversations, setConversations] = useState(new Map<string, CanonicalConversation>());
  const [syncPreviews, setSyncPreviews] = useState(new Map<string, ConversationSyncPreview>());
  const [replacePreviews, setReplacePreviews] = useState(new Map<string, ConversationReplacePreview>());
  const [pendingStatuses, setPendingStatuses] = useState(0);
  const [inspectionErrors, setInspectionErrors] = useState(new Map<string, string>());
  const [preparedImports, setPreparedImports] = useState<ImportSelection[]>([]);
  const [preparedSync, setPreparedSync] = useState<SyncSelection[]>([]);
  const [preparedReplacements, setPreparedReplacements] = useState<ReplaceSelection[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ImportRunResult>();
  const [syncResult, setSyncResult] = useState<SyncRunResult>();
  const [replaceResult, setReplaceResult] = useState<ReplaceRunResult>();
  const [error, setError] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const [cacheWarning, setCacheWarning] = useState<string>();
  const checkingStatuses = pendingStatuses > 0;

  const navigate = useCallback((next: Screen) => {
    setScreenHistory((history) => [...history, screen]);
    setScreen(next);
    setIndex(0);
  }, [screen]);

  const workspaces = useMemo(() => [...new Map(summaries.map((summary) => [summary.workspace.toLowerCase(), summary.workspace])).values()], [summaries]);
  const providers = useMemo(() => listProviderInstances(paths, source), [paths, source]);
  const visibleThreads = useMemo(() => summaries
    .filter((summary) => !workspace || summary.workspace.toLowerCase() === workspace.toLowerCase())
    .filter((summary) => mode !== "replace" || !replacePreviews.has(summary.id) || replacePreviews.get(summary.id)?.previouslyImported)
    .filter((summary) => !query || summary.title.toLowerCase().includes(query.toLowerCase()) || summary.id.includes(query)), [mode, query, replacePreviews, summaries, workspace]);
  const operationFor = useCallback((summary: SourceSummary): "replace" | "regular" | undefined => {
    const preview = syncPreviews.get(summary.id);
    const replacement = replacePreviews.get(summary.id);
    if (mode === "replace") return replacement?.selectable ? "replace" : undefined;
    if (mode === "sync") return preview?.status === "syncable" ? "regular" : undefined;
    if (replacement?.selectable && preview?.status === "history-diverged") return "replace";
    return preview?.selectable ? "regular" : undefined;
  }, [mode, replacePreviews, syncPreviews]);
  const canSelect = useCallback((summary: SourceSummary) => {
    const operation = operationFor(summary);
    if (!operation) return false;
    const selectedOperation = [...selected].map((id) => summaries.find((item) => item.id === id)).filter((item): item is SourceSummary => Boolean(item)).map(operationFor).find(Boolean);
    return !selectedOperation || selectedOperation === operation;
  }, [operationFor, selected, summaries]);
  const selectedVisible = useMemo(
    () => new Set(visibleThreads.flatMap((summary, itemIndex) => selected.has(summary.id) ? [itemIndex] : [])),
    [selected, visibleThreads],
  );
  const disabledVisible = useMemo(
    () => new Set(visibleThreads.flatMap((summary, itemIndex) => canSelect(summary) ? [] : [itemIndex])),
    [canSelect, visibleThreads],
  );
  const statusCounts = useMemo(() => {
    const counts = { new: 0, syncable: 0, current: 0, active: 0, conflicts: 0, unavailable: 0 };
    for (const summary of visibleThreads) {
      if (inspectionErrors.has(summary.id)) { counts.unavailable += 1; continue; }
      const status = syncPreviews.get(summary.id)?.status;
      if (status === "new") counts.new += 1;
      else if (status === "syncable") counts.syncable += 1;
      else if (status === "up-to-date") counts.current += 1;
      else if (status === "active-only") counts.active += 1;
      else if (status) counts.conflicts += 1;
    }
    return counts;
  }, [visibleThreads, syncPreviews, inspectionErrors]);
  const importPreview = useMemo(() => preparedImports.reduce((counts, selection) => {
    for (const sourceThread of selection.conversation.threads) {
      const thread = compactThreadForImport(sourceThread);
      counts.tasks += 1;
      counts.turns += thread.turns.length;
      counts.messages += thread.turns.reduce((sum, turn) => sum + 1 + turn.assistant.length, 0);
      counts.activities += thread.turns.reduce((sum, turn) => sum + turn.activities.length, 0) + (thread.currentBranch ? 0 : 1);
      counts.attachments += thread.turns.reduce((sum, turn) => sum + turn.user.attachments.length, 0);
    }
    return counts;
  }, { tasks: 0, turns: 0, messages: 0, activities: 0, attachments: 0 }), [preparedImports]);
  const syncPreview = useMemo(() => preparedSync.reduce((counts, selection) => {
    const preview = syncPreviews.get(selection.conversation.summary.id);
    counts.tasks += 1;
    counts.turns += preview?.newTurns ?? 0;
    counts.adopted += preview?.adoptedTurns ?? 0;
    counts.titles += preview?.titleChanged ? 1 : 0;
    return counts;
  }, { tasks: 0, turns: 0, adopted: 0, titles: 0 }), [preparedSync, syncPreviews]);
  const replacementPreview = useMemo(() => preparedReplacements.reduce((counts, selection) => {
    const preview = replacePreviews.get(selection.conversation.summary.id);
    counts.tasks += 1;
    counts.turns += preview?.turns ?? 0;
    counts.events += preview?.events ?? 0;
    counts.attachments += preview?.attachments ?? 0;
    return counts;
  }, { tasks: 0, turns: 0, events: 0, attachments: 0 }), [preparedReplacements, replacePreviews]);

  const checkRuntime = useCallback(() => {
    setScreenHistory([]);
    setScreen("preflight");
    inspectRuntimeStatus(paths)
      .then((state) => {
        setRuntime(state);
        setScreen(state.live ? "blocked" : initialSource ? "workspace" : "source");
      })
      .catch((cause) => {
        setError(`Unable to check T3 runtime: ${cause instanceof Error ? cause.message : String(cause)}`);
        setScreen("error");
      });
  }, [initialSource, paths]);

  useEffect(() => { checkRuntime(); }, [checkRuntime]);

  useEffect(() => {
    if (screen !== "workspace") return;
    let cancelled = false;
    setIndex(0);
    sourceAdapter(source).discover({}).then((items) => {
      if (cancelled) return;
      setSummaries(items);
      const selectedWorkspace = initialWorkspace
        ? items.find((item) => item.workspace.toLowerCase() === initialWorkspace.toLowerCase())?.workspace
        : undefined;
      if (selectedWorkspace) {
        setWorkspace(selectedWorkspace);
        setProvider(initialProvider ?? providers[0]);
        // An explicit --workspace bypasses the chooser and its navigation history.
        setScreen("threads");
      }
    }).catch((cause) => { if (!cancelled) { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); } });
    return () => { cancelled = true; };
  }, [screen, source]);

  useEffect(() => {
    if (screen !== "threads" || !workspace) return;
    let cancelled = false;
    const items = summaries.filter((summary) => summary.workspace.toLowerCase() === workspace.toLowerCase());
    const queue = [...items];
    setPendingStatuses(items.length);
    setSelected(new Set());
    setConversations(new Map());
    setSyncPreviews(new Map());
    setReplacePreviews(new Map());
    setInspectionErrors(new Map());
    const worker = async () => {
      while (!cancelled) {
        const summary = queue.shift();
        if (!summary) return;
        try {
          const conversation = await sourceAdapter(source).load(summary, { workspace });
          const preview = mode === "replace" ? undefined : await inspectConversationSync(conversation, paths);
          const replacement = mode === "replace" || preview?.status === "history-diverged"
            ? await inspectConversationReplacement(conversation, paths)
            : undefined;
          if (cancelled) return;
          setConversations((current) => new Map(current).set(summary.id, conversation));
          if (preview) setSyncPreviews((current) => new Map(current).set(summary.id, preview));
          if (replacement) setReplacePreviews((current) => new Map(current).set(summary.id, replacement));
          setSummaries((current) => current.map((item) => item.id === summary.id
            ? { ...item, title: conversation.summary.title, updatedAt: conversation.summary.updatedAt, status: conversation.summary.status }
            : item));
        } catch (cause) {
          if (!cancelled) setInspectionErrors((current) => new Map(current).set(summary.id,
            cause instanceof Error ? cause.message : String(cause)));
        } finally {
          if (!cancelled) setPendingStatuses((count) => Math.max(0, count - 1));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, items.length) }, () => worker()));
    return () => { cancelled = true; };
  }, [mode, paths, screen, source, workspace]);

  useEffect(() => {
    if (screen !== "destination" || !workspace) return;
    try {
      setDestinationChoices(discoverTuiDestinations(paths, workspace));
      setDestinationError(undefined);
      setDestinationOptions({});
      setIndex(0);
    } catch (cause) {
      setDestinationError(cause instanceof Error ? cause.message : String(cause));
      setDestinationChoices([]);
    }
  }, [paths, screen, workspace]);

  const move = (delta: number, length: number) => setIndex((current) => length === 0 ? 0 : (current + delta + length) % length);
  useInput((input, key) => {
    if (screen === "running" || screen === "maintenance") return;
    if (searching) {
      if (key.escape || key.return) setSearching(false);
      else if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1));
      else if (!key.ctrl && !key.meta && input) setQuery((value) => value + input);
      return;
    }
    if (input === "q") { app.exit(); return; }
    if (screen === "blocked" && (input === "r" || key.return)) { checkRuntime(); return; }
    if (screen === "blocked" && input === "s" && runtime?.activity.status === "idle" && runtime.service && onPauseRuntime) {
      setScreen("pause-confirm"); return;
    }
    if (screen === "pause-confirm") {
      if (key.escape) { setScreen("blocked"); return; }
      if (key.return && onPauseRuntime) {
        setScreen("maintenance");
        onPauseRuntime().then((unit) => {
          setManagedService(unit);
          setMaintenanceError(undefined);
          checkRuntime();
        }).catch((cause) => {
          setMaintenanceError(cause instanceof Error ? cause.message : String(cause));
          setScreen("blocked");
        });
      }
      return;
    }
    if (key.upArrow || input === "k") {
      move(-1, screen === "source" ? sourceNames.length : screen === "result" ? 2 : screen === "workspace" ? workspaces.length : screen === "provider" ? providers.length : screen === "destination" ? destinationChoices.length : visibleThreads.length);
      return;
    }
    if (key.downArrow || input === "j") {
      move(1, screen === "source" ? sourceNames.length : screen === "result" ? 2 : screen === "workspace" ? workspaces.length : screen === "provider" ? providers.length : screen === "destination" ? destinationChoices.length : visibleThreads.length);
      return;
    }
    if (key.escape) {
      const previous = escapeDestination(screen, screenHistory);
      if (!previous) { app.exit(); return; }
      if (screen === "provider" && previous === "threads") { setPreparedImports([]); setPreparedSync([]); setPreparedReplacements([]); }
      setScreenHistory((history) => history.slice(0, -1));
      setScreen(previous);
      setIndex(0);
      return;
    }
    if (screen === "source" && key.return) {
      setSource(sourceNames[index]!); setSelected(new Set()); setPreparedImports([]); setPreparedSync([]); setPreparedReplacements([]); navigate("workspace"); return;
    }
    if (screen === "workspace" && key.return && workspaces[index]) {
      setWorkspace(workspaces[index]); setProvider(initialProvider ?? providers[0]); navigate("threads"); return;
    }
    if (screen === "provider" && key.return && providers[index]) {
      setProvider(providers[index]); navigate(preparedImports.length ? "destination" : "threads"); return;
    }
    if (screen === "destination" && key.return && destinationChoices[index]) {
      setDestinationOptions(destinationChoices[index]!.options ?? {}); navigate("review"); return;
    }
    if (screen === "threads") {
      if (input === "/") { setSearching(true); return; }
      if (input === "a") {
        const currentOperation = visibleThreads[index] ? operationFor(visibleThreads[index]!) : undefined;
        const operation = currentOperation ?? visibleThreads.map(operationFor).find(Boolean);
        const selectable = visibleThreads.filter((summary) => canSelect(summary) && operationFor(summary) === operation);
        setSelected((value) => selectable.every((summary) => value.has(summary.id))
          ? new Set([...value].filter((id) => !selectable.some((summary) => summary.id === id)))
          : new Set([...value, ...selectable.map((summary) => summary.id)]));
        return;
      }
      if (input === " " && visibleThreads[index] && canSelect(visibleThreads[index]!)) {
        const id = visibleThreads[index]!.id;
        setSelected((value) => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next; }); return;
      }
      if (key.return && selected.size > 0) {
        const chosen = summaries.filter((summary) => selected.has(summary.id));
        const imports: ImportSelection[] = [];
        const syncs: SyncSelection[] = [];
        const replacements: ReplaceSelection[] = [];
        for (const summary of chosen) {
          const conversation = conversations.get(summary.id);
          const preview = syncPreviews.get(summary.id);
          if (!conversation) continue;
          if (operationFor(summary) === "replace") replacements.push({ conversation });
          else if (preview?.status === "new" && mode === "auto") imports.push({ conversation, resume: true });
          else if (preview?.status === "syncable") syncs.push({ conversation });
        }
        setPreparedImports(imports); setPreparedSync(syncs); setPreparedReplacements(replacements);
        if (imports.length > 0) {
          setDestinationOptions({});
          navigate(!initialProvider && providers.length > 1 ? "provider" : "destination");
        } else navigate("review");
        return;
      }
    }
    if (screen === "review" && key.return) {
      setScreen("running");
      const run = async () => {
        const imported = preparedImports.length
          ? await importConversations(preparedImports, paths, { dryRun: false, resume: true, ...(provider ? { providerInstance: provider } : {}), ...destinationOptions })
          : undefined;
        const synced = preparedSync.length
          ? await syncConversations(preparedSync, paths, { dryRun: false, allowProjectionBacklog: Boolean(imported?.results.some((item) => item.status === "imported")) })
          : undefined;
        const replaced = preparedReplacements.length
          ? await replaceConversations(preparedReplacements, paths, { dryRun: false })
          : undefined;
        const changed = Boolean(imported?.results.some((item) => item.status === "imported")) || Boolean(synced?.results.some((item) => item.status === "synced")) || Boolean(replaced?.results.some((item) => item.status === "replaced"));
        if (resetCache && changed) {
          try {
            const cache = await resetT3RebuildableCache(paths);
            const holder = replaced ?? synced ?? imported;
            if (holder) {
              holder.cache = cache;
              holder.warnings.push(...cache.warnings);
            }
          } catch (cause) {
            setCacheWarning(`T3 data was updated, but its IndexedDB cache could not be reset: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
        setResult(imported); setSyncResult(synced); setReplaceResult(replaced); setIndex(0); setScreen("result");
      };
      const operation = run().catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setScreen("error"); });
      onOperation?.(operation);
    }
    if (screen === "result" && key.return) {
      if (managedService) { app.exit(); return; }
      if (index === 1) { app.exit(); return; }
      setScreen("launching");
      launchT3Code().then(() => app.exit()).catch((cause) => {
        setLaunchError(cause instanceof Error ? cause.message : String(cause)); setScreen("launch-error");
      });
      return;
    }
    if ((screen === "launch-error" || screen === "error") && key.return) app.exit();
  });

  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">t3-import</Text>
    <Text dimColor>Target: {paths.dbPath}</Text>
    {managedService ? <Text color="yellow">Paused service: {managedService}. It will restart automatically when you exit.</Text> : null}
    <Box marginTop={1} flexDirection="column">
      {screen === "preflight" && <Text>Checking whether T3 is running…</Text>}
      {screen === "blocked" && <>
        <Text bold color="red">T3 is running</Text>
        <Text>Close T3 before importing, syncing, or replacing{runtime?.pid ? ` (detected PID ${runtime.pid})` : ""}.</Text>
        {runtime?.activity ? <Text>{runtimeActivityText(runtime.activity)}</Text> : null}
        {runtime?.activity.warnings.map((warning) => <Text key={warning} color="yellow">{warning}</Text>)}
        {runtime?.service ? <Text>Service: systemd {runtime.service.scope} · {runtime.service.unit}</Text> : <Text dimColor>{runtime?.managementUnavailable}</Text>}
        {runtime?.origin ? <Text dimColor>Runtime: {runtime.origin}</Text> : null}
        {maintenanceError ? <Text color="red">{maintenanceError}</Text> : null}
        {runtime?.activity.status === "idle" && runtime.service && onPauseRuntime ? <Text>Press s to pause the service and continue. It will restart automatically on exit.</Text> : null}
        <Text>Press r or Enter to check again, or q to quit.</Text>
      </>}
      {screen === "pause-confirm" && <>
        <Text bold>Pause {runtime?.service?.unit} for maintenance?</Text>
        <Text>T3 and T3 Connect clients will disconnect until this command exits.</Text>
        <Text>The same systemd unit will restart after success, cancellation, or error.</Text>
        <Text>Activity is checked again before stopping and before database writes.</Text>
        <Text>Press Enter to pause, Escape to go back, or q to quit.</Text>
      </>}
      {screen === "maintenance" && <Text>Pausing the idle T3 service and verifying that it has stopped…</Text>}
      {screen === "source" && <><Text bold>Choose a source</Text><Menu items={sourceNames.map(sourceLabel)} index={index} /></>}
      {screen === "workspace" && <><Text bold>Choose a workspace</Text>{summaries.length === 0 ? <Text>Discovering {source} conversations…</Text> : <Menu items={workspaces} index={index} />}</>}
      {screen === "provider" && <><Text bold>Choose a T3 provider instance</Text><Menu items={providers} index={index} /></>}
      {screen === "destination" && <><Text bold>Choose a T3 destination for new imports</Text><Text dimColor>Available choices preserve the source working directory.</Text>{destinationError ? <Text color="red">{destinationError}</Text> : destinationChoices.length ? <Menu items={destinationChoices.map((choice) => choice.label)} index={index} /> : <Text>Checking available destinations…</Text>}</>}
      {screen === "threads" && <>
        <Text bold>{mode === "sync" ? "Select conversations to sync" : mode === "replace" ? "Select conversations to replace" : "Select conversations"} — {workspace}</Text>
        {searching || query ? <Text color="yellow">Search: {query}<Text dimColor>_</Text></Text> : null}
        <Menu items={visibleThreads.map((item) => {
          const syncText = conversationStatusText(syncPreviews.get(item.id), checkingStatuses);
          const replacement = replacePreviews.get(item.id);
          const status = mode === "replace"
            ? replacementStatusText(replacement, checkingStatuses)
            : syncPreviews.get(item.id)?.status === "history-diverged" && replacement?.selectable
              ? "history changed · replace available"
              : syncText;
          return `${item.title}  ${status}`;
        })} index={index} selected={selectedVisible} disabled={disabledVisible} />
        {mode !== "replace" ? <Text dimColor>
          New: {statusCounts.new}{" · To sync: "}{statusCounts.syncable}
          {" · Current: "}{statusCounts.current}{" · Active only: "}{statusCounts.active}
          {" · Conflicts: "}{statusCounts.conflicts}{" · Unavailable: "}{statusCounts.unavailable}
        </Text> : null}
        {visibleThreads[index] ? <ConversationStatusDetails
          preview={syncPreviews.get(visibleThreads[index]!.id)}
          replacement={replacePreviews.get(visibleThreads[index]!.id)}
          checking={checkingStatuses}
          error={inspectionErrors.get(visibleThreads[index]!.id)}
          mode={mode}
        /> : null}
        {pendingStatuses > 0 ? <Text dimColor>Checking {pendingStatuses} conversation{pendingStatuses === 1 ? "" : "s"}…</Text> : null}
        {visibleThreads.length === 0 && <Text color="yellow">No matching conversations.</Text>}
      </>}
      {screen === "review" && <>
        {preparedReplacements.length ? <>
          <ReplacementReview workspace={workspace} selections={preparedReplacements} previews={replacePreviews} counts={replacementPreview} resetCache={resetCache} />
        </> : <>
          <Text bold>Review changes</Text>
          <Text>Source: {source} · Workspace: {workspace}</Text>
          {preparedImports.length ? <><Text>Source working directory: {workspace}</Text><Text>Effective T3 working directory: {workspace}</Text><Text>Destination: {destinationChoices.find((choice) => JSON.stringify(choice.options ?? {}) === JSON.stringify(destinationOptions))?.label ?? "Use workspace project automatically"}</Text></> : null}
          <Text>New tasks: {importPreview.tasks} · synchronized tasks: {syncPreview.tasks}</Text>
          <Text>Imported turns: {importPreview.turns} · added turns: {syncPreview.turns} · adopted turns: {syncPreview.adopted}</Text>
          <Text>Messages: {importPreview.messages} · activities: {importPreview.activities} · attachments: {importPreview.attachments}</Text>
          <Text>Title updates: {syncPreview.titles}</Text>
          {[...preparedImports, ...preparedSync].map((selection) => <Box key={selection.conversation.summary.id} flexDirection="column" marginTop={1}>
            <Text bold>{selection.conversation.summary.title}</Text>
            <ConversationStatusDetails preview={syncPreviews.get(selection.conversation.summary.id)} checking={false} mode={mode} review />
          </Box>)}
          {preparedImports.length ? <Text>Provider for new tasks: {provider}</Text> : null}
          {resetCache ? <Text>T3 IndexedDB cache: back up and reset after successful changes</Text> : <Text>T3 IndexedDB cache: keep existing cache</Text>}
          <Text color="yellow">T3 must remain closed. A verified backup will be created before database changes.</Text>
          <Text bold>Press Enter to continue, Escape to go back.</Text>
        </>}
      </>}
      {screen === "running" && <Text>Backing up and reconciling conversations…</Text>}
      {screen === "result" && (result || syncResult || replaceResult) && <>
        <Text bold color="green">Complete</Text>
        {result ? <Text>Import backup: {result.backup ?? "not needed"}</Text> : null}
        {result?.results.map((item) => <Text key={`import:${item.threadId}`}>{item.status === "imported" ? "✓" : "•"} {item.title} — {item.status}, {item.turns} turns, {item.events} events</Text>)}
        {syncResult ? <Text>Sync backup: {syncResult.backup ?? "not needed"}</Text> : null}
        {syncResult?.results.map((item) => <Text key={`sync:${item.sourceKey}`}>{item.status === "synced" ? "✓" : "•"} {item.title} — {item.status}, {item.turnsAdded} added, {item.turnsAdopted} adopted, {item.events} events</Text>)}
        {replaceResult ? <Text>Replacement backup: {replaceResult.backup ?? "not needed"}</Text> : null}
        {replaceResult?.results.map((item) => <Text key={`replace:${item.sourceKey}`}>{item.status === "replaced" ? "✓" : "•"} {item.title} — {item.status}{item.oldThreadId ? `, old ${item.oldThreadId}` : ""}{item.newThreadId ? `, new ${item.newThreadId}` : ""}, {item.turns} turns, {item.events} events</Text>)}
        {(replaceResult?.cache ?? syncResult?.cache ?? result?.cache) ? <Text>Cache backup: {(replaceResult?.cache ?? syncResult?.cache ?? result?.cache)?.backup ?? "cache not found"}</Text> : null}
        {cacheWarning ? <Text color="yellow">{cacheWarning}</Text> : null}
        {managedService ? <Text>Press Enter or q to exit and restore {managedService}.</Text> : <StartT3Prompt index={index} />}
      </>}
      {screen === "launching" && <Text>Starting T3 Code…</Text>}
      {screen === "launch-error" && <><Text bold color="red">Could not start T3 Code</Text><Text>{launchError}</Text><Text dimColor>Press Enter to exit and start it manually.</Text></>}
      {screen === "error" && <><Text bold color="red">Operation failed</Text><Text>{error}</Text><Text dimColor>Press Enter to exit.</Text></>}
    </Box>
    {helpTextForScreen(screen, searching) ? <Box marginTop={1}><Help screen={screen} searching={searching} /></Box> : null}
  </Box>;
}
