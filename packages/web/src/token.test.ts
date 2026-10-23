import { describe, expect, test } from "vitest";
import { resolveToken, tokenFromHash, type KeyValueStore } from "./token";

const TOKEN = "a".repeat(64);
function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const throwing: KeyValueStore = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
};

describe("token transport", () => {
  test("tokenFromHash accepts only #k=<token>", () => {
    expect(tokenFromHash(`#k=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#k=short")).toBeNull();
    expect(tokenFromHash(`#k=${TOKEN}&x=1`)).toBeNull();
    expect(tokenFromHash(`#/session/${TOKEN}`)).toBeNull();
  });
  test("fragment token is stored and flagged for stripping", () => {
    const s = memStore();
    expect(resolveToken(`#k=${TOKEN}`, s)).toEqual({ token: TOKEN, stripHash: true });
    expect(s.data.size).toBe(1);
  });
  test("reload falls back to the stored token", () => {
    const s = memStore();
    resolveToken(`#k=${TOKEN}`, s);
    expect(resolveToken("", s)).toEqual({ token: TOKEN, stripHash: false });
    expect(resolveToken("#/session/x", s).token).toBe(TOKEN);
  });
  test("new fragment overrides the stored token", () => {
    const s = memStore();
    resolveToken(`#k=${TOKEN}`, s);
    const other = "b".repeat(64);
    expect(resolveToken(`#k=${other}`, s).token).toBe(other);
    expect(resolveToken("", s).token).toBe(other);
  });
  test("no token anywhere", () => {
    expect(resolveToken("", memStore())).toEqual({ token: null, stripHash: false });
    expect(resolveToken("", null)).toEqual({ token: null, stripHash: false });
  });
  test("blocked storage: token still works from the fragment, in memory", () => {
    expect(resolveToken(`#k=${TOKEN}`, throwing)).toEqual({ token: TOKEN, stripHash: true });
    expect(resolveToken("", throwing)).toEqual({ token: null, stripHash: false });
  });
});
