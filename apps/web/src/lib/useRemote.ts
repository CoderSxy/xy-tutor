import { useState, useEffect, useCallback } from "react";
import { api, errorMessage } from "./api";
export function useRemote<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [forPath, setForPath] = useState<string>();
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      setForPath(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setForPath(path);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, forPath, setData, loading, error, reload };
}
