import {
  createModels,
  createProvider,
  type Models,
  type Model,
  type Api,
  type Context,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ModelRequest,
  ModelEvent,
  ModelResult,
} from "../../../../packages/contracts/src/agent.js";
import { AppError } from "../../../../packages/contracts/src/api.js";
import { ModelBudget } from "./model-budget.js";
export type ModelRuntime = { models: Models; model: Model<Api> };
export function createGateway(
  env: Record<string, string | undefined>,
  budget = new ModelBudget(),
): ModelGateway | undefined {
  if (!env.LLM_MODEL || !env.LLM_API_KEY) return undefined;
  const baseUrl = env.LLM_BASE_URL ?? "https://api.nerosun.cn/v1";
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  )
    throw Error("LLM endpoint must use HTTPS");
  const model: Model<"openai-completions"> = {
    id: env.LLM_MODEL,
    name: env.LLM_MODEL,
    provider: "nerosun",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
    input: env.LLM_SUPPORTS_IMAGES === "true" ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(env.LLM_CONTEXT_WINDOW ?? 16000),
    maxTokens: Number(env.LLM_MAX_OUTPUT ?? 2048),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  };
  const models = createModels({ identity: { attribution: null } });
  const key = env.LLM_API_KEY;
  models.setProvider(
    createProvider({
      id: "nerosun",
      baseUrl,
      auth: {
        apiKey: {
          name: "Nerosun gateway",
          resolve: async () => ({ auth: { apiKey: key } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return new ModelGateway({ models, model }, budget);
}
export class ModelGateway {
  constructor(
    readonly runtime: ModelRuntime,
    readonly budget: ModelBudget,
  ) {}
  readonly streamFn: StreamFn = async (model, context, options) =>
    this.open(context, options?.signal, "interactive", model);
  async open(
    context: Context,
    signal?: AbortSignal,
    priority: "interactive" | "background" = "interactive",
    model = this.runtime.model,
  ) {
    const combined = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(120000),
    ]);
    combined.throwIfAborted();
    const release = await this.budget.acquire(priority, combined);
    try {
      const source = this.runtime.models.streamSimple(model, context, {
        signal: combined,
        maxTokens: model.maxTokens,
        identity: { attribution: null },
      });
      void source.result().then(release, release);
      return source;
    } catch (error) {
      release();
      throw error;
    }
  }
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    const source = await this.open(request.context, signal, request.priority);
    for await (const event of source) {
      if (event.type === "text_delta")
        yield { type: "text", text: event.delta };
      else if (event.type === "toolcall_end")
        yield {
          type: "tool_call",
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
        };
      else if (event.type === "done") {
        yield { type: "usage", usage: event.message.usage };
        yield { type: "finish" };
      } else if (event.type === "error") {
        if (event.reason === "aborted")
          throw new DOMException("Aborted", "AbortError");
        throw new AppError("UPSTREAM_UNAVAILABLE", 503, "模型服务暂时不可用");
      }
    }
  }
  async complete(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const result: ModelResult = { text: "", toolCalls: [] };
    for await (const event of this.stream(request, signal)) {
      if (event.type === "text") result.text += event.text;
      else if (event.type === "tool_call")
        result.toolCalls.push({
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
      else if (event.type === "usage") result.usage = event.usage;
    }
    return result;
  }
}
