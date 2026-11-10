import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { insightFileDownloadPath } from "./api";

export type DownloadLink = {
  url: string;
  contentType?: string;
  expiresAt?: string;
};

const LINK_HEADROOM_MS = 60_000;

function expiringSoon(link: DownloadLink): boolean {
  return (
    !link.expiresAt ||
    new Date(link.expiresAt).getTime() - Date.now() < LINK_HEADROOM_MS
  );
}

export function useSignedDownload(
  studentId: string,
  fileId: string,
  auto: boolean,
) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const fetchLink = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      let link = await api<DownloadLink>(
        insightFileDownloadPath(studentId, fileId),
      );
      if (current !== generation.current) return;
      if (expiringSoon(link)) {
        link = await api<DownloadLink>(
          insightFileDownloadPath(studentId, fileId),
        );
        if (current !== generation.current) return;
      }
      setUrl(link.url);
    } catch (failure: unknown) {
      if (current === generation.current) setError(errorMessage(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [studentId, fileId]);

  useEffect(() => {
    generation.current += 1;
    setUrl("");
    setError("");
    setLoading(false);
  }, [studentId, fileId]);

  useEffect(() => {
    if (auto) void fetchLink();
  }, [auto, fetchLink]);

  return { url, error, loading, fetchLink };
}
