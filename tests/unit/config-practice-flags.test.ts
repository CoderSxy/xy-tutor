import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/server/src/config.js";

describe("practice feature flags", () => {
  it("defaults practice set and mobile study flags to false", () => {
    const features = loadConfig({ NODE_ENV: "test" }).features;
    expect(features.practiceSetsEnabled).toBe(false);
    expect(features.mobileStudyEnabled).toBe(false);
  });
});
