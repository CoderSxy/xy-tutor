import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
});
export type AppConfig = {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  origin: string;
  databaseUrl?: string;
  sessionSecret?: string;
};
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error("Invalid configuration");
  const c = result.data;
  if (
    c.NODE_ENV === "production" &&
    (!c.DATABASE_URL ||
      !c.SESSION_SECRET ||
      c.SESSION_SECRET.length < 32 ||
      !c.APP_ORIGIN.startsWith("https://"))
  )
    throw new Error("Invalid configuration");
  return {
    env: c.NODE_ENV,
    host: c.HOST,
    port: c.PORT,
    origin: c.APP_ORIGIN,
    databaseUrl: c.DATABASE_URL,
    sessionSecret: c.SESSION_SECRET,
  };
}
