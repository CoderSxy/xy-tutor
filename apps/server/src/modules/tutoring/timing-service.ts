import { createHash } from "node:crypto";
import type pg from "pg";
import {
  inTransaction,
  type Database,
} from "../../../../../packages/db/src/client.js";
import type { StudentScope } from "../../../../../packages/contracts/src/domain.js";
import { AppError } from "../../../../../packages/contracts/src/api.js";
import {
  EMPTY_TIMING_SUMMARY,
  TIMING_LIMITS,
  timingEventSchema,
  type TimingEventInput,
  type TimingSegment,
  type TimingState,
  type TimingSummary,
} from "../../../../../packages/contracts/src/learning-timing.js";
import {
  episodeStartInputSchema,
  type EpisodeDTO,
  type Exposure,
  type TeachingState,
} from "../../../../../packages/contracts/src/tutoring.js";
import type { AuthService } from "../auth/service.js";
import {
  qualityFromReasons,
  reduceTiming,
  summarizeTiming,
} from "./timing-rules.js";

type EpisodeRow = {
  id: string;
  student_id: string;
  task_id: string;
  question_version_id: string;
  request_key: string;
  state: "active" | "paused" | "finished";
  teaching_state: TeachingState;
  version: number;
  lease_epoch: number;
  lease_expires_at: Date;
  last_seq: number;
  exposure: Exposure;
  prior_exposure: boolean;
  started_at: Date;
  ended_at: Date | null;
  first_submitted_at: Date | null;
};

type SegmentRow = {
  id: string;
  phase: TimingSegment["phase"];
  start_at: Date;
  end_at: Date | null;
  accepted_ms: number;
  quality: TimingSegment["quality"];
  reason_codes: string[];
};

function hashEvent(event: TimingEventInput): string {
  const canonical = JSON.stringify([
    event.eventId,
    event.episodeId,
    event.leaseEpoch,
    event.seq,
    event.segmentId,
    event.kind,
    event.cumulativeActiveMs,
    event.phase,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function toSegment(row: SegmentRow): TimingSegment {
  return {
    id: row.id,
    phase: row.phase,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at ? row.end_at.toISOString() : null,
    acceptedMs: row.accepted_ms,
    quality: row.quality,
  };
}

function toDto(row: EpisodeRow, segments: SegmentRow[], serverAt: Date): EpisodeDTO {
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
    serverAt: serverAt.toISOString(),
    priorExposure: row.prior_exposure,
    timing: summarizeTiming(
      segments.map(toSegment),
      row.first_submitted_at,
      row.ended_at,
    ),
  };
}

async function loadSegments(
  tx: pg.PoolClient,
  episodeId: string,
): Promise<SegmentRow[]> {
  return (
    await tx.query<SegmentRow>(
      "SELECT id,phase,start_at,end_at,accepted_ms,quality,reason_codes FROM timing_segments WHERE episode_id=$1 ORDER BY start_at",
      [episodeId],
    )
  ).rows;
}

async function loadState(
  tx: pg.PoolClient,
  row: EpisodeRow,
): Promise<TimingState> {
  const open = (
    await tx.query<SegmentRow>(
      "SELECT id,phase,start_at,end_at,accepted_ms,quality,reason_codes FROM timing_segments WHERE episode_id=$1 AND end_at IS NULL ORDER BY start_at DESC LIMIT 1",
      [row.id],
    )
  ).rows[0];
  const last = (
    await tx.query<{
      phase: TimingState["phase"];
      cumulative_active_ms: number;
      received_at: Date;
    }>(
      "SELECT phase,cumulative_active_ms,received_at FROM timing_events WHERE episode_id=$1 ORDER BY seq DESC LIMIT 1",
      [row.id],
    )
  ).rows[0];
  const eventsInSegment = open
    ? (
        await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM timing_events WHERE episode_id=$1 AND segment_id=$2",
          [row.id, open.id],
        )
      ).rows[0]!.n
    : 0;
  const reasons = (
    await tx.query<{ reason_codes: string[] }>(
      "SELECT reason_codes FROM timing_segments WHERE episode_id=$1",
      [row.id],
    )
  ).rows.flatMap((r) => r.reason_codes);

  return {
    episodeId: row.id,
    state: row.state,
    leaseEpoch: row.lease_epoch,
    version: row.version,
    lastSeq: row.last_seq,
    segmentId: open?.id ?? null,
    segmentStartedAt: open ? open.start_at.toISOString() : null,
    eventsInSegment,
    lastReceivedAt: last ? last.received_at.toISOString() : null,
    lastCumulativeMs: last?.cumulative_active_ms ?? 0,
    firstSubmittedAt: row.first_submitted_at
      ? row.first_submitted_at.toISOString()
      : null,
    phase: last?.phase ?? "initial",
    reasons: [...new Set(reasons)],
  };
}

async function persistSegment(
  tx: pg.PoolClient,
  episodeId: string,
  event: TimingEventInput,
  state: TimingState,
  acceptedMs: number,
  now: Date,
): Promise<void> {
  const closing = event.kind === "pause" || event.kind === "finish";
  if (event.kind === "start" || event.kind === "resume") {
    await tx.query(
      "INSERT INTO timing_segments(id,episode_id,phase,start_at,accepted_ms,quality,reason_codes) VALUES($1,$2,$3,$4,0,$5,$6::jsonb) ON CONFLICT (id) DO NOTHING",
      [
        event.segmentId,
        episodeId,
        event.phase,
        now,
        qualityFromReasons(state.reasons),
        JSON.stringify(state.reasons),
      ],
    );
    return;
  }
  if (closing) {
    await tx.query(
      "UPDATE timing_segments SET accepted_ms=accepted_ms+$2,end_at=$3,quality=$4,reason_codes=$5::jsonb WHERE id=$1",
      [
        event.segmentId,
        acceptedMs,
        now,
        qualityFromReasons(state.reasons),
        JSON.stringify(state.reasons),
      ],
    );
    return;
  }
  await tx.query(
    "UPDATE timing_segments SET accepted_ms=accepted_ms+$2,reason_codes=$3::jsonb WHERE id=$1",
    [event.segmentId, acceptedMs, JSON.stringify(state.reasons)],
  );
}

async function applyEvent(
  tx: pg.PoolClient,
  episodeId: string,
  state: TimingState,
  event: TimingEventInput,
  now: Date,
): Promise<TimingState> {
  const hash = hashEvent(event);
  const existing = (
    await tx.query<{ payload_hash: string }>(
      "SELECT payload_hash FROM timing_events WHERE episode_id=$1 AND event_id=$2",
      [episodeId, event.eventId],
    )
  ).rows[0];
  if (existing) {
    if (existing.payload_hash === hash) return state;
    throw new AppError("CONFLICT", 409, "重复事件内容不同");
  }
  if (event.seq <= state.lastSeq) {
    throw new AppError("CONFLICT", 409, "事件序列已存在不同内容");
  }

  const reduction = reduceTiming(state, event, now);
  if (reduction.duplicate) return state;

  await tx.query(
    "INSERT INTO timing_events(episode_id,event_id,seq,segment_id,lease_epoch,kind,cumulative_active_ms,accepted_ms,phase,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      episodeId,
      event.eventId,
      event.seq,
      event.segmentId,
      event.leaseEpoch,
      event.kind,
      event.cumulativeActiveMs,
      reduction.acceptedMs,
      event.phase,
      hash,
      now,
    ],
  );
  await persistSegment(
    tx,
    episodeId,
    event,
    reduction.state,
    reduction.acceptedMs,
    now,
  );
  return reduction.state;
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

async function closeOpenSegment(
  tx: pg.PoolClient,
  episodeId: string,
  now: Date,
): Promise<void> {
  await tx.query(
    "UPDATE timing_segments SET end_at=$2 WHERE episode_id=$1 AND end_at IS NULL",
    [episodeId, now],
  );
}

export class TimingService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}

  async start(scope: StudentScope, input: unknown): Promise<EpisodeDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const v = episodeStartInputSchema.parse(input);
    return inTransaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM student_profiles WHERE id=$1 FOR UPDATE", [
        scope.studentId,
      ]);
      const replay = (
        await tx.query<EpisodeRow>(
          "SELECT * FROM tutoring_episodes WHERE student_id=$1 AND request_key=$2",
          [scope.studentId, v.requestKey],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.task_id !== v.taskId ||
          replay.question_version_id !== v.questionVersionId
        )
          throw new AppError("CONFLICT", 409, "重复开始请求内容不同");
        return toDto(replay, await loadSegments(tx, replay.id), new Date());
      }

      const task = (
        await tx.query("SELECT id FROM learning_tasks WHERE id=$1 AND student_id=$2", [
          v.taskId,
          scope.studentId,
        ])
      ).rows[0];
      const question = (
        await tx.query(
          "SELECT v.id FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE v.id=$1 AND (q.student_id=$2 OR q.student_id IS NULL)",
          [v.questionVersionId, scope.studentId],
        )
      ).rows[0];
      if (!task || !question)
        throw new AppError("NOT_FOUND", 404, "题目或任务不存在");

      const open = (
        await tx.query<EpisodeRow>(
          "SELECT * FROM tutoring_episodes WHERE student_id=$1 AND state IN ('active','paused') FOR UPDATE",
          [scope.studentId],
        )
      ).rows[0];
      if (open && !v.takeOver)
        throw new AppError("CONFLICT", 409, "已有进行中的作答");
      const now = new Date();
      const nextEpoch = (open?.lease_epoch ?? 0) + 1;
      if (open) {
        await closeOpenSegment(tx, open.id, now);
        await tx.query(
          "UPDATE tutoring_episodes SET state='finished',lease_epoch=$2,ended_at=$3,updated_at=$3 WHERE id=$1",
          [open.id, nextEpoch, now],
        );
      }

      const row = (
        await tx.query<EpisodeRow>(
          "INSERT INTO tutoring_episodes(student_id,task_id,question_version_id,request_key,state,lease_epoch,lease_expires_at,started_at) VALUES($1,$2,$3,$4,'active',$5,$6,$7) RETURNING *",
          [
            scope.studentId,
            v.taskId,
            v.questionVersionId,
            v.requestKey,
            nextEpoch,
            new Date(now.getTime() + TIMING_LIMITS.leaseMs),
            now,
          ],
        )
      ).rows[0]!;
      return toDto(row, [], now);
    });
  }

  async get(scope: StudentScope, episodeId: string): Promise<EpisodeDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const row = (
      await this.db.pool.query<EpisodeRow>(
        "SELECT * FROM tutoring_episodes WHERE id=$1 AND student_id=$2",
        [episodeId, scope.studentId],
      )
    ).rows[0];
    if (!row) throw new AppError("NOT_FOUND", 404, "作答会话不存在");
    const segments = (
      await this.db.pool.query<SegmentRow>(
        "SELECT id,phase,start_at,end_at,accepted_ms,quality,reason_codes FROM timing_segments WHERE episode_id=$1 ORDER BY start_at",
        [row.id],
      )
    ).rows;
    return toDto(row, segments, new Date());
  }

  async append(
    scope: StudentScope,
    episodeId: string,
    events: TimingEventInput[],
  ): Promise<EpisodeDTO> {
    await this.auth.requireStudentAccess(scope.actor, scope.studentId);
    const parsed = events.map((event) => timingEventSchema.parse(event));
    return inTransaction(this.db, async (tx) => {
      const row = await lockEpisode(tx, scope, episodeId);
      const now = new Date();
      if (parsed.some((event) => event.leaseEpoch !== row.lease_epoch))
        throw new AppError("CONFLICT", 409, "作答租约已被接管");
      if (row.state === "finished")
        throw new AppError("CONFLICT", 409, "作答会话已结束");
      if (row.lease_expires_at.getTime() < now.getTime())
        throw new AppError("CONFLICT", 409, "作答租约已过期");

      let state = await loadState(tx, row);
      const ordered = [...parsed].sort((a, b) => a.seq - b.seq);
      for (const event of ordered) {
        state = await applyEvent(tx, row.id, state, event, now);
      }
      // A pure retry only renews the lease; it must not advance the version
      // the client uses to detect concurrent writes.
      const advanced = state.lastSeq !== row.last_seq;
      await tx.query(
        "UPDATE tutoring_episodes SET state=$2,last_seq=$3,version=version+$6,lease_expires_at=$4,updated_at=$5,ended_at=CASE WHEN $2='finished' THEN COALESCE(ended_at,$5) ELSE ended_at END WHERE id=$1",
        [
          row.id,
          state.state,
          Math.max(row.last_seq, state.lastSeq),
          new Date(now.getTime() + TIMING_LIMITS.leaseMs),
          now,
          advanced ? 1 : 0,
        ],
      );
      const fresh = await lockEpisode(tx, scope, episodeId);
      return toDto(fresh, await loadSegments(tx, episodeId), now);
    });
  }

  /**
   * Binds an attempt to its timing episode inside the caller's transaction.
   * A missing or invalid final event degrades quality but never fails the
   * answer that is already being saved.
   */
  async attachAttempt(
    tx: pg.PoolClient,
    scope: StudentScope,
    attemptId: string,
    attempt: { taskId: string; questionVersionId: string; createdAt: Date },
    episodeId?: string,
    finalEvent?: TimingEventInput,
  ): Promise<{ timing: TimingSummary; warning: string | null }> {
    if (!episodeId) {
      await tx.query(
        "INSERT INTO attempt_timing_snapshots(attempt_id,version,quality,reason_codes) VALUES($1,1,'missing','[\"not_collected\"]'::jsonb)",
        [attemptId],
      );
      return { timing: EMPTY_TIMING_SUMMARY, warning: null };
    }

    const row = await lockEpisode(tx, scope, episodeId);
    if (
      row.task_id !== attempt.taskId ||
      row.question_version_id !== attempt.questionVersionId
    )
      throw new AppError("VALIDATION", 422, "作答与计时会话不匹配");

    const now = new Date();
    let state = await loadState(tx, row);
    let warning: string | null = null;

    if (finalEvent) {
      if (
        finalEvent.episodeId !== episodeId ||
        finalEvent.leaseEpoch !== row.lease_epoch ||
        finalEvent.seq <= row.last_seq
      ) {
        warning = "最终计时事件已过期，本次计时质量降级";
      } else {
        state = await applyEvent(tx, row.id, state, finalEvent, now);
      }
    }

    const firstSubmittedAt = row.first_submitted_at ?? attempt.createdAt;
    await closeOpenSegment(tx, row.id, now);
    const fresh = (
      await tx.query<EpisodeRow>(
        "UPDATE tutoring_episodes SET state='finished',first_submitted_at=COALESCE(first_submitted_at,$2),ended_at=COALESCE(ended_at,$3),updated_at=$3,version=version+1,last_seq=$4 WHERE id=$1 RETURNING *",
        [row.id, firstSubmittedAt, now, Math.max(row.last_seq, state.lastSeq)],
      )
    ).rows[0]!;
    const segments = await loadSegments(tx, row.id);
    const timing = summarizeTiming(
      segments.map(toSegment),
      fresh.first_submitted_at,
      fresh.ended_at,
    );
    await tx.query(
      "INSERT INTO attempt_timing_snapshots(attempt_id,episode_id,version,first_attempt_ms,self_check_ms,post_hint_ms,total_active_ms,wall_ms,quality,reason_codes,first_submitted_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
      [
        attemptId,
        row.id,
        timing.firstAttemptMs,
        timing.selfCheckMs,
        timing.postHintMs,
        timing.totalActiveMs,
        timing.wallMs,
        timing.quality,
        JSON.stringify(timing.reasonCodes),
        firstSubmittedAt,
      ],
    );
    return { timing, warning };
  }
}
