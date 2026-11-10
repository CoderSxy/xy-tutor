import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, jsonBody } from "../../lib/api";
import {
  IMAGE_UPLOAD_CONCURRENCY,
  MAX_MESSAGE_IMAGES,
} from "../../../../../packages/contracts/src/conversation-images.js";
import { CHAT_IMAGE_TYPES, prepareChatImage } from "../uploads/imagePrepare";

export type ImageAttachmentStatus =
  | "selected"
  | "processing"
  | "uploading"
  | "ready"
  | "failed";

export type ImageDraftItem = {
  id: string;
  name: string;
  file: File;
  previewUrl: string;
  status: ImageAttachmentStatus;
  progress: number;
  rotation: number;
  fileId?: string;
  width?: number;
  height?: number;
  error?: string;
};

export type ImageAttachments = {
  items: ImageDraftItem[];
  addFiles: (files: Iterable<File>) => void;
  rotate: (id: string) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
  reset: () => void;
  readyFileIds: string[];
  canSend: boolean;
  blockedReason: string;
  uploading: boolean;
  error: string;
  clearError: () => void;
};

type UploadGrant = {
  fileId: string;
  url: string;
  headers: Record<string, string>;
};

type Options = {
  studentId?: string;
  conversationId?: string;
  identity?: string;
  ensureConversation?: () => Promise<string>;
  enabled?: boolean;
  maxImages?: number;
};

function putFile(
  grant: UploadGrant,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (value: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Aborted", "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", grant.url);
    xhr.timeout = 120_000;
    for (const [name, value] of Object.entries(grant.headers ?? {}))
      xhr.setRequestHeader(name, value);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const settle = (action: () => void) => {
      signal.removeEventListener("abort", abort);
      action();
    };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      settle(() =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(Error("上传未成功，请重试")),
      );
    xhr.onerror = () =>
      settle(() => reject(Error("文件上传连接失败，请检查网络")));
    xhr.ontimeout = () => settle(() => reject(Error("文件上传超时，请重试")));
    xhr.onabort = () =>
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    xhr.send(blob);
  });
}

export function useImageAttachments(options: Options): ImageAttachments {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const max = options.maxImages ?? MAX_MESSAGE_IMAGES;

  const [items, setItems] = useState<ImageDraftItem[]>([]);
  const [error, setError] = useState("");
  const itemsRef = useRef<ImageDraftItem[]>([]);
  const commit = useCallback(
    (next: ImageDraftItem[] | ((prev: ImageDraftItem[]) => ImageDraftItem[])) => {
      setItems((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        itemsRef.current = value;
        return value;
      });
    },
    [],
  );
  const patch = useCallback(
    (id: string, changes: Partial<ImageDraftItem>) => {
      commit((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...changes } : item)),
      );
    },
    [commit],
  );

  const generationRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const urlsRef = useRef(new Set<string>());
  const conversationRef = useRef(options.conversationId);
  const identityRef = useRef(options.identity);
  const activeRef = useRef(0);
  const waitersRef = useRef<Array<() => void>>([]);

  const trackPreview = useCallback((url: string) => {
    urlsRef.current.add(url);
    return url;
  }, []);
  const releasePreview = useCallback((url: string) => {
    if (!urlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }, []);

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (activeRef.current < IMAGE_UPLOAD_CONCURRENCY) {
        activeRef.current += 1;
        resolve();
        return;
      }
      waitersRef.current.push(() => {
        activeRef.current += 1;
        resolve();
      });
    });
  const release = () => {
    activeRef.current = Math.max(0, activeRef.current - 1);
    waitersRef.current.shift()?.();
  };

  const resolveConversation = useCallback(async () => {
    if (conversationRef.current) return conversationRef.current;
    const ensure = optionsRef.current.ensureConversation;
    if (!ensure) throw Error("当前会话还不能上传图片");
    const conversationId = await ensure();
    conversationRef.current = conversationId;
    return conversationId;
  }, []);

  const run = useCallback(
    async (item: ImageDraftItem) => {
      const generation = generationRef.current;
      const controller = new AbortController();
      controllersRef.current.get(item.id)?.abort();
      controllersRef.current.set(item.id, controller);
      const live = () =>
        generationRef.current === generation && !controller.signal.aborted;
      patch(item.id, {
        status: "processing",
        progress: 0,
        error: undefined,
      });
      try {
        const prepared = await prepareChatImage(
          item.file,
          item.rotation,
          controller.signal,
        );
        if (!live()) return;
        const previewUrl = trackPreview(
          URL.createObjectURL(prepared.blob),
        );
        commit((prev) =>
          prev.map((current) => {
            if (current.id !== item.id) return current;
            releasePreview(current.previewUrl);
            return { ...current, previewUrl };
          }),
        );
        const conversationId = await resolveConversation();
        if (!live()) return;
        const studentId = optionsRef.current.studentId;
        if (!studentId) throw Error("当前账号不能上传图片");
        const grant = await api<UploadGrant>("/api/uploads", {
          method: "POST",
          signal: controller.signal,
          ...jsonBody({
            name: item.name,
            contentType: prepared.mimeType,
            size: prepared.blob.size,
            purpose: "conversation_image",
            studentId,
            conversationId,
          }),
        });
        if (!live()) return;
        patch(item.id, { status: "uploading", progress: 0 });
        await acquire();
        try {
          if (!live()) return;
          await putFile(grant, prepared.blob, controller.signal, (progress) => {
            if (live()) patch(item.id, { progress });
          });
          if (!live()) return;
          await api(`/api/uploads/${grant.fileId}/complete`, {
            method: "POST",
            signal: controller.signal,
          });
        } finally {
          release();
        }
        if (!live()) return;
        patch(item.id, {
          status: "ready",
          progress: 100,
          fileId: grant.fileId,
          width: prepared.width,
          height: prepared.height,
        });
      } catch (cause) {
        if (controller.signal.aborted || generationRef.current !== generation)
          return;
        const message = errorMessage(cause);
        patch(item.id, { status: "failed", error: message });
        setError(message);
      }
    },
    [commit, patch, resolveConversation, trackPreview, releasePreview],
  );

  const cancelAll = useCallback(() => {
    generationRef.current += 1;
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
    activeRef.current = 0;
    waitersRef.current = [];
  }, []);

  useEffect(() => {
    if (
      conversationRef.current === options.conversationId &&
      identityRef.current === options.identity
    )
      return;
    conversationRef.current = options.conversationId;
    identityRef.current = options.identity;
    cancelAll();
    setError("");
    commit([]);
  }, [options.conversationId, options.identity, cancelAll, commit]);

  useEffect(() => () => cancelAll(), [cancelAll]);

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const list = [...files];
      if (!list.length || optionsRef.current.enabled === false) return;
      setError("");
      const room = Math.max(0, max - itemsRef.current.length);
      if (list.length > room) setError(`每条消息最多 ${max} 张图片`);
      const added = list.slice(0, room).map<ImageDraftItem>((file) => {
        const item: ImageDraftItem = {
          id: crypto.randomUUID(),
          name: file.name,
          file,
          previewUrl: trackPreview(URL.createObjectURL(file)),
          status: "selected",
          progress: 0,
          rotation: 0,
        };
        if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
          item.status = "failed";
          item.error = "请选择 JPG、PNG 或 WebP 图片";
          setError(item.error);
        }
        return item;
      });
      commit((prev) => [...prev, ...added]);
      for (const item of added)
        if (item.status !== "failed") void run(item);
    },
    [commit, max, run, trackPreview],
  );

  const rotate = useCallback(
    (id: string) => {
      const current = itemsRef.current.find((item) => item.id === id);
      if (!current) return;
      setError("");
      const next: ImageDraftItem = {
        ...current,
        rotation: (current.rotation + 90) % 360,
        status: "selected",
        progress: 0,
        fileId: undefined,
        width: undefined,
        height: undefined,
        error: undefined,
      };
      patch(id, next);
      void run(next);
    },
    [patch, run],
  );

  const remove = useCallback(
    (id: string) => {
      controllersRef.current.get(id)?.abort();
      controllersRef.current.delete(id);
      commit((prev) => {
        const target = prev.find((item) => item.id === id);
        if (target) releasePreview(target.previewUrl);
        return prev.filter((item) => item.id !== id);
      });
    },
    [commit, releasePreview],
  );

  const retry = useCallback(
    (id: string) => {
      const current = itemsRef.current.find((item) => item.id === id);
      if (!current || current.status !== "failed") return;
      setError("");
      void run(current);
    },
    [run],
  );

  const reset = useCallback(() => {
    cancelAll();
    setError("");
    commit([]);
  }, [cancelAll, commit]);

  const readyFileIds = items
    .filter((item) => item.status === "ready" && item.fileId)
    .map((item) => item.fileId!);
  const uploading = items.some(
    (item) =>
      item.status === "selected" ||
      item.status === "processing" ||
      item.status === "uploading",
  );
  const canSend =
    items.length === 0 ||
    (!uploading &&
      items.every((item) => item.status === "ready") &&
      readyFileIds.length > 0);
  const blockedReason =
    items.length === 0 || canSend
      ? ""
      : items.some((item) => item.status === "failed")
        ? "有图片上传失败，请重试或移除"
        : "图片还在处理中，请稍候";

  return {
    items,
    addFiles,
    rotate,
    remove,
    retry,
    reset,
    readyFileIds,
    canSend,
    blockedReason,
    uploading,
    error,
    clearError: () => setError(""),
  };
}
