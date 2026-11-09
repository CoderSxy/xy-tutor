import { expect, it } from "vitest";
import { sessionStarter } from "../../apps/web/src/lib/sessionStart";
it("reuses the created conversation and request key after a lost reply", async () => {
  let creates = 0;
  const keys: string[] = [];
  const start = sessionStarter(
    async () => ({ id: String(++creates), conversationId: "c" }),
    async (_id, _text, key) => {
      keys.push(key);
      if (keys.length === 1) throw Error("response lost");
    },
  );
  await expect(start("student:revision", "hello")).rejects.toThrow(
    "response lost",
  );
  expect(await start("student:revision", "hello")).toBe("1");
  expect(creates).toBe(1);
  expect(keys[1]).toBe(keys[0]);
});
