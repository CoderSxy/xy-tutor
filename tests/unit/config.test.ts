import { describe, it, expect } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";
describe("configuration", () => {
  it("rejects incomplete production configuration", () =>
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "Invalid configuration",
    ));
  it("rejects invalid ports without exposing credentials", () =>
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        PORT: "bad",
        DATABASE_URL: "secret-value",
      }),
    ).toThrow("Invalid configuration"));
  it("defaults to a loopback development listener", () =>
    expect(loadConfig({ NODE_ENV: "test" }).host).toBe("127.0.0.1"));
  it("disables adaptive features by default", () => {
    expect(loadConfig({ NODE_ENV: "test" }).features).toEqual({
      selfCheckEnabled: false,
      timingEnabled: false,
      adaptivePracticeEnabled: false,
      learningEvaluationEnabled: false,
    });
  });
  it("parses explicit boolean flags", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TUTOR_SELF_CHECK_ENABLED: "true",
      LEARNING_TIMING_ENABLED: "true",
      ADAPTIVE_PRACTICE_ENABLED: "true",
      LEARNING_EVALUATION_ENABLED: "true",
    });
    expect(config.features).toEqual({
      selfCheckEnabled: true,
      timingEnabled: true,
      adaptivePracticeEnabled: true,
      learningEvaluationEnabled: true,
    });
  });
  it("rejects adaptive practice without self check", () =>
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        ADAPTIVE_PRACTICE_ENABLED: "true",
        TUTOR_SELF_CHECK_ENABLED: "false",
      }),
    ).toThrow("Invalid configuration"));
  it("allows adaptive practice with timing disabled", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      TUTOR_SELF_CHECK_ENABLED: "true",
      ADAPTIVE_PRACTICE_ENABLED: "true",
      LEARNING_TIMING_ENABLED: "false",
    });
    expect(config.features.timingEnabled).toBe(false);
    expect(config.features.adaptivePracticeEnabled).toBe(true);
  });
  it("rejects non-boolean flag values", () =>
    expect(() =>
      loadConfig({ NODE_ENV: "test", TUTOR_SELF_CHECK_ENABLED: "yes" }),
    ).toThrow("Invalid configuration"));
});
