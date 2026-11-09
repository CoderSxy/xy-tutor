import type { RevisionDTO, TaskDTO } from "./types";
import { kindLabels } from "./types";

export const statusLabels: Record<TaskDTO["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已结束",
};

export function shortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toLocaleDateString(
    "zh-CN",
    d.getFullYear() === now.getFullYear()
      ? { month: "numeric", day: "numeric" }
      : { year: "numeric", month: "numeric", day: "numeric" },
  );
}

export function fullDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function sessionTitle(t: TaskDTO) {
  return t.title?.trim() || `${kindLabels[t.kind]} · ${shortDate(t.createdAt)}`;
}

export function bookMeta(r: RevisionDTO) {
  return [r.edition, r.grade, r.subject, r.term, `${r.publicationYear}年版`]
    .filter(Boolean)
    .join(" · ");
}
