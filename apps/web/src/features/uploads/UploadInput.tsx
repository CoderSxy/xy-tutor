import { fileTooLarge } from "../../../../../packages/contracts/src/file-limits.js";
import { useState, useRef, useEffect } from "react";
import { Upload, RotateCw, FileText, Camera } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { StatusPanel } from "../../components/StatusPanel";
import { prepareMaterialImage } from "./imagePrepare";

const KNOWLEDGE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
];

// 浏览器对 .md 常给出空 MIME；按扩展名归一化，服务端才能识别文本资料。
function knowledgeFile(file: File): File | null {
  const name = file.name.toLowerCase();
  const type =
    file.type === "application/pdf" || name.endsWith(".pdf")
      ? "application/pdf"
      : ["image/png", "image/jpeg", "image/webp"].includes(file.type)
        ? file.type
        : file.type === "text/markdown" ||
            name.endsWith(".md") ||
            name.endsWith(".markdown")
          ? "text/markdown"
          : file.type === "text/plain" || name.endsWith(".txt")
            ? "text/plain"
            : null;
  if (!type) return null;
  return file.type === type ? file : new File([file], file.name, { type });
}

export function UploadInput({
  purpose,
  onUploaded,
}: {
  purpose: "textbook" | "student_material" | "knowledge_source";
  onUploaded: (id: string) => Promise<void>;
}) {
  const a = useAuth();
  const ref = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>(),
    [preview, setPreview] = useState(""),
    [rotation, setRotation] = useState(0),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const choose = (raw?: File) => {
    if (!raw) return;
    setError("");
    const f = purpose === "knowledge_source" ? knowledgeFile(raw) : raw;
    const allowed =
      purpose === "knowledge_source"
        ? KNOWLEDGE_TYPES
        : ["application/pdf", "image/png", "image/jpeg", "image/webp"];
    if (!f || !allowed.includes(f.type)) {
      setError(
        purpose === "knowledge_source"
          ? "请选择 TXT、Markdown、PDF、JPG、PNG 或 WebP 文件"
          : "请选择 PDF、JPG、PNG 或 WebP 文件",
      );
      return;
    }
    if (purpose === "textbook" && f.type !== "application/pdf") {
      setError("电子教材请上传 PDF 文件");
      return;
    }
    if (fileTooLarge(purpose, f.type, f.size)) {
      setError(
        purpose === "textbook"
          ? "教材PDF必须小于50MB"
          : purpose === "knowledge_source"
            ? "知识点资料需小于10MB，PDF小于30MB"
            : "文件超过限制：照片10MB，PDF30MB",
      );
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setRotation(0);
    setPreview(f.type.startsWith("image/") ? URL.createObjectURL(f) : "");
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const text = file.type === "text/plain" || file.type === "text/markdown";
      const blob = text ? file : await prepareMaterialImage(file, rotation);
      const type =
        file.type === "application/pdf"
          ? "application/pdf"
          : text
            ? file.type
            : "image/jpeg";
      const grant = await api<{
        fileId: string;
        url: string;
        headers: Record<string, string>;
      }>(a.scoped("/api/uploads"), {
        method: "POST",
        ...jsonBody({
          name: file.name,
          contentType: type,
          size: blob.size,
          purpose,
          ...(purpose === "student_material" ? { studentId: a.studentId } : {}),
        }),
      });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", grant.url);
        for (const [key, value] of Object.entries(grant.headers))
          xhr.setRequestHeader(key, value);
        xhr.timeout = 120000;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(Error("上传未成功，请重试"));
        xhr.onerror = () => reject(Error("文件上传连接失败，请检查网络"));
        xhr.ontimeout = () => reject(Error("文件上传超时，请重试"));
        xhr.send(blob);
      });
      await api(a.scoped(`/api/uploads/${grant.fileId}/complete`), {
        method: "POST",
      });
      await onUploaded(grant.fileId);
      setFile(undefined);
      if (preview) URL.revokeObjectURL(preview);
      setPreview("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (a.capabilities && !a.capabilities.uploadsConfigured)
    return (
      <StatusPanel title="文件存储尚未启用">
        请联系管理员完成文件存储配置后再上传。已保存的学习记录仍可查看。
      </StatusPanel>
    );
  return (
    <div
      className="upload-control"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy) choose(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={ref}
        type="file"
        className="sr-only"
        accept={
          purpose === "textbook"
            ? "application/pdf"
            : purpose === "knowledge_source"
              ? ".txt,.md,.markdown,.pdf,image/jpeg,image/png,image/webp"
              : ".pdf,image/jpeg,image/png,image/webp"
        }
        onChange={(e) => choose(e.target.files?.[0])}
        aria-label="选择上传文件"
      />
      <input
        ref={camera}
        type="file"
        className="sr-only"
        accept="image/*"
        capture="environment"
        onChange={(e) => choose(e.target.files?.[0])}
        aria-label="拍照上传"
      />
      {file ? (
        <>
          <div className="file-preview">
            {preview ? (
              <img
                src={preview}
                alt="待上传照片预览"
                style={{ transform: `rotate(${rotation}deg)` }}
              />
            ) : (
              <FileText size={40} />
            )}
            <strong>{file.name}</strong>
            <span className="muted text-small">
              {(file.size / 1024 ** 2).toFixed(1)} MB
            </span>
          </div>
          <div className="form-actions">
            {preview && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRotation((v) => (v + 90) % 360)}
              >
                <RotateCw size={17} />
                旋转
              </Button>
            )}
            <Button disabled={busy} onClick={() => void upload()}>
              <Upload size={17} />
              {busy ? `上传中 ${progress}%` : "确认上传"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setFile(undefined);
                setPreview("");
              }}
            >
              重新选择
            </Button>
          </div>
        </>
      ) : (
        <>
          <Upload size={30} />
          <h3>
            {purpose === "textbook"
              ? "上传电子教材 PDF"
              : purpose === "knowledge_source"
                ? "上传知识点文本或资料"
                : "上传题目、作业或考试资料"}
          </h3>
          <p className="muted">
            {purpose === "knowledge_source"
              ? "支持 TXT、Markdown、PDF 与照片，照片会适度压缩后识别。"
              : "拖放文件到这里，或选择文件。照片会适度压缩，便于识别。"}
          </p>
          <div className="form-actions">
            <Button variant="outline" onClick={() => ref.current?.click()}>
              选择文件
            </Button>
            {purpose === "student_material" && (
              <Button variant="ghost" onClick={() => camera.current?.click()}>
                <Camera size={18} />
                拍照
              </Button>
            )}
          </div>
          <small className="muted">
            {purpose === "textbook"
              ? "教材PDF<50MB、500页；扫描页会按页使用OCR"
              : purpose === "knowledge_source"
                ? "文本≤10MB，照片≤10MB，PDF<30MB"
                : "照片≤10MB，PDF≤30MB、100页"}
          </small>
        </>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
