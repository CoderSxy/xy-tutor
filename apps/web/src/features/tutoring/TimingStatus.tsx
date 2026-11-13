import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import type { TimingSnapshot } from "./timing-client";

const elapsed = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

const pausedCopy: Record<string, string> = {
  user: "已暂停记录作答时间。",
  hidden: "已暂停：页面不在前台的时间不算作答。",
  offline: "已暂停：断网期间的时间不算作答。",
  waiting_ai: "已暂停：等讲解的时间不算你的作答时间。",
  limit: "记录不完整：这一段已到记录上限，继续会另开一段，本题时间只算部分有效。",
};

export function TimingStatus({
  snapshot,
  onStart,
  onPause,
  onResume,
}: {
  snapshot: TimingSnapshot;
  onStart: (takeOver?: boolean) => void;
  onPause: () => void;
  onResume: () => void;
}) {
  // snapshot 只在 start/checkpoint 时刷新，秒表要自己按最后一次读数外推。
  const [shownMs, setShownMs] = useState(snapshot.activeMs);
  const baseMs = useRef(snapshot.activeMs);
  const baseAt = useRef(Date.now());
  useEffect(() => {
    baseMs.current = snapshot.activeMs;
    baseAt.current = Date.now();
    setShownMs(snapshot.activeMs);
  }, [snapshot.activeMs, snapshot.status]);
  useEffect(() => {
    if (snapshot.status !== "running") return;
    const timer = setInterval(
      () => setShownMs(baseMs.current + (Date.now() - baseAt.current)),
      1000,
    );
    return () => clearInterval(timer);
  }, [snapshot.status, snapshot.activeMs]);

  const { status, pauseReason, conflict, error, restoredMs, limited } =
    snapshot;

  if (status === "running")
    return (
      <div className="timing-bar">
        <p className="timing-status" role="status" aria-live="polite">
          <span className="timing-dot" aria-hidden="true" />
          正在记录作答时间 · {elapsed(shownMs)}
        </p>
        <Button
          variant="ghost"
          size="small"
          aria-label="暂停记录本题作答时间"
          onClick={onPause}
        >
          暂停
        </Button>
      </div>
    );

  if (status === "starting")
    return (
      <p className="timing-bar timing-status" role="status" aria-live="polite">
        正在开始记录…
      </p>
    );

  if (status === "paused")
    return (
      <div className="timing-bar">
        <p className="timing-status" role="status" aria-live="polite">
          {pausedCopy[pauseReason ?? "user"] ?? "已暂停记录作答时间。"} 已记录{" "}
          {elapsed(snapshot.activeMs)}。
        </p>
        <Button
          variant="outline"
          size="small"
          aria-label="继续记录本题作答时间"
          onClick={onResume}
        >
          {limited ? "继续作答（新的一段）" : "继续作答"}
        </Button>
      </div>
    );

  if (status === "finished")
    return (
      <p className="timing-bar timing-status" role="status" aria-live="polite">
        {error || "本题作答时间已记录。"}
      </p>
    );

  return (
    <div className="timing-bar">
      <p className="timing-status" role="status" aria-live="polite">
        {conflict
          ? "另一个窗口正在记录这道题，可以在这里接管。"
          : restoredMs !== null
            ? `上次这题记录了 ${elapsed(restoredMs)}，当时没有交答案。重新开始会另记一段。`
            : "作答时间只用来还原你的思考过程，不判断对错。"}
      </p>
      <Button
        variant={conflict ? "outline" : "ghost"}
        size="small"
        aria-label={
          conflict ? "在这里接管这道题的计时" : "开始记录本题的作答时间"
        }
        onClick={() => onStart(conflict)}
      >
        {conflict ? "接管计时" : "开始作答"}
      </Button>
    </div>
  );
}
