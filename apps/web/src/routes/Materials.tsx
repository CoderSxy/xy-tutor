import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import { api, jsonBody, errorMessage } from "../lib/api";
import { UploadInput } from "../features/uploads/UploadInput";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
import { Select, Field } from "../components/ui/field";
type Material = {
  id: string;
  name: string;
  type: string;
  status: string;
};
export function Materials() {
  const a = useAuth(),
    navigate = useNavigate();
  const list = useRemote<Material[]>(
    a.studentId ? a.scoped("/api/materials") : null,
  );
  const [type, setType] = useState("mistake"),
    [error, setError] = useState("");
  useEffect(() => {
    if (list.data?.some((m) => m.status === "processing")) {
      const timer = setTimeout(list.reload, 2500);
      return () => clearTimeout(timer);
    }
  }, [list.data, list.reload]);
  const retry = async (id: string) => {
    try {
      await api(a.scoped(`/api/materials/${id}/retry`), { method: "POST" });
      list.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <div className="page-heading">
        <h1>学习资料</h1>
        <p>保存自己的错题、作业和试卷，确认识别结果后再选择题目辅导。</p>
      </div>
      <section className="panel upload-panel">
        {a.capabilities && !a.capabilities.uploadsConfigured ? (
          <UploadInput purpose="student_material" onUploaded={async () => {}} />
        ) : (
          <>
            <Field label="资料类型">
              <Select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="mistake">单道错题</option>
                <option value="homework">作业</option>
                <option value="exam">考试试卷</option>
                <option value="other">其他学习资料</option>
              </Select>
            </Field>
            <UploadInput
              purpose="student_material"
              onUploaded={async (fileId) => {
                const result = await api<{ id: string }>(
                  a.scoped("/api/materials"),
                  {
                    method: "POST",
                    ...jsonBody({ fileId, type }),
                  },
                );
                navigate(`/materials/${result.id}`);
              }}
            />
          </>
        )}
      </section>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <section className="panel section-spacer">
        <h2>已上传资料</h2>
        {list.loading && !list.data ? (
          <StatusPanel state="loading" title="正在加载资料" />
        ) : list.error ? (
          <StatusPanel state="error" title={list.error} onRetry={list.reload} />
        ) : list.data?.length ? (
          list.data.map((m) => (
            <div className="list-row" key={m.id}>
              <FileText size={32} />
              <div className="grow">
                <h3>{m.name}</h3>
                <p>
                  {
                    {
                      mistake: "错题",
                      homework: "作业",
                      exam: "试卷",
                      other: "其他",
                    }[m.type as "mistake"]
                  }{" "}
                  ·{" "}
                  {
                    {
                      processing: "处理中",
                      review: "待确认",
                      confirmed: "已确认",
                      failed: "处理失败",
                    }[m.status as "review"]
                  }
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to={`/materials/${m.id}`}>查看资料</Link>
              </Button>
              {m.status === "failed" && (
                <Button variant="ghost" onClick={() => void retry(m.id)}>
                  重试处理
                </Button>
              )}
            </div>
          ))
        ) : (
          <StatusPanel title="还没有上传资料">
            上传试卷不会自动把所有题目加入错题本。
          </StatusPanel>
        )}
      </section>
    </>
  );
}
