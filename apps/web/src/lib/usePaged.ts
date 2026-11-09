import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

export type Paged<T> = { items: T[]; total: number; pageVersion?: string };

export function usePaged<T>(path: string | null, pageSize = 10) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(!!path);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  const pageVersion = useRef<string | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (offset: number, append: boolean): Promise<boolean> => {
      if (!path) return false;
      const id = ++seq.current;
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const sep = path.includes("?") ? "&" : "?";
        const data = await api<Paged<T>>(
          `${path}${sep}limit=${pageSize}&offset=${offset}`,
          { signal: next.signal },
        );
        if (id !== seq.current) return false;
        if (append && data.pageVersion !== pageVersion.current) {
          setPage(0);
          await load(0, false);
          return false;
        }
        pageVersion.current = data.pageVersion;
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        return true;
      } catch (e) {
        if (id !== seq.current || next.signal.aborted) return false;
        setError(errorMessage(e));
        return false;
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [path, pageSize],
  );

  const reload = useCallback(() => {
    if (!path) return;
    setItems([]);
    setTotal(0);
    setPage(0);
    void load(0, false);
  }, [path, load]);

  useEffect(() => {
    if (!path) {
      ++seq.current;
      controller.current?.abort();
      setLoadingMore(false);
      setItems([]);
      setTotal(0);
      setPage(0);
      setLoading(false);
      setError("");
      return;
    }
    reload();
  }, [path, reload]);

  useEffect(() => () => controller.current?.abort(), []);

  const loadMore = useCallback(async () => {
    if (!path || loading || loadingMore || items.length >= total) return;
    const target = page + 1;
    if (await load(target * pageSize, true)) setPage(target);
  }, [path, loading, loadingMore, items.length, total, page, pageSize, load]);

  const goTo = useCallback(
    async (target: number) => {
      if (!path || loading || loadingMore || target === page) return;
      if (target < 0 || target >= Math.max(1, Math.ceil(total / pageSize)))
        return;
      if (await load(target * pageSize, false)) setPage(target);
    },
    [path, loading, loadingMore, page, total, pageSize, load],
  );

  return {
    items,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    hasMore: items.length < total,
    loading,
    loadingMore,
    error,
    loadMore,
    goTo,
    reload,
  };
}
