import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

// React 19: mark the environment so act() flushes renders and effects.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

/** Renders `node` into a fresh container attached to document.body; unmounted after each test. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}

/** A bubbling, cancelable keydown on `target` (default: the focused element); returns it so tests can read `defaultPrevented`. */
export async function press(key: string, init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  return ev;
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.container.remove();
  }
  window.location.hash = "";
});
