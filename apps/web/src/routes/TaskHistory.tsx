import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import type { TaskDTO } from "../lib/types";
import { kindLabels } from "../lib/types";
import { Button } from "../components/ui/button";
import { StatusPanel } from "../components/StatusPanel";
export function TaskHistory() {
  const a = useAuth();
  const q = useRemote<TaskDTO[]>(a.studentId ? a.scoped("/api/tasks") : null);
  return (
    <>
      <div className="page-heading">
        <h1>学习记录</h1>
        <p>每次任务的题目、回答和进度都会保留。</p>
      </div>
      <section className="panel">
        {q.loading ? (
          <StatusPanel state="loading" title="正在加载学习记录" />
        ) : q.error ? (
          <StatusPanel state="error" title={q.error} onRetry={q.reload} />
        ) : q.data?.length ? (
          q.data.map((t) => (
            <div className="list-row" key={t.id}>
              <div>
                <h3>{kindLabels[t.kind]}</h3>
                <p>
                  {
                    {
                      active: "进行中",
                      paused: "已暂停",
                      completed: "已完成",
                      abandoned: "已结束",
                    }[t.status]
                  }
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to={`/study/${t.id}`}>
                  {t.status === "completed" ? "查看记录" : "继续学习"}
                </Link>
              </Button>
            </div>
          ))
        ) : (
          <StatusPanel title="还没有学习记录">
            从首页开始一个任务，进度会自动保存在这里。
          </StatusPanel>
        )}
      </section>
    </>
  );
}
