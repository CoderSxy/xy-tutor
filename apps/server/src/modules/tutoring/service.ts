import { createHash } from "node:crypto";
import type pg from "pg";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  tutoringActionInputSchema,
  type DiagnosisDTO,
  type EpisodeDTO,
  type Exposure,
  type TeachingState,
  type TutoringActionDTO,
  type TutoringActionInput,
} from "../../../../../packages/contracts/src/tutoring.js";
import { EMPTY_TIMING_SUMMARY } from "../../../../../packages/contracts/src/learning-timing.js";
import type { AuthService } from "../auth/service.js";
import type { TimingService } from "./timing-service.js";
import {
  DEFAULT_PROBE,
  anchorForCode,
  describeAnchor,
} from "./anchors.js";
import { decideTeachingTransition, nextFailedChecks } from "./state-rules.js";

type EpisodeRow = {
  id: string;
  student_id: string;
  task_id: string;
  question_version_id: string;
  state: "active" | "paused" | "finished";
  teaching_state: TeachingState;
  version: number;
  lease_epoch: number;
  lease_expires_at: Date;
  last_seq: number;
  exposure: Exposure;
  prior_exposure: boolean;
  started_at: Date;
};

type ActionRow = {
  id: string;
  episode_id: string;
  request_key: string;
  payload_hash: string;
  kind: TutoringActionInput["kind"];
  state_version: number;
  state: TeachingState;
  exposure: Exposure;
  display_status: TutoringActionDTO["displayStatus"];
  content: string;
  evidence: { kind: string; id: string; versionId?: string }[];
};

type DiagnosisRow = {
  id: string;
  attempt_id: string;
  version: number;
  status: DiagnosisDTO["status"];
  primary_code: DiagnosisDTO["primaryCode"];
  summary: string;
  evidence: DiagnosisDTO["evidence"];
  rule_version: string;
};

function hashPayload(kind: string, expectedVersion: number): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, expectedVersion]))
    .digest("hex");
}

function toActionDto(row: ActionRow): TutoringActionDTO {
  return {
    id: row.id,
    episodeId: row.episode_id,
    stateVersion: row.state_version,
    state: row.state,
    exposure: row.exposure,
    displayStatus: row.display_status,
    content: row.content,
    evidence: row.evidence,
  };
}

function toEpisodeDto(row: EpisodeRow, now: Date): EpisodeDTO {
  return {
    id: row.id,
    studentId: row.student_id,
    taskId: row.task_id,
    questionVersionId: row.question_version_id,
    version: row.version,
    leaseEpoch: row.lease_epoch,
    lastSeq: row.last_seq,
    state: row.state,
    teachingState: row.teaching_state,
    exposure: row.exposure,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    serverAt: now.toISOString(),
    priorExposure: row.prior_exposure,
    timing: EMPTY_TIMING_SUMMARY,
  };
}

async function lockEpisode(
  tx: pg.PoolClient,
  scope: StudentScope,
  episodeId: string,
): Promise<EpisodeRow> {
  const row = (
    await tx.query<EpisodeRow>(
      "SELECT * FROM tutoring_episodes WHERE id=$1 AND student_id=$2 FOR UPDATE",
      [episodeId, scope.studentId],
    )
  ).rows[0];
  if (!row) throw new AppError("NOT_FOUND", 404, "作答会话不存在");
  return row;
}

export class TutoringService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private timing: TimingService,
  ) {}

  async getState(scope: StudentScope, episodeId: string): Promise<EpisodeDTO> {
    return this.timing.get(scope, episodeId);
  }

  /** 当前学生在该任务上的进行中会话，没有则返回 null。 */
  async current(scope: StudentScope, taskId: string): Promise<EpisodeDTO | null> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query<{ id: string }>(
        "SELECT id FROM tutoring_episodes WHERE student_id=$1 AND task_id=$2 AND state IN ('active','paused') ORDER BY created_at DESC LIMIT 1",
        [scope.studentId, taskId],
      )
    ).rows[0];
    return row ? this.timing.get(scope, row.id) : null;
  }

  /**
   * 供辅导工具调用：找到当前会话后按学生请求推进一层自查。
   * 同一工具调用重试复用 requestKey，不重复登记暴露。
   */
  async guide(
    scope: StudentScope,
    taskId: string,
    kind: "request_hint" | "request_probe" | "request_example" | "request_explanation",
    requestKey: string,
  ): Promise<{ status: "delivered" | "no_episode"; action: TutoringActionDTO | null }> {
    const episode = await this.current(scope, taskId);
    if (!episode) return { status: "no_episode", action: null };
    try {
      const action = await this.act(scope, episode.id, {
        requestKey,
        expectedVersion: episode.version,
        kind,
      });
      return { status: "delivered", action };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
      const fresh = await this.current(scope, taskId);
      if (!fresh) return { status: "no_episode", action: null };
      const action = await this.act(scope, fresh.id, {
        requestKey,
        expectedVersion: fresh.version,
        kind,
      });
      return { status: "delivered", action };
    }
  }

  async act(
    scope: StudentScope,
    episodeId: string,
    input: unknown,
  ): Promise<TutoringActionDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = tutoringActionInputSchema.parse(input);
    const hash = hashPayload(v.kind, v.expectedVersion);
    return inTransaction(this.db, async (tx) => {
      const row = await lockEpisode(tx, scope, episodeId);
      const replay = (
        await tx.query<ActionRow>(
          "SELECT * FROM tutoring_actions WHERE episode_id=$1 AND request_key=$2",
          [row.id, v.requestKey],
        )
      ).rows[0];
      if (replay) {
        if (replay.payload_hash !== hash)
          throw new AppError("CONFLICT", 409, "重复请求内容不同");
        return toActionDto(replay);
      }
      if (row.state === "finished")
        throw new AppError("CONFLICT", 409, "作答会话已结束");
      if (v.expectedVersion !== row.version)
        throw new AppError("CONFLICT", 409, "状态已更新，请刷新后重试");

      const lastAction = (
        await tx.query<{ created_at: Date }>(
          "SELECT created_at FROM tutoring_actions WHERE episode_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1",
          [row.id],
        )
      ).rows[0];
      const since = lastAction?.created_at ?? row.started_at;
      const sawNewAttempt =
        ((
          await tx.query(
            "SELECT 1 FROM attempts WHERE student_id=$1 AND task_id=$2 AND question_version_id=$3 AND created_at > $4 LIMIT 1",
            [
              scope.studentId,
              row.task_id,
              row.question_version_id,
              since,
            ],
          )
        ).rowCount ?? 0) > 0;
      const previous = (
        await tx.query<{ failed_checks: number }>(
          "SELECT failed_checks FROM tutoring_states WHERE episode_id=$1 ORDER BY version DESC LIMIT 1",
          [row.id],
        )
      ).rows[0];
      const failedChecks = nextFailedChecks(
        previous?.failed_checks ?? 0,
        sawNewAttempt,
      );
      const diagnosis = await this.loadDiagnosis(
        tx,
        scope.studentId,
        row.task_id,
        row.question_version_id,
      );
      const decision = decideTeachingTransition({
        episode: toEpisodeDto(row, new Date()),
        diagnosis,
        action: v,
        failedChecks,
      });
      const content = this.renderContent(v.kind, diagnosis, decision.next);
      const nextVersion = (
        await tx.query<{ version: number }>(
          "SELECT coalesce(max(version),0)+1 AS version FROM tutoring_states WHERE episode_id=$1",
          [row.id],
        )
      ).rows[0]!.version;
      await tx.query(
        "INSERT INTO tutoring_states(episode_id,version,state,exposure,failed_checks) VALUES($1,$2,$3,$4,$5)",
        [row.id, nextVersion, decision.next, decision.exposure, failedChecks],
      );
      await tx.query(
        "UPDATE tutoring_episodes SET teaching_state=$2,exposure=$3,version=version+1,prior_exposure=prior_exposure OR $3 <> 'none',updated_at=$4 WHERE id=$1",
        [row.id, decision.next, decision.exposure, new Date()],
      );
      let action = (
        await tx.query<ActionRow>(
          "INSERT INTO tutoring_actions(episode_id,request_key,payload_hash,kind,state_version,state,exposure,display_status,content,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *",
          [
            row.id,
            v.requestKey,
            hash,
            v.kind,
            nextVersion,
            decision.next,
            decision.exposure,
            content ? "created" : "acknowledged",
            content,
            JSON.stringify(diagnosis?.evidence ?? []),
          ],
        )
      ).rows[0]!;
      if (content) action = await this.deliver(tx, row, action);
      return toActionDto(action);
    });
  }

  async acknowledge(
    scope: StudentScope,
    episodeId: string,
    actionId: string,
  ): Promise<TutoringActionDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    return inTransaction(this.db, async (tx) => {
      const row = await lockEpisode(tx, scope, episodeId);
      const existing = (
        await tx.query<ActionRow>(
          "SELECT * FROM tutoring_actions WHERE id=$1 AND episode_id=$2",
          [actionId, row.id],
        )
      ).rows[0];
      if (!existing) throw new AppError("NOT_FOUND", 404, "教学动作不存在");
      if (existing.display_status === "acknowledged") return toActionDto(existing);
      const updated = (
        await tx.query<ActionRow>(
          "UPDATE tutoring_actions SET display_status='acknowledged' WHERE id=$1 RETURNING *",
          [actionId],
        )
      ).rows[0]!;
      return toActionDto(updated);
    });
  }

  private async loadDiagnosis(
    tx: pg.PoolClient,
    studentId: string,
    taskId: string,
    questionVersionId: string,
  ): Promise<DiagnosisDTO | null> {
    const row = (
      await tx.query<DiagnosisRow>(
        "SELECT d.id,d.attempt_id,d.version,d.status,d.primary_code,d.summary,d.evidence,d.rule_version FROM error_diagnoses d JOIN attempts a ON a.id=d.attempt_id WHERE a.student_id=$1 AND a.task_id=$2 AND a.question_version_id=$3 ORDER BY d.created_at DESC, d.id DESC LIMIT 1",
        [studentId, taskId, questionVersionId],
      )
    ).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      attemptId: row.attempt_id,
      version: row.version,
      status: row.status,
      primaryCode: row.primary_code,
      candidates: [],
      summary: row.summary,
      evidence: row.evidence,
      ruleVersion: row.rule_version,
    };
  }

  private renderContent(
    kind: TutoringActionInput["kind"],
    diagnosis: DiagnosisDTO | null,
    next: TeachingState,
  ): string {
    const anchor = anchorForCode(diagnosis?.primaryCode ?? null);
    switch (kind) {
      case "request_hint":
        return `${anchor.hint}\n\n${describeAnchor(anchor)}`;
      case "request_probe":
        return (
          diagnosis?.candidates.find((candidate) => candidate.probe)?.probe ??
          DEFAULT_PROBE
        );
      case "request_example":
        return `先看一个同类例子：\n${anchor.example}\n\n看完后回到这道题，按同样的顺序写一步。`;
      case "request_explanation":
        return [
          diagnosis?.summary
            ? `当前证据支持的错因：${diagnosis.summary}`
            : "先按原题条件把关键步骤完整走一遍。",
          describeAnchor(anchor),
          "这一步现在自己重做一遍；我只在你再次卡住时补充。",
        ].join("\n\n");
      default:
        return next === "explanation"
          ? `${describeAnchor(anchor)}\n\n把这一步完整写出来再继续。`
          : "";
    }
  }

  private async deliver(
    tx: pg.PoolClient,
    episode: EpisodeRow,
    action: ActionRow,
  ): Promise<ActionRow> {
    const conversation = (
      await tx.query<{ id: string }>(
        "SELECT id FROM conversations WHERE task_id=$1 AND student_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1",
        [episode.task_id, episode.student_id],
      )
    ).rows[0];
    if (!conversation) return action;
    const message = (
      await tx.query<{ id: string }>(
        "INSERT INTO messages(conversation_id,role) VALUES($1,'assistant') RETURNING id",
        [conversation.id],
      )
    ).rows[0]!;
    const version = (
      await tx.query<{ id: string }>(
        "INSERT INTO message_versions(message_id,version_no,content) VALUES($1,1,$2) RETURNING id",
        [message.id, action.content],
      )
    ).rows[0]!;
    const level =
      action.exposure === "solution_exposed"
        ? "solution_exposed"
        : action.exposure === "guided"
          ? "guided"
          : "unknown";
    const hint = (
      await tx.query<{ id: string }>(
        "INSERT INTO hints(task_id,question_version_id,message_version_id,level) VALUES($1,$2,$3,$4) RETURNING id",
        [episode.task_id, episode.question_version_id, version.id, level],
      )
    ).rows[0]!;
    return (
      await tx.query<ActionRow>(
        "UPDATE tutoring_actions SET message_version_id=$2,hint_id=$3,display_status='sent' WHERE id=$1 RETURNING *",
        [action.id, version.id, hint.id],
      )
    ).rows[0]!;
  }
}
