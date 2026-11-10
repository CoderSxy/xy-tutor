import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_DATABASE_URL,
  resolveTestDatabaseUrl,
} from "../helpers/database.js";

describe("resolveTestDatabaseUrl", () => {
  it("falls back to the local test database", () => {
    expect(resolveTestDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("accepts an explicit _test database", () => {
    const url = "postgres://tester@localhost:5432/xy_tutor_bench_test";
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });

  it("refuses to run in production", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        NODE_ENV: "production",
        TEST_DATABASE_URL: "postgres://tester@localhost:5432/xy_tutor_test",
      }),
    ).toThrow("Refusing unsafe test database");
  });

  it("refuses the configured application database", () => {
    const url = "postgres://tester@localhost:5432/xy_tutor_test";
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: url, DATABASE_URL: url }),
    ).toThrow("Refusing unsafe test database");
  });

  it("refuses a database whose name does not end with _test", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: "postgres://tester@localhost:5432/xy_tutor",
      }),
    ).toThrow("Refusing unsafe test database");
  });

  it("refuses a malformed URL", () => {
    expect(() =>
      resolveTestDatabaseUrl({ TEST_DATABASE_URL: "not-a-url_test" }),
    ).toThrow("Refusing unsafe test database");
  });
});
