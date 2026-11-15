import type { PracticeSetDTO } from "../../../../../packages/contracts/src/practice-sets.js";

export function PracticeResults({ set }: { set: PracticeSetDTO }) {
  return (
    <section className="practice-results" aria-live="polite">
      <p>
        已提交 {set.counts.submitted} 题，跳过 {set.counts.skipped} 题，已核验{" "}
        {set.counts.verified} 题
        {set.counts.pending ? `，待核验 ${set.counts.pending} 题` : ""}。
      </p>
      <ul>
        {set.items.map((item) => (
          <li key={item.slotId}>
            第 {item.position + 1} 题：
            {item.progress.submission === "skipped"
              ? "已跳过"
              : item.progress.grading === "queued"
                ? "批改排队中"
                : item.progress.grading === "running"
                  ? "正在批改"
                  : item.progress.grading === "pending"
                    ? "待核验"
                    : item.progress.grading === "failed"
                      ? "批改失败，可重试"
                      : item.progress.correctness === "correct"
                        ? "正确"
                        : item.progress.correctness === "incorrect"
                          ? "需要订正"
                          : "未作答"}
            {item.progress.mistakeSync === "queued" && " · 错题同步中"}
            {item.progress.mistakeSync === "synced" && " · 已加入学习错题"}
            {item.progress.mistakeSync === "failed" && " · 错题同步失败"}
          </li>
        ))}
      </ul>
    </section>
  );
}
