import { useEffect } from "react";
import { api, jsonBody } from "../../lib/api";

const VISIT_INTERVAL_MS = 5 * 60 * 1000;

export function useStudentVisit(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let lastSentAt = 0;
    const send = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastSentAt < VISIT_INTERVAL_MS) return;
      lastSentAt = now;
      void api("/api/student-visits", {
        method: "POST",
        ...jsonBody({}),
      }).catch(() => {});
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") send();
    };
    send();
    const timer = window.setInterval(send, VISIT_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);
}
