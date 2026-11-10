import { createGateway } from "../apps/server/src/agent/provider.js";
const g = createGateway(process.env);
if (!g) {
  console.error(
    "UNVERIFIED: set LLM_MODEL and LLM_API_KEY in an untracked environment file",
  );
  process.exitCode = 1;
} else {
  const result = await g.complete(
    {
      context: {
        messages: [
          { role: "user", content: "只回复：连接成功", timestamp: Date.now() },
        ],
      },
    },
    AbortSignal.timeout(30000),
  );
  if (!result.text) throw Error("No public response");
  console.log(
    "Text streaming verified; tool/image/cancellation probes still require capability validation.",
  );
}
