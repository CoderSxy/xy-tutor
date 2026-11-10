import { createCanvas } from "@napi-rs/canvas";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createGateway } from "../apps/server/src/agent/provider.js";
import { configuredCapabilities } from "../apps/server/src/agent/capabilities.js";

const gateway = createGateway(process.env);
if (!gateway) {
  console.error(
    "UNVERIFIED: set LLM_MODEL, LLM_API_KEY and LLM_SUPPORTS_IMAGES=true in an untracked environment file",
  );
  process.exitCode = 1;
} else {
  const capabilities = configuredCapabilities(gateway);
  if (capabilities.images === "disabled") {
    console.error(
      "UNVERIFIED: the configured model does not advertise image input; set LLM_SUPPORTS_IMAGES=true for a vision model",
    );
    process.exitCode = 1;
  } else if (!process.argv.includes("--live")) {
    console.log(
      `Image input is configured (${capabilities.images}) but not verified. Re-run with --live to probe the real gateway.`,
    );
  } else {
    await probe();
  }
}

async function probe() {
  const [first, second] = codes();
  const images: ImageContent[] = [
    { type: "image", data: render(first).toString("base64"), mimeType: "image/png" },
    { type: "image", data: render(second).toString("base64"), mimeType: "image/png" },
  ];
  const question =
    "两张图片里各有一个四位数字。按图片顺序只回复两个数字，用逗号分隔。";
  try {
    const direct = await gateway!.complete(
      {
        context: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: question }, ...images],
              timestamp: Date.now(),
            },
          ],
        },
      },
      AbortSignal.timeout(120000),
    );
    assertOrder(direct.text, first, second);
    const calls: string[] = [];
    const agent = new Agent({
      initialState: {
        systemPrompt:
          "你必须先调用 echo_code 工具记录一个备注，然后按顺序说出两张图片中的数字。",
        model: gateway!.runtime.model,
        tools: [
          {
            name: "echo_code",
            label: "记录备注",
            description: "记录一个备注",
            parameters: z.toJSONSchema(z.object({ note: z.string() }).strict()),
            replay: "never",
            async execute(_callId, params) {
              calls.push(String((params as { note: string }).note));
              return {
                content: [{ type: "text", text: "已记录" }],
                details: {},
              };
            },
          },
        ],
      },
      streamFn: gateway!.streamFn,
      toolExecution: "sequential",
    });
    const answers: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        answers.push(
          event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
      if (event.type === "message_end" && event.message.role === "toolResult")
        calls.push("tool-round");
    });
    await agent.prompt(question, images);
    if (!calls.includes("tool-round")) throw Error("NO_TOOL_ROUND");
    assertOrder(answers.join("\n"), first, second);
    console.log(
      "Image input verified on two images, in order, before and after a tool round; codes and image bytes are not logged.",
    );
  } catch (error) {
    console.error(
      `UNVERIFIED: chat image probe failed (${error instanceof Error ? error.message : "unknown error"}). Check the vision model, gateway and image limits.`,
    );
    process.exitCode = 1;
  }
}

function codes(): [string, string] {
  const first = String(Math.floor(Math.random() * 9000) + 1000);
  let second = String(Math.floor(Math.random() * 9000) + 1000);
  while (second === first) second = String(Math.floor(Math.random() * 9000) + 1000);
  return [first, second];
}

function render(code: string): Buffer {
  const canvas = createCanvas(600, 220);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 600, 220);
  ctx.fillStyle = "#000000";
  ctx.font = "bold 120px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code, 300, 110);
  return canvas.toBuffer("image/png");
}

function assertOrder(text: string, first: string, second: string) {
  const compact = text.replace(/\s+/g, "");
  const a = compact.indexOf(first);
  const b = compact.indexOf(second);
  if (a < 0 || b < 0 || a > b) throw Error("CODES_NOT_READ_IN_ORDER");
}
