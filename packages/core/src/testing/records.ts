// Test-only builders for synthetic session records.
let counter = 0;

export function resetIds(): void {
  counter = 0;
}

function rec(type: string, extra: Record<string, unknown>): string {
  counter++;
  return JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    sessionId: "00000000-0000-4000-8000-000000000001",
    timestamp: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    cwd: "/home/user/project",
    gitBranch: "main",
    ...extra,
  });
}

export const prompt = (text: unknown, extra: Record<string, unknown> = {}): string =>
  rec("user", { message: { role: "user", content: text }, ...extra });

export const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  rec("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });

export const toolResult = (
  id: string,
  content: unknown,
  opts: { isError?: boolean; toolUseResult?: unknown } = {},
): string =>
  rec("user", {
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, ...(opts.isError ? { is_error: true } : {}) }],
    },
    ...(opts.toolUseResult !== undefined ? { toolUseResult: opts.toolUseResult } : {}),
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

export { rec };
