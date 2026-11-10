import { LoaderCircle, TriangleAlert, BookOpen, Clock } from "lucide-react";
import { Button } from "./ui/button";
export function StatusPanel({
  state = "empty",
  title,
  children,
  onRetry,
}: {
  state?: "empty" | "loading" | "error" | "queued";
  title: string;
  children?: React.ReactNode;
  onRetry?: () => void;
}) {
  const Icon =
    state === "loading"
      ? LoaderCircle
      : state === "error"
        ? TriangleAlert
        : state === "queued"
          ? Clock
          : BookOpen;
  return (
    <div
      className={`status-panel status-${state}`}
      role={state === "error" ? "alert" : "status"}
    >
      <Icon
        aria-hidden
        size={28}
        className={state === "loading" ? "spin" : ""}
      />
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}
