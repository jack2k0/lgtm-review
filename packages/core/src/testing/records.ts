// Test-only builders for synthetic session records.
let counter = 0;

export function resetIds(): void {
  counter = 0;
}

/** ISO timestamp `sec` seconds after 2026-01-01T00:00:00Z (fractions allowed). */
export const at = (sec: number): string => new Date(Date.UTC(2026, 0, 1) + Math.round(sec * 1000)).toISOString();

function rec(type: string, extra: Record<string, unknown>): string {
  counter++;
  const o: Record<string, unknown> = {
    type,
    uuid: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    sessionId: "00000000-0000-4000-8000-000000000001",
    timestamp: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    cwd: "/home/user/project",
    gitBranch: "main",
    ...extra,
  };
  // `timestamp: null` builds a record without a timestamp.
  if (o.timestamp === null) delete o.timestamp;
  return JSON.stringify(o);
}

export const prompt = (text: unknown, extra: Record<string, unknown> = {}): string =>
  rec("user", { message: { role: "user", content: text }, ...extra });

/** `ts`: ISO string (see `at`), or null for a record without timestamp. */
export const toolUse = (id: string, name: string, input: Record<string, unknown>, ts?: string | null): string =>
  rec("assistant", {
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    ...(ts !== undefined ? { timestamp: ts } : {}),
  });

export const toolResult = (
  id: string,
  content: unknown,
  opts: { isError?: boolean; toolUseResult?: unknown; ts?: string | null } = {},
): string =>
  rec("user", {
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, ...(opts.isError ? { is_error: true } : {}) }],
    },
    ...(opts.toolUseResult !== undefined ? { toolUseResult: opts.toolUseResult } : {}),
    ...(opts.ts !== undefined ? { timestamp: opts.ts } : {}),
  });

export const patchResult = (added: string[], removed: string[]) => ({
  type: "update",
  structuredPatch: [{ oldStart: 1, oldLines: removed.length, newStart: 1, newLines: added.length, lines: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)] }],
});

export const F = "/home/user/project/src/add.js";

/** Edit that succeeded (+1/-1). */
export function edit(id: string, file = F): string[] {
  return [
    toolUse(id, "Edit", { file_path: file, old_string: "a", new_string: "b" }),
    toolResult(id, "File updated.", { toolUseResult: patchResult(["b"], ["a"]) }),
  ];
}

export function bash(id: string, command: string, outcome: { exit?: number; output?: string; none?: boolean } = {}): string[] {
  const out = [toolUse(id, "Bash", { command })];
  if (outcome.none) return out;
  if (outcome.exit && outcome.exit !== 0) {
    out.push(toolResult(id, `Exit code ${outcome.exit}\n${outcome.output ?? ""}`, { isError: true }));
  } else {
    out.push(toolResult(id, outcome.output ?? "ok", { toolUseResult: { stdout: "ok", stderr: "", interrupted: false } }));
  }
  return out;
}

/** Background Bash call: the tool_use plus its launch result (`backgroundTaskId`). */
export function bgBash(id: string, taskId: string, command: string): string[] {
  return [
    toolUse(id, "Bash", { command, run_in_background: true }),
    toolResult(id, `Command running in background with ID: ${taskId}`, { toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId } }),
  ];
}

export interface NotificationFields {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
}

/** Text of one `<task-notification>` block (tags in the order Claude Code writes them). */
export function notificationBlock(f: NotificationFields): string {
  const parts = ["<task-notification>"];
  if (f.taskId !== undefined) parts.push(`<task-id>${f.taskId}</task-id>`);
  if (f.toolUseId !== undefined) parts.push(`<tool-use-id>${f.toolUseId}</tool-use-id>`);
  parts.push("<output-file>/tmp/tasks/x.output</output-file>");
  if (f.status !== undefined) parts.push(`<status>${f.status}</status>`);
  if (f.summary !== undefined) parts.push(`<summary>${f.summary}</summary>`);
  parts.push("</task-notification>");
  return parts.join("\n");
}

/** User record carrying one or more task notifications (string content, non-human origin like the real thing). */
export function taskNotification(f: NotificationFields | NotificationFields[], extra: Record<string, unknown> = {}): string {
  const text = (Array.isArray(f) ? f : [f]).map(notificationBlock).join("\n");
  return rec("user", { message: { role: "user", content: text }, origin: { kind: "task-notification" }, ...extra });
}

export { rec };
