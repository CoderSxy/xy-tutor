import { expect, it } from "vitest";
import { sessionStarter } from "../../apps/web/src/lib/sessionStart";
const scope = "student:revision";
it("reuses the created conversation and request key after a lost reply", async () => {
  let creates = 0;
  const keys: string[] = [];
  const submissions: unknown[] = [];
  const start = sessionStarter(
    async () => ({ id: String(++creates), conversationId: "c" }),
    async (_id, submission, key) => {
      submissions.push(submission);
      keys.push(key);
      if (keys.length === 1) throw Error("response lost");
    },
  );
  const submission = { message: "hello", attachmentIds: [] as string[] };
  await expect(start.send(scope, submission)).rejects.toThrow("response lost");
  expect(await start.send(scope, submission)).toBe("1");
  expect(creates).toBe(1);
  expect(keys[1]).toBe(keys[0]);
  expect(submissions).toEqual([submission, submission]);
});
it("creates only one draft task when its creation reply is lost", async () => {
  const tasks = new Map<string, { id: string; conversationId: string }>();
  const creationKeys: string[] = [];
  let attempts = 0;
  const start = sessionStarter(
    async (_scope, creationKey) => {
      creationKeys.push(creationKey);
      if (!tasks.has(creationKey))
        tasks.set(creationKey, {
          id: String(tasks.size + 1),
          conversationId: `c${tasks.size + 1}`,
        });
      if (++attempts === 1) throw Error("response lost");
      return tasks.get(creationKey)!;
    },
    async () => {},
  );
  await expect(start.ensureConversation(scope)).rejects.toThrow(
    "response lost",
  );
  expect(await start.ensureConversation(scope)).toBe("c1");
  expect(tasks.size).toBe(1);
  expect(creationKeys).toEqual([creationKeys[0], creationKeys[0]]);
});
it("keeps ordered image ids in the request fingerprint", async () => {
  const keys: string[] = [];
  const submissions: unknown[] = [];
  const start = sessionStarter(
    async () => ({ id: "1", conversationId: "c" }),
    async (_id, submission, key) => {
      submissions.push(submission);
      keys.push(key);
      if (keys.length === 1) throw Error("response lost");
    },
  );
  const submission = {
    message: "",
    attachmentIds: ["second-file", "first-file"],
  };
  await expect(start.send(scope, submission)).rejects.toThrow("response lost");
  await start.send(scope, submission);
  expect(submissions).toEqual([submission, submission]);
  expect(keys[1]).toBe(keys[0]);
  await start.send(scope, {
    message: "",
    attachmentIds: ["first-file", "second-file"],
  });
  expect(keys[2]).not.toBe(keys[0]);
});
it("does not reuse a draft task across textbooks", async () => {
  const scopes: string[] = [];
  const start = sessionStarter(
    async (value) => {
      scopes.push(value);
      return { id: String(scopes.length), conversationId: `c${scopes.length}` };
    },
    async () => {},
  );
  expect(await start.ensureConversation("student:a")).toBe("c1");
  expect(await start.ensureConversation("student:b")).toBe("c2");
  expect(scopes).toEqual(["student:a", "student:b"]);
});
