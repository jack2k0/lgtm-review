import { z } from "zod";

export const Story = z.object({
  id: z.string(),
  title: z.string(),
});
export type Story = z.infer<typeof Story>;

export {
  Status,
  Warning,
  FileChange,
  TimeSplit,
  Severity,
  HintRule,
  Hint,
  Recommendation,
  PromptAnalysis,
  SessionAnalysis,
  Analysis,
  SessionSummary,
  SessionsResponse,
  Phase,
  Action,
  StepCheck,
  Step,
  PromptDetail,
  DiffLine,
  Hunk,
  FileDiff,
  MapNode,
  MapPoint,
  MapEdge,
  MapLayer,
  ImportMapResponse,
  PlayBeatKind,
  PlayBeatFocusEdge,
  PlayBeatFocus,
  PlayBeat,
  PlayResponse,
  GitFileEntry,
  GitCrosscheckResponse,
} from "./schema.js";
export { makeHeadline } from "./timing.js";
export { computeHints, recommend, isTestPath, sensitiveMatch, isManifestPath, isConfigPath, publicSurfaceKind } from "./hints.js";
export { classifyCommand } from "./check-patterns.js";
export { SHELL_EDIT_FILE, classifyShellMutation } from "./shell-edits.js";
export type { ShellMutation } from "./shell-edits.js";
export type { CommandClass, RepoScripts } from "./check-patterns.js";
export { analyzeSession, createAnalyzer } from "./analyze.js";
export type { AnalyzeOptions, Analyzer } from "./analyze.js";
export { createSubagentCollector, parseSubagent, mergeSubagents, SUBAGENT_DEPTH_MAX, PROMPT_SUBAGENT_EVENTS_MAX, TRANSCRIPT_EVENTS_MAX, TRANSCRIPT_TEXT_MAX } from "./subagents.js";
export type { SubagentTranscript, SubagentCollector, SubagentCollectorOptions, Truncation, MergeFlags, MergeContext } from "./subagents.js";
export type { Event, ToolUseEvent, ToolResultEvent, TextEvent, PromptEvent, BoundaryEvent } from "./parse.js";
export { redact, isEnvFilePath } from "./redact.js";
export type { RedactOptions, RedactResult } from "./redact.js";
export { inheritedSource, markInherited, ownershipRanks } from "./inherit.js";
export {
  extractImports,
  edgeKindFor,
  cleanSpecifier,
  normalizePath,
  stripJsonComments,
  loadTsconfigAliases,
  createResolver,
  mapLanguageOf,
  IMPORT_EXTENSIONS,
} from "./map-extract.js";
export type { ImportSyntax, ExtractedImport, MapHost, TsconfigAlias, Resolver, ResolverOptions } from "./map-extract.js";
export { extractPythonImports, createPythonResolver } from "./map-extract-py.js";
export type { PythonImport, PythonResolverOptions, PythonResolver } from "./map-extract-py.js";
export {
  layerOf,
  selectMapNodes,
  layoutImportMap,
  MAP_NODE_MAX,
  MAP_COLUMNS,
  MAP_NODE_WIDTH,
  MAP_NODE_HEIGHT,
  MAP_GAP_X,
  MAP_GAP_Y,
  MAP_LAYER_GAP,
  MAP_PAD,
} from "./map-layout.js";
export type { MapNodeInput, MapEdgeInput, MapLayout, NeighbourRank, SelectedMapNodes, LayoutImportMapOptions } from "./map-layout.js";
export { buildBeats, BEATS_MAX } from "./play.js";
export type { BuildBeatsInput, BuildBeatsResult, DiffsInput } from "./play.js";
export { needsAttention } from "./attention.js";
