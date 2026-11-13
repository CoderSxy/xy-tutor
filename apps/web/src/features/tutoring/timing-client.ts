import {
  TIMING_LIMITS,
  type TimingEventInput,
} from "../../../../../packages/contracts/src/learning-timing.js";
import type {
  EpisodeDTO,
  EpisodeStartInput,
} from "../../../../../packages/contracts/src/tutoring.js";

export type TimingStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "finished";
export type TimingPauseReason =
  | "user"
  | "hidden"
  | "offline"
  | "waiting_ai"
  | "limit";

export type TimingSnapshot = {
  status: TimingStatus;
  pauseReason: TimingPauseReason | null;
  episodeId: string | null;
  activeMs: number;
  priorExposure: boolean;
  conflict: boolean;
  limited: boolean;
  error: string;
  restoredMs: number | null;
};

export type TimingSubmission = {
  episodeId?: string;
  timingFinalEvent?: TimingEventInput;
};

type TimingApi = {
  start(input: EpisodeStartInput): Promise<EpisodeDTO>;
  append(episodeId: string, events: TimingEventInput[]): Promise<EpisodeDTO>;
};

export type TimingClient = {
  snapshot(): TimingSnapshot;
  subscribe(listener: (snapshot: TimingSnapshot) => void): () => void;
  start(input: {
    taskId: string;
    questionVersionId: string;
    takeOver?: boolean;
  }): Promise<boolean>;
  pause(reason?: TimingPauseReason): Promise<void>;
  resume(): Promise<void>;
  checkpoint(): Promise<void>;
  prepareSubmission(): Promise<TimingSubmission>;
  restore(episode: EpisodeDTO): void;
  dispose(): void;
};

type ConflictLike = { status?: number; code?: string; message?: string };

const conflict = (error: unknown) => {
  const value = error as ConflictLike;
  return value?.status === 409 || value?.code === "CONFLICT";
};

const messageOf = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "计时暂时无法同步，答案仍会正常保存";

/**
 * Tracks how long the student actually worked on one question. It never reads
 * keystrokes: time runs while the student has the question open and stops on
 * the conditions the student cannot control (tab hidden, offline, waiting for
 * the tutor), so reading and thinking on paper still counts.
 */
export function createTimingClient(deps: {
  api: TimingApi;
  monotonicNow?: () => number;
  newId?: () => string;
  onChange?: (snapshot: TimingSnapshot) => void;
  checkpointMs?: number;
  keepAliveMs?: number;
  maxEvents?: number;
}): TimingClient {
  const now = deps.monotonicNow ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const checkpointMs = deps.checkpointMs ?? TIMING_LIMITS.checkpointMs;
  const keepAliveMs = deps.keepAliveMs ?? Math.floor(TIMING_LIMITS.leaseMs / 2);
  const maxEvents = deps.maxEvents ?? TIMING_LIMITS.maxEpisodeEvents;

  let status: TimingStatus = "idle";
  let pauseReason: TimingPauseReason | null = null;
  let episodeId: string | null = null;
  let startedFor = "";
  let epoch = 0;
  let version = 1;
  let seq = 0;
  let segmentId: string | null = null;
  let segmentStartedAt: number | null = null;
  let closedMs = 0;
  let eventsInSegment = 0;
  let queue: TimingEventInput[] = [];
  let lastEvent: TimingEventInput | null = null;
  let lastSubmission: TimingSubmission | null = null;
  let pendingPause: TimingPauseReason | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let starting: Promise<boolean> | null = null;
  let flushing: Promise<void> = Promise.resolve();
  let disposed = false;
  let error = "";
  let conflictState = false;
  let limited = false;
  let priorExposure = false;
  let restoredMs: number | null = null;
  let restoredEpisodeId: string | null = null;
  const listeners = new Set<(snapshot: TimingSnapshot) => void>();

  const openElapsed = () =>
    segmentStartedAt === null ? 0 : Math.max(0, now() - segmentStartedAt);

  const snapshot = (): TimingSnapshot => ({
    status,
    pauseReason,
    episodeId,
    activeMs: closedMs + openElapsed(),
    priorExposure,
    conflict: conflictState,
    limited,
    error,
    restoredMs,
  });

  const emit = () => {
    const value = snapshot();
    deps.onChange?.(value);
    for (const listener of listeners) listener(value);
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const stopKeepAlive = () => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  };

  const applyEpisode = (episode: EpisodeDTO) => {
    epoch = episode.leaseEpoch;
    version = episode.version;
    priorExposure = episode.priorExposure;
    if (episode.state === "finished") {
      stopTimer();
      stopKeepAlive();
      status = "finished";
      pauseReason = null;
    }
  };

  const makeEvent = (
    kind: TimingEventInput["kind"],
    cumulativeActiveMs: number,
  ): TimingEventInput | null => {
    if (!episodeId || !segmentId) return null;
    seq += 1;
    eventsInSegment += 1;
    return {
      eventId: newId(),
      episodeId,
      leaseEpoch: epoch,
      seq,
      segmentId,
      kind,
      cumulativeActiveMs: Math.max(0, Math.round(cumulativeActiveMs)),
      phase: "initial",
      expectedVersion: version,
    };
  };

  function flush(): Promise<void> {
    flushing = flushing.then(async () => {
      while (queue.length && episodeId && !disposed) {
        const batch = queue.slice(0, TIMING_LIMITS.maxBatchEvents);
        try {
          const episode = await deps.api.append(episodeId, batch);
          queue = queue.slice(batch.length);
          error = "";
          applyEpisode(episode);
        } catch (e) {
          if (conflict(e)) {
            // 任务被别的窗口接管或租约过期：停止计时，但答案照常可交。
            queue = [];
            stopTimer();
            stopKeepAlive();
            status = "finished";
            pauseReason = null;
            error = messageOf(e);
          } else {
            error = messageOf(e);
            // 网络抖动先留着，下一次 checkpoint 继续尝试。
            break;
          }
          emit();
          return;
        }
        if (status === "finished") {
          queue = [];
          break;
        }
        emit();
      }
    });
    return flushing;
  }

  const renewLease = () => {
    if (status !== "paused" || !episodeId || !lastEvent || !episodeId) return;
    const event = lastEvent;
    const id = episodeId;
    flushing = flushing.then(async () => {
      if (disposed || !id || status !== "paused") return;
      try {
        // 重复事件只续租，不改变服务端记录。
        await deps.api.append(id, [event]);
      } catch (e) {
        if (conflict(e)) {
          error = messageOf(e);
          emit();
        }
      }
    });
  };

  const startTimer = () => {
    stopTimer();
    timer = setInterval(() => void client.checkpoint(), checkpointMs);
  };

  const startKeepAlive = () => {
    stopKeepAlive();
    keepAlive = setInterval(renewLease, keepAliveMs);
  };

  const client: TimingClient = {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(input) {
      if (disposed) return false;
      const key = `${input.taskId}:${input.questionVersionId}`;
      if (status === "starting" && starting) return starting;
      if (
        (status === "running" || status === "paused") &&
        startedFor === key
      )
        return true;
      // 恢复出来的旧会话仍未结束，新的一段要接管它，否则 start 会被拒。
      let takeOver = (input.takeOver ?? false) || !!restoredEpisodeId;
      if (status === "running") await client.pause("user");
      if (status === "paused" && episodeId) {
        // 换题时上一段未提交的会话会挡住新会话，主动接管自己留下的记录。
        takeOver = true;
        stopKeepAlive();
        episodeId = null;
        lastEvent = null;
      }
      status = "starting";
      conflictState = false;
      error = "";
      emit();
      starting = (async () => {
        try {
          const episode = await deps.api.start({
            taskId: input.taskId,
            questionVersionId: input.questionVersionId,
            requestKey: newId(),
            ...(takeOver ? { takeOver: true } : {}),
          });
          episodeId = episode.id;
          startedFor = key;
          closedMs = 0;
          eventsInSegment = 0;
          queue = [];
          lastSubmission = null;
          limited = false;
          restoredMs = null;
          restoredEpisodeId = null;
          seq = episode.lastSeq;
          applyEpisode(episode);
          segmentId = newId();
          segmentStartedAt = now();
          status = "running";
          pauseReason = null;
          const event = makeEvent("start", 0);
          if (event) {
            queue.push(event);
            lastEvent = event;
          }
          startTimer();
          emit();
          await flush();
          if (pendingPause) {
            const reason = pendingPause;
            pendingPause = null;
            await client.pause(reason);
          }
          return true;
        } catch (e) {
          status = "idle";
          conflictState = conflict(e);
          error = messageOf(e);
          emit();
          return false;
        } finally {
          starting = null;
        }
      })();
      return starting;
    },
    async pause(reason = "user") {
      if (status === "starting") {
        pendingPause = reason;
        return;
      }
      if (status !== "running" || !segmentId) return;
      const elapsed = openElapsed();
      closedMs += elapsed;
      const event = makeEvent("pause", elapsed);
      if (event) {
        queue.push(event);
        lastEvent = event;
      }
      segmentId = null;
      segmentStartedAt = null;
      status = "paused";
      pauseReason = reason;
      stopTimer();
      startKeepAlive();
      emit();
      await flush();
    },
    async resume() {
      if (status !== "paused" || !episodeId) return;
      if (limited) {
        // 上一段事件已满：从零开始新的一段，服务端把旧段收尾。
        eventsInSegment = 0;
        limited = false;
      }
      segmentId = newId();
      segmentStartedAt = now();
      const event = makeEvent("resume", 0);
      if (event) {
        queue.push(event);
        lastEvent = event;
      }
      status = "running";
      pauseReason = null;
      error = "";
      stopKeepAlive();
      startTimer();
      emit();
      await flush();
    },
    async checkpoint() {
      if (status !== "running" || !segmentId) return;
      if (eventsInSegment >= maxEvents) {
        closedMs += openElapsed();
        segmentId = null;
        segmentStartedAt = null;
        status = "paused";
        pauseReason = "limit";
        limited = true;
        stopTimer();
        startKeepAlive();
        emit();
        return;
      }
      const event = makeEvent("checkpoint", openElapsed());
      if (!event) return;
      queue.push(event);
      lastEvent = event;
      emit();
      await flush();
    },
    async prepareSubmission() {
      if (!episodeId) return {};
      if (lastSubmission) return lastSubmission;
      if (status === "running" && segmentId) {
        const elapsed = openElapsed();
        closedMs += elapsed;
        const finish = makeEvent("finish", elapsed);
        segmentId = null;
        segmentStartedAt = null;
        status = "finished";
        pauseReason = null;
        stopTimer();
        stopKeepAlive();
        emit();
        await flush();
        queue = [];
        lastSubmission = finish
          ? { episodeId, timingFinalEvent: finish }
          : { episodeId };
        return lastSubmission;
      }
      if (status === "paused") {
        status = "finished";
        pauseReason = null;
        stopKeepAlive();
        emit();
        await flush();
        queue = [];
      }
      lastSubmission = { episodeId };
      return lastSubmission;
    },
    restore(episode) {
      if (status !== "idle" || episodeId) return;
      priorExposure = episode.priorExposure;
      restoredMs = episode.timing.totalActiveMs;
      restoredEpisodeId = episode.state === "finished" ? null : episode.id;
      emit();
    },
    dispose() {
      disposed = true;
      stopTimer();
      stopKeepAlive();
      listeners.clear();
    },
  };
  return client;
}
