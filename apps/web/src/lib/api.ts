// 服务端卡死时 fetch 不会自己结束；没有上限，任何等待它的界面都会永远转圈。
export const API_TIMEOUT_MS = 30_000;
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  if (!path.startsWith("/api/"))
    throw Error("Only same-origin API paths are allowed");
  const { timeoutMs = API_TIMEOUT_MS, signal: external, ...init } = options;
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", forward, { once: true });
  }
  try {
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError("服务响应异常，请稍后重试", response.status);
    }
    if (!response.ok) {
      const error = body as { error?: { message?: string; code?: string } };
      throw new ApiError(
        error.error?.message ?? "操作未完成，请重试",
        response.status,
        error.error?.code,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError("请求超时，请稍后重试", 0, "TIMEOUT");
    // 调用方主动取消：原样抛出让上层识别为 abort，不要报成网络错误。
    if (external?.aborted) throw error;
    throw new ApiError("网络连接失败，请检查网络后重试", 0, "NETWORK");
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", forward);
  }
}
export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
