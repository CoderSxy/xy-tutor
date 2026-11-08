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
  options: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/api/"))
    throw Error("Only same-origin API paths are allowed");
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
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
}
export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试";
}
