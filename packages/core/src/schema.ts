import { z } from "zod";

export const Status = z.enum(["checked", "unchecked", "failing", "no-changes"]);
export type Status = z.infer<typeof Status>;

export const Warning = z.object({
  file: z.string().optional(),
  line: z.number().int().nonnegative(),
  reason: z.string(),
});
export type Warning = z.infer<typeof Warning>;

export const FileChange = z.object({
  path: z.string(),
  kind: z.enum(["M", "A", "D"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  maybeIncomplete: z.boolean(),
});
export type FileChange = z.infer<typeof FileChange>;

/** Approximate active time per phase in milliseconds (see timing.ts for the model). */
export const TimeSplit = z.object({
  readMs: z.number().int().nonnegative(),
  writeMs: z.number().int().nonnegative(),
  checkMs: z.number().int().nonnegative(),
  fixMs: z.number().int().nonnegative(),
});
export type TimeSplit = z.infer<typeof TimeSplit>;

export const Severity = z.enum(["high", "warn", "info"]);
export type Severity = z.infer<typeof Severity>;

export const HintRule = z.enum([
  "test-modified-during-fix",
  "assertions-removed",
  "test-skipped",
  "sensitive-path",
  "unchecked-edit",
  "dependency-change",
  "public-surface",
  "config-change",
  "large-change",
]);
export type HintRule = z.infer<typeof HintRule>;

/** One "look here" pointer. `reason` states the evidence (counts, matched pattern); never command output or file content. */
export const Hint = z.object({
  rule: HintRule,
  severity: Severity,
  /** Path as in `PromptAnalysis.files`; null for prompt-level hints. */
  path: z.string().nullable(),
  reason: z.string(),
});
export type Hint = z.infer<typeof Hint>;

export const Recommendation = z.enum(["skim", "read-flagged", "read-all"]);
export type Recommendation = z.infer<typeof Recommendation>;

export const PromptAnalysis = z.object({
  index: z.number().int().nonnegative(),
  uuid: z.string(),
  /** First 200 characters of the prompt. */
  text: z.string(),
  status: Status,
  reason: z.string(),
  files: z.array(FileChange),
  /** True when the prompt spawned subagents whose activity could not be analysed (no transcript, or deeper than 3 levels). */
  partial: z.boolean(),
  timeSplit: TimeSplit,
  /** Union of all phase intervals; phases that overlap in time can make the four values sum to more. */
  activeMs: z.number().int().nonnegative(),
  /** One sentence, e.g. "Mostly writing (62%), 1 check"; "No timing data" when activeMs is 0. */
  headline: z.string(),
  /** Deduplicated per (rule, path), sorted by severity (high, warn, info), then rule, then path. */
  hints: z.array(Hint),
  recommendation: Recommendation,
  /** Session id of the session that owns this prompt; set by markInherited when the uuid was seen first in another session. Absent when not inherited. */
  inheritedFrom: z.string().optional(),
});
export type PromptAnalysis = z.infer<typeof PromptAnalysis>;

export const SessionAnalysis = z.object({
  sessionId: z.string(),
  title: z.string(),
  branch: z.string(),
  /** ISO timestamp of the first record that has one, or null. */
  startedAt: z.string().nullable(),
  prompts: z.array(PromptAnalysis),
  warnings: z.array(Warning),
  /** True only when the session was read from the local archive. */
  archived: z.boolean().optional(),
});
export type SessionAnalysis = z.infer<typeof SessionAnalysis>;

/** Result of analysing every session of a repo; the `--json` contract of the CLI. */
export const Analysis = z.object({
  dir: z.string(),
  sessions: z.array(SessionAnalysis),
});
export type Analysis = z.infer<typeof Analysis>;

/** One row of the session list (`GET /api/sessions`); no prompts. */
export const SessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  branch: z.string(),
  startedAt: z.string().nullable(),
  promptCount: z.number().int().nonnegative(),
  statusCounts: z.object({
    checked: z.number().int().nonnegative(),
    unchecked: z.number().int().nonnegative(),
    failing: z.number().int().nonnegative(),
    "no-changes": z.number().int().nonnegative(),
  }),
  warningCount: z.number().int().nonnegative(),
  /** Number of inherited prompts (excluded from promptCount and statusCounts). */
  inheritedCount: z.number().int().nonnegative().default(0),
  /** Session id that contributed the most inherited prompts (ties broken by ownership order: earliest startedAt, then smallest sessionId). Absent when inheritedCount is 0. */
  forkOf: z.string().optional(),
  /** True only when the session was read from the local archive. */
  archived: z.boolean().optional(),
  /** Own (non-inherited) prompts that need attention (`needsAttention`). Always set by the API. */
  attentionCount: z.number().int().nonnegative().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Body of `GET /api/sessions`. */
export const SessionsResponse = z.object({
  dir: z.string(),
  sessions: z.array(SessionSummary),
});
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** Phase of a step or action; same values as the keys of `TimeSplit` (without the `Ms` suffix). */
export const Phase = z.enum(["read", "write", "check", "fix"]);
export type Phase = z.infer<typeof Phase>;

/** One raw tool call of a step. `summary` is a file path, a command (<= 200 chars), a pattern or a tool name; never file content. */
export const Action = z.object({
  tool: z.string(),
  summary: z.string(),
  /** False when the call failed or has no result. */
  ok: z.boolean(),
  /** ISO timestamp of the call, or null when the log has none. */
  ts: z.string().nullable(),
  /** Set when the call was made by a subagent of the prompt (merged from its transcript). */
  via: z.literal("subagent").optional(),
});
export type Action = z.infer<typeof Action>;

/** Outcome of a check command. All null when the command has no usable result (still running, background, did not run). */
export const StepCheck = z.object({
  command: z.string(),
  exitCode: z.number().int().nonnegative().nullable(),
  passed: z.boolean().nullable(),
  /** First non-empty output lines of a failing check (<= 200 chars); empty otherwise. */
  excerpt: z.string(),
  /** The check ran in the background and its outcome comes from a task notification. */
  background: z.boolean().optional(),
  /** The background check was stopped or killed before it finished: no verdict. */
  stopped: z.boolean().optional(),
});
export type StepCheck = z.infer<typeof StepCheck>;

export const Step = z.object({
  /** 1-based position within the prompt. */
  n: z.number().int().positive(),
  phase: Phase,
  /** Mechanical title, e.g. "Read 3 files", "Fix: read 2 files, edit src/a.ts (+2 -1)", "Run pnpm test -> passed". */
  title: z.string(),
  startedAt: z.string().nullable(),
  /** Union of the step's action intervals (same model as the time split). */
  durationMs: z.number().int().nonnegative(),
  check: StepCheck.optional(),
  /** Agent text blocks (each <= 400 chars, at most 3) written right before the step's first action. */
  quotes: z.array(z.string()),
  actions: z.array(Action),
  /** Paths (as in `PromptAnalysis.files`) edited in this step; each can be opened with `diffFor`. */
  files: z.array(z.string()),
});
export type Step = z.infer<typeof Step>;

/** Everything the Steps view needs for one prompt (body of `GET /api/sessions/:id/prompts/:index`). */
export const PromptDetail = z.object({
  index: z.number().int().nonnegative(),
  /** First 200 characters of the prompt. */
  text: z.string(),
  status: Status,
  reason: z.string(),
  headline: z.string(),
  startedAt: z.string().nullable(),
  activeMs: z.number().int().nonnegative(),
  /** True when steps or actions were dropped because of the retention caps. */
  truncated: z.boolean(),
  /** Same as `PromptAnalysis.hints`/`recommendation`, so a deep link to the Steps view needs no session data. */
  hints: z.array(Hint),
  recommendation: Recommendation,
  steps: z.array(Step),
});
export type PromptDetail = z.infer<typeof PromptDetail>;

export const DiffLine = z.object({ t: z.enum(["+", "-", " "]), s: z.string() });
export type DiffLine = z.infer<typeof DiffLine>;

export const Hunk = z.object({
  /** `@@ -a,b +c,d @@` */
  header: z.string(),
  lines: z.array(DiffLine),
});
export type Hunk = z.infer<typeof Hunk>;

/** What the agent's edits did to one file, from the log only (not the final git state). */
export const FileDiff = z.object({
  path: z.string(),
  kind: z.enum(["M", "A", "D"]),
  /** Lines (2000 per diff) or characters (2000 per line) were cut. */
  truncated: z.boolean(),
  /** Shell edits, removals and moves may be missing. */
  maybeIncomplete: z.boolean(),
  hunks: z.array(Hunk),
});
export type FileDiff = z.infer<typeof FileDiff>;

/** A node of the 2D import map: a changed file or a direct (1-hop) in-repo import neighbour. */
export const MapNode = z.object({
  /** Node identity: repo-relative path with forward slashes. */
  id: z.string(),
  path: z.string(),
  /** Short display label (the file name); the full path stays in `path` for the SVG `<title>`. */
  label: z.string(),
  /** Layer band name (top-level folder, `packages/<x>`, `apps/<x>` or the file name for a root file). */
  layer: z.string(),
  /** `changed` files were edited in the prompt/session; `neighbour` files are unchanged and linked by an edge. */
  kind: z.enum(["changed", "neighbour"]),
  /** Verification status of the last prompt that changed the file; null for neighbours. */
  status: Status.nullable(),
  /** The changed file no longer exists on disk: no edges, click target disabled. */
  deleted: z.boolean(),
  /** Changed nodes: index of the last non-inherited prompt that changed the file (session map) or the requested prompt; null for neighbours. */
  promptIndex: z.number().int().nonnegative().nullable().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type MapNode = z.infer<typeof MapNode>;

/** One point of an edge path. */
export const MapPoint = z.object({ x: z.number(), y: z.number() });
export type MapPoint = z.infer<typeof MapPoint>;

/** A directed 1-hop import edge. `type` edges are type-only imports (drawn dashed). */
export const MapEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["import", "type"]),
  /** True when the import line was added by the prompt / session (plan D1). */
  new: z.boolean().optional(),
  /** Straight/elbow path from the source node border to the target node border. */
  points: z.array(MapPoint),
});
export type MapEdge = z.infer<typeof MapEdge>;

/** One horizontal layer band of the map. */
export const MapLayer = z.object({
  name: z.string(),
  /** Top edge of the band in map coordinates. */
  y: z.number(),
  height: z.number().nonnegative(),
  /** Number of nodes placed in the band. */
  nodeCount: z.number().int().nonnegative(),
});
export type MapLayer = z.infer<typeof MapLayer>;

/** Body of `GET /api/sessions/:id/map` (and `?prompt=N`). */
export const ImportMapResponse = z.object({
  sessionId: z.string(),
  /** Prompt index when the map is per-prompt; null for the session map. */
  prompt: z.number().int().nonnegative().nullable(),
  /** The map always describes the current working tree, never the tree at prompt time. */
  snapshot: z.literal("working-tree"),
  /** A cap dropped nodes or the neighbour scan hit its file/size cap. */
  truncated: z.boolean(),
  /** Number of ranked 1-hop neighbours dropped by the node cap. */
  hiddenNeighbours: z.number().int().nonnegative(),
  layers: z.array(MapLayer),
  nodes: z.array(MapNode),
  edges: z.array(MapEdge),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  /** Human-readable notes, e.g. "Neighbour scan unavailable (git ls-files failed): showing outgoing imports only." */
  notes: z.array(z.string()).optional(),
  /** True for a per-prompt map of a non-inherited prompt that has at least one step with files or a check (plan B2). */
  playable: z.boolean().optional(),
});
export type ImportMapResponse = z.infer<typeof ImportMapResponse>;

export const PlayBeatKind = z.enum([
  "file-added",
  "file-changed",
  "file-deleted",
  "import-added",
  "check-passed",
  "check-failed",
  "check-unknown",
]);
export type PlayBeatKind = z.infer<typeof PlayBeatKind>;

export const PlayBeatFocusEdge = z.object({
  from: z.string(),
  to: z.string(),
});
export type PlayBeatFocusEdge = z.infer<typeof PlayBeatFocusEdge>;

export const PlayBeatFocus = z.object({
  nodes: z.array(z.string()),
  edges: z.array(PlayBeatFocusEdge),
});
export type PlayBeatFocus = z.infer<typeof PlayBeatFocus>;

export const PlayBeat = z.object({
  /** 1-based position in the beat sequence. */
  n: z.number().int().positive(),
  kind: PlayBeatKind,
  /** True when the beat belongs to a Fix-phase step. */
  fix: z.boolean(),
  /** Step.n it comes from (1-based). */
  step: z.number().int().positive(),
  /** Template text, <= 160 chars. */
  text: z.string(),
  /** Check excerpt (<= 200 chars) for failed checks. */
  detail: z.string().optional(),
  /** The file (for file beats) or the importer (for import beats). */
  path: z.string().optional(),
  focus: PlayBeatFocus,
});
export type PlayBeat = z.infer<typeof PlayBeat>;

export const PlayResponse = z.object({
  sessionId: z.string(),
  prompt: z.number().int().nonnegative(),
  beats: z.array(PlayBeat),
  truncated: z.boolean(),
});
export type PlayResponse = z.infer<typeof PlayResponse>;
