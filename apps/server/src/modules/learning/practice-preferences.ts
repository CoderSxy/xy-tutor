import type { Database } from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  preferencesPatchSchema,
  type PreferencesDTO,
} from "../../../../../packages/contracts/src/practice-sets.js";
import type { AuthService } from "../auth/service.js";
import { getExamProfile } from "../question-bank/exam-profiles.js";

const DEFAULTS: PreferencesDTO = {
  version: 1,
  mode: null,
  strategy: "mixed",
  examProfileId: null,
};

export class PracticePreferencesService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}

  async get(scope: StudentScope): Promise<PreferencesDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query<{
        version: number;
        mode: PreferencesDTO["mode"];
        strategy: PreferencesDTO["strategy"];
        exam_profile_id: string | null;
      }>(
        `SELECT version, mode, strategy, exam_profile_id
         FROM student_practice_preferences WHERE student_id=$1`,
        [scope.studentId],
      )
    ).rows[0];
    if (!row) return DEFAULTS;
    return {
      version: row.version,
      mode: row.mode,
      strategy: row.strategy,
      examProfileId: row.exam_profile_id,
    };
  }

  async patch(scope: StudentScope, input: unknown): Promise<PreferencesDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const parsed = preferencesPatchSchema.parse(input);
    if (parsed.strategy === "exam" || parsed.examProfileId) {
      const profileId = parsed.examProfileId;
      if (
        parsed.strategy === "exam" &&
        (!profileId ||
          !getExamProfile(profileId, undefined, {
            includeFixtures: process.env.NODE_ENV === "test",
          }))
      )
        throw new AppError(
          "VALIDATION",
          422,
          "考试配置无效或已失效，请选择替代配置",
        );
    }
    const current = await this.get(scope);
    if (
      parsed.expectedVersion &&
      current.version !== parsed.expectedVersion &&
      (await this.exists(scope.studentId))
    )
      throw new AppError("CONFLICT", 409, "偏好已更新，请刷新后重试");
    const next = {
      mode: parsed.mode === undefined ? current.mode : parsed.mode,
      strategy: parsed.strategy ?? current.strategy,
      examProfileId:
        parsed.examProfileId === undefined
          ? current.examProfileId
          : parsed.examProfileId,
    };
    const row = (
      await this.db.pool.query<{
        version: number;
        mode: PreferencesDTO["mode"];
        strategy: PreferencesDTO["strategy"];
        exam_profile_id: string | null;
      }>(
        `INSERT INTO student_practice_preferences(student_id,mode,strategy,exam_profile_id,version)
         VALUES($1,$2,$3,$4,1)
         ON CONFLICT (student_id) DO UPDATE SET
           mode=EXCLUDED.mode,
           strategy=EXCLUDED.strategy,
           exam_profile_id=EXCLUDED.exam_profile_id,
           version=student_practice_preferences.version+1,
           updated_at=now()
         RETURNING version, mode, strategy, exam_profile_id`,
        [scope.studentId, next.mode, next.strategy, next.examProfileId],
      )
    ).rows[0]!;
    return {
      version: row.version,
      mode: row.mode,
      strategy: row.strategy,
      examProfileId: row.exam_profile_id,
    };
  }

  private async exists(studentId: string) {
    return !!(
      await this.db.pool.query(
        "SELECT 1 FROM student_practice_preferences WHERE student_id=$1",
        [studentId],
      )
    ).rowCount;
  }
}
