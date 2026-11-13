import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { X, ExternalLink } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { StatusPanel } from "../../components/StatusPanel";
export function DocumentViewer({
  fileId,
  pageIndex = 0,
  bbox,
  onClose,
}: {
  fileId?: string;
  pageIndex?: number;
  bbox?: number[];
  onClose: () => void;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(1),
    [pdf, setPdf] = useState(true);
  useEffect(() => {
    if (!fileId) return;
    let alive = true;
    setUrl("");
    setError("");
    setZoom(1);
    void api<{ url: string; contentType?: string }>(
      `/api/files/${fileId}/download`,
    )
      .then((r) => {
        if (alive) {
          setUrl(r.url);
          setPdf(r.contentType?.includes("pdf") ?? true);
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [fileId]);
  return (
    <Dialog.Root
      open={!!fileId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="document-dialog">
          <div className="section-head">
            <Dialog.Title asChild>
              <h2>原始资料 · 第 {pageIndex + 1} 页</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="关闭原图">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted text-small">
            原始文件用于核对题干和作答；引用区域保留在对应题目记录中。
          </Dialog.Description>
          {error ? (
            <StatusPanel state="error" title={error} />
          ) : !url ? (
            <StatusPanel state="loading" title="正在加载原始资料" />
          ) : pdf ? (
            <iframe
              className="pdf-frame"
              title="原始 PDF 资料"
              src={`${url}#page=${pageIndex + 1}`}
            />
          ) : (
            <>
              <label className="zoom-control">
                缩放
                <input
                  type="range"
                  min="1"
                  max="3"
                  step=".1"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              <div className="image-scroll">
                <div
                  className="document-stage"
                  style={{ width: `${zoom * 100}%` }}
                >
                  <img src={url} alt="上传的原始题目资料" />
                  {bbox && (
                    <div
                      className="source-region"
                      style={{
                        left: `${bbox[0]! * 100}%`,
                        top: `${bbox[1]! * 100}%`,
                        width: `${(bbox[2]! - bbox[0]!) * 100}%`,
                        height: `${(bbox[3]! - bbox[1]!) * 100}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
          {url && (
            <a
              className="text-link document-open"
              href={`${url}#page=${pageIndex + 1}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              在新页面查看 / 下载
              <ExternalLink size={16} />
            </a>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
