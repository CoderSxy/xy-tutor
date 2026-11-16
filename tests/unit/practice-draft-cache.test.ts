import { describe, expect, it } from "vitest";
import {
  clearStudentDrafts,
  containsSignedUrl,
  readLocalDrafts,
  writeLocalDraft,
} from "../../apps/web/src/features/practice/draft-cache.js";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe("practice draft cache", () => {
  it("scopes drafts by student and set and drops them on logout", () => {
    const store = new MemoryStorage();
    writeLocalDraft(
      store,
      "student-a",
      "set-1",
      "item-1",
      { kind: "choice", optionIds: ["opt-a"] },
    );
    writeLocalDraft(
      store,
      "student-b",
      "set-1",
      "item-1",
      { kind: "worked", text: "过程", attachmentIds: [] },
    );
    expect(readLocalDrafts(store, "student-a", "set-1")["item-1"]?.answer).toEqual({
      kind: "choice",
      optionIds: ["opt-a"],
    });
    clearStudentDrafts(store, "student-a");
    expect(readLocalDrafts(store, "student-a", "set-1")).toEqual({});
    expect(readLocalDrafts(store, "student-b", "set-1")["item-1"]?.answer).toMatchObject({
      kind: "worked",
    });
  });

  it("does not store signed attachment URLs", () => {
    expect(
      containsSignedUrl({
        kind: "worked",
        text: "计算 3",
        attachmentIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toBe(false);
    expect(
      containsSignedUrl({ url: "https://oss.example/x?X-Amz-Signature=abc" }),
    ).toBe(true);
  });
});
