#!/usr/bin/env node
/**
 * Builds the static demo page: a synthetic "shop" repository plus one synthetic Claude Code
 * session, exported with the real CLI (`--export`). Nothing here reads or contains real logs,
 * home directories or personal data: the temporary repository path is redacted to `<repo>` by
 * the export itself.
 *
 * Usage: pnpm build && pnpm demo
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = join(root, "docs", "demo", "index.html");
const cli = join(root, "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("demo: packages/cli/dist/cli.js is missing; run `pnpm build` first");
  process.exit(1);
}

const SESSION_ID = "demo0000-0000-4000-8000-000000000001";
const SESSION_START = Date.parse("2026-03-02T09:00:00.000Z");

const INITIAL = {
  "src/price.ts": `export const TAX_RATE = 0.2;

export interface LineItem {
  price: number;
  qty: number;
}

export function subtotal(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function applyDiscount(amount: number, percent: number): number {
  return amount;
}

export function withTax(amount: number): number {
  return amount * (1 + TAX_RATE);
}
`,
  "src/cart.ts": `import { applyDiscount, subtotal, withTax, type LineItem } from "./price";

export function cartTotal(items: readonly LineItem[], discountPercent: number): number {
  return withTax(subtotal(items));
}
`,
  "src/cart.test.ts": `import { describe, expect, it } from "vitest";
import { cartTotal } from "./cart";

const items = [
  { price: 12, qty: 1 },
  { price: 8, qty: 1 },
];

describe("cart total", () => {
  it("applies the discount before tax", () => {
    expect(cartTotal(items, 10)).toBe(21.6);
  });

  it("handles no discount", () => {
    expect(cartTotal(items, 0)).toBe(24);
  });

  it("keeps cents", () => {
    expect(cartTotal(items, 25)).toBe(18);
  });
});
`,
  "backend/manage.py": `#!/usr/bin/env python
"""Minimal demo project entry point."""

import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`,
  "backend/orders/__init__.py": `"""Order domain models and views."""
`,
  "backend/orders/models.py": `from django.db import models


class Order(models.Model):
    reference = models.CharField(max_length=32, unique=True)
    total = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)
`,
  "backend/orders/views.py": `from django.shortcuts import render


def order_list(request):
    orders = Order.objects.order_by("-created_at")
    return render(request, "orders/list.html", {"orders": orders})
`,
  "package.json": `{
  "name": "shop",
  "private": true,
  "scripts": {
    "test": "vitest run"
  }
}
`,
};

const FINAL = {
  ...INITIAL,
  "src/price.ts": INITIAL["src/price.ts"].replace(
    "export function applyDiscount(amount: number, percent: number): number {\n  return amount;\n}",
    "export function applyDiscount(amount: number, percent: number): number {\n  return amount - (amount * percent) / 100;\n}",
  ),
  "src/cart.ts": `import { applyDiscount, subtotal, withTax, type LineItem } from "./price";

export function cartTotal(items: readonly LineItem[], discountPercent: number): number {
  const discounted = applyDiscount(subtotal(items), discountPercent);
  return Math.round(withTax(discounted) * 100) / 100;
}
`,
  "src/cart.test.ts": INITIAL["src/cart.test.ts"].replace(
    "expect(cartTotal(items, 10)).toBe(21.6);",
    "expect(cartTotal(items, 10)).toBeCloseTo(21.6, 2);",
  ),
  "backend/orders/views.py": `from django.shortcuts import render

from .models import Order


def order_list(request):
    orders = Order.objects.order_by("-created_at")
    return render(request, "orders/list.html", {"orders": orders})
`,
};

function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function buildSession(repo) {
  const records = [];
  let parentUuid = null;
  let tick = 0;
  let toolSeq = 0;

  const push = (type, message, extra = {}) => {
    const uuid = `e0000000-0000-4000-8000-${String(++tick).padStart(12, "0")}`;
    records.push({
      ...extra,
      type,
      uuid,
      parentUuid,
      sessionId: SESSION_ID,
      timestamp: new Date(SESSION_START + tick * 1000).toISOString(),
      cwd: repo,
      gitBranch: "main",
      version: "2.1.0",
      message,
    });
    parentUuid = uuid;
  };

  const userPrompt = (text) => push("user", { role: "user", content: text });
  const assistantText = (text) => push("assistant", { role: "assistant", content: [{ type: "text", text }] });
  const tool = (name, input, text = "") => {
    const id = `toolu_demo_${String(++toolSeq).padStart(2, "0")}`;
    const content = text === "" ? [] : [{ type: "text", text }];
    content.push({ type: "tool_use", id, name, input });
    push("assistant", { role: "assistant", content });
    return id;
  };
  const result = (id, content, extra) =>
    push(
      "user",
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
      extra === undefined ? {} : { toolUseResult: extra },
    );
  const read = (file) => {
    const id = tool("Read", { file_path: join(repo, file) });
    result(id, INITIAL[file]);
  };
  const edit = (file, oldString, newString, lines) => {
    const id = tool("Edit", { file_path: join(repo, file), old_string: oldString, new_string: newString });
    result(id, "File updated.", {
      type: "update",
      filePath: join(repo, file),
      oldString,
      newString,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: oldString.split("\n").length,
          newStart: 1,
          newLines: newString.split("\n").length,
          lines,
        },
      ],
    });
  };
  const bash = (command, content, ok) => {
    const id = tool("Bash", { command });
    if (ok) {
      result(id, content, { stdout: content, stderr: "", interrupted: false });
    } else {
      push(
        "user",
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Exit code 1\n${content}`, is_error: true }] },
        { toolUseResult: { stdout: content, stderr: "", interrupted: false } },
      );
    }
    return ok;
  };

  // Prompt 1: checked — discount before tax, then a passing test run.
  userPrompt("Apply the cart discount before tax so the totals match our pricing rules.");
  assistantText("I’ll check how the cart total is composed.");
  read("src/cart.ts");
  assistantText("The discount is ignored. I’ll implement it in the pricing helper, then use it in the cart.");
  edit(
    "src/price.ts",
    "export function applyDiscount(amount: number, percent: number): number {\n  return amount;\n}",
    "export function applyDiscount(amount: number, percent: number): number {\n  return amount - (amount * percent) / 100;\n}",
    ["-  return amount;", "+  return amount - (amount * percent) / 100;"],
  );
  edit(
    "src/cart.ts",
    "export function cartTotal(items: readonly LineItem[], discountPercent: number): number {\n  return withTax(subtotal(items));\n}",
    "export function cartTotal(items: readonly LineItem[], discountPercent: number): number {\n  const discounted = applyDiscount(subtotal(items), discountPercent);\n  return withTax(discounted);\n}",
    [
      "-  return withTax(subtotal(items));",
      "+  const discounted = applyDiscount(subtotal(items), discountPercent);",
      "+  return withTax(discounted);",
    ],
  );
  assistantText("Running the cart tests.");
  bash("pnpm exec vitest run", "Test Files  1 passed (1)\n     Tests  3 passed (3)", true);
  assistantText("The discount is applied before tax and all cart tests pass.");

  // Prompt 2: failing -> fix -> checked; the test edit after the failure triggers a review hint.
  userPrompt("The cart total can come out as 21.600000000000005. Round it to cents and make the test tolerant.");
  assistantText("I’ll look at the current total first.");
  read("src/cart.ts");
  assistantText("Rounding is not implemented. I’ll round the result.");
  edit(
    "src/cart.ts",
    "  const discounted = applyDiscount(subtotal(items), discountPercent);\n  return withTax(discounted);",
    "  const discounted = applyDiscount(subtotal(items), discountPercent);\n  return Math.round(withTax(discounted));",
    [
      "-  return withTax(discounted);",
      "+  return Math.round(withTax(discounted));",
    ],
  );
  assistantText("Running the tests to confirm the change.");
  bash(
    "pnpm exec vitest run",
    "Test Files  1 failed (1)\n     Tests  1 failed | 2 passed (3)\n\n FAIL  src/cart.test.ts > cart total > applies the discount before tax\n AssertionError: expected 22 to be 21.6",
    false,
  );
  assistantText("The total is rounded to whole numbers, so cents are lost. I’ll keep two decimals and relax the assertion for float noise.");
  edit(
    "src/cart.test.ts",
    "expect(cartTotal(items, 10)).toBe(21.6);",
    "expect(cartTotal(items, 10)).toBeCloseTo(21.6, 2);",
    ["-    expect(cartTotal(items, 10)).toBe(21.6);", "+    expect(cartTotal(items, 10)).toBeCloseTo(21.6, 2);"],
  );
  edit(
    "src/cart.ts",
    "  return Math.round(withTax(discounted));",
    "  return Math.round(withTax(discounted) * 100) / 100;",
    ["-  return Math.round(withTax(discounted));", "+  return Math.round(withTax(discounted) * 100) / 100;"],
  );
  assistantText("Re-running the cart tests.");
  bash("pnpm exec vitest run", "Test Files  1 passed (1)\n     Tests  3 passed (3)", true);
  assistantText("Rounding keeps cents and the assertions now tolerate floating point. All tests pass.");

  // Prompt 3: unchecked — a Python edit with no check afterwards.
  userPrompt("Add an order list view that uses the Order model.");
  assistantText("The views module queries Order but never imports it.");
  edit(
    "backend/orders/views.py",
    "from django.shortcuts import render\n\n\ndef order_list(request):",
    "from django.shortcuts import render\n\nfrom .models import Order\n\n\ndef order_list(request):",
    ["+from .models import Order", "+"],
  );
  assistantText("The order list view now imports the model. I’ll wire the URL and run the Django checks next.");

  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function privacyCheck(html) {
  const banned = ["/home/jack", "/tmp/", "claude-1000", homedir()].filter((x) => x.length > 1);
  for (const needle of banned) {
    if (html.includes(needle)) throw new Error(`demo: generated HTML contains private path ${JSON.stringify(needle)}`);
  }
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(html)) throw new Error("demo: generated HTML contains an e-mail address");
}

const keep = process.env.KEEP_DEMO_TMP === "1";
const tmp = mkdtempSync(join(tmpdir(), "lgtm-demo-"));
const repo = join(tmp, "shop");
const projects = join(tmp, "projects");

try {
  writeTree(repo, FINAL);

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-q", "-m", "shop demo"], { cwd: repo });

  // Same mapping as projectDirFor(): Claude Code names the project dir after the cwd.
  const projectDir = join(projects, repo.replace(/[/.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), buildSession(repo));

  mkdirSync(dirname(outFile), { recursive: true });
  console.log(`demo: exporting ${SESSION_ID} to ${outFile}`);
  execFileSync(
    process.execPath,
    [cli, "--dir", repo, "--projects-dir", projects, "--export", "demo", "--out", outFile, "--force"],
    { cwd: root, stdio: "inherit" },
  );

  privacyCheck(readFileSync(outFile, "utf8"));
  console.log("demo: privacy check passed (no temp/home paths, no e-mail addresses)");
} finally {
  if (keep) console.log(`demo: kept temporary files in ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
