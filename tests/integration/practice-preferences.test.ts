import { expect, it } from "vitest";
import { withTestDb } from "../helpers/database.js";
import { catalogFixture } from "../helpers/catalog.js";
import { PracticePreferencesService } from "../../apps/server/src/modules/learning/practice-preferences.js";
import { TEST_EXAM_PROFILE } from "../../apps/server/src/modules/question-bank/exam-profiles.js";

it("stores explicit preferences and keeps mode null until chosen", async () =>
  withTestDb(async (db) => {
    const f = await catalogFixture(db);
    const prefs = new PracticePreferencesService(db, f.auth);
    const initial = await prefs.get(f.scope);
    expect(initial).toEqual({
      version: 1,
      mode: null,
      strategy: "mixed",
      examProfileId: null,
    });
    const patched = await prefs.patch(f.scope, {
      expectedVersion: 1,
      mode: "batch",
      strategy: "exam",
      examProfileId: TEST_EXAM_PROFILE.profileId,
    });
    expect(patched.mode).toBe("batch");
    expect(patched.strategy).toBe("exam");
    expect(patched.examProfileId).toBe(TEST_EXAM_PROFILE.profileId);
    const bumped = await prefs.patch(f.scope, {
      expectedVersion: patched.version,
      mode: "step",
    });
    await expect(
      prefs.patch(f.scope, {
        expectedVersion: patched.version,
        mode: "batch",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(bumped.mode).toBe("step");
    await expect(
      prefs.patch(f.scope, {
        expectedVersion: patched.version,
        strategy: "exam",
        examProfileId: "missing-profile",
      }),
    ).rejects.toMatchObject({ status: 422 });
  }));
