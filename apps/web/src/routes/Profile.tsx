import { StudentAccess } from "./StudentAccess";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useRemote } from "../lib/useRemote";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { StatusPanel } from "../components/StatusPanel";
import type { ProfileDTO } from "../../../../packages/contracts/src/learning-profile.js";
import {
  habitAnchorLabels,
  trainingBandLabels,
} from "../features/question-bank/labels";

const efficiencyNotes: Record<string, string> = {
  faster: "比近期平时的练习用时要短一些。",
  comparable: "用时接近近期平时的练习。",
  slower: "比近期平时的练习用时长一些。",
};

function LearningDimensions({ profiles }: { profiles: ProfileDTO[] }) {
  const determinate = profiles.reduce(
    (sum, p) => sum + p.recentDeterminateCount,
    0,
  );
  const correct = profiles.reduce(
    (sum, p) => sum + p.recentIndependentCorrect,
    0,
  );
  const habits = profiles.flatMap((p) => p.habits ?? []);
  const observed = profiles
    .map((p) => p.efficiency)
    .filter((e) => e.status === "observed" && e.direction);
  const band = profiles[0]?.trainingBand;
  return (
    <div className="dimension-grid">
      <div className="dimension-card">
        <h3>知识掌握</h3>
        {determinate > 0 ? (
          <p>
            近期 {determinate} 道可判断的练习里，独立答对 {correct} 道
            {band ? `，当前${trainingBandLabels[band]}` : ""}。
          </p>
        ) : (
          <p>还在积累可比较的练习，完成独立作答后这里会显示掌握情况。</p>
        )}
      </div>
      <div className="dimension-card">
        <h3>学习习惯</h3>
        {habits.length ? (
          <ul>
            {habits.map((habit) => (
              <li key={habit.anchorCode}>
                {habitAnchorLabels[habit.anchorCode] ?? habit.anchorCode}：自查{" "}
                {habit.independentCheckCount} 次，修正成功{" "}
                {habit.successfulCorrectionCount} 次。
              </li>
            ))}
          </ul>
        ) : (
          <p>还没有记录到自查动作；做错后按提示自查一次，这里会留下记录。</p>
        )}
      </div>
      <div className="dimension-card">
        <h3>做题效率</h3>
        {observed.length ? (
          <ul>
            {observed.map((efficiency) => (
              <li key={efficiency.baselineId ?? efficiency.direction}>
                {efficiencyNotes[efficiency.direction ?? ""] ??
                  "已完成一次稳定计时。"}
              </li>
            ))}
          </ul>
        ) : (
          <p>还在积累可比较的练习，计时样本不足时不显示快慢结论。</p>
        )}
      </div>
    </div>
  );
}

export function Profile() {
  const a = useAuth();
  const adaptiveEnabled = a.capabilities?.adaptivePractice === "enabled";
  const profiles = useRemote<ProfileDTO[]>(
    adaptiveEnabled && a.studentId ? a.scoped("/api/learning-profile") : null,
  );
  const [name, setName] = useState(""),
    [chapter, setChapter] = useState(""),
    [style, setStyle] = useState(""),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setName(a.profile?.displayName ?? "");
    setChapter(a.profile?.preferences.currentChapter ?? "");
    setStyle(a.profile?.preferences.explanation ?? "分步讲解");
  }, [a.profile]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api(`/api/students/${a.studentId}`, {
        method: "PATCH",
        ...jsonBody({
          displayName: name,
          preferences: {
            ...a.profile?.preferences,
            currentChapter: chapter,
            explanation: style,
          },
        }),
      });
      setStatus("资料已保存");
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!a.studentId)
    return (
      <StatusPanel title="尚无授权学生档案">
        请先创建学生账号，或由学生显式授权访问其学习记录。
      </StatusPanel>
    );
  return (
    <>
      <div className="page-heading">
        <h1>个人设置</h1>
        <p>告诉老师你的学习进度和偏好。</p>
      </div>
      <section className="panel selection-panel">
        <form className="form-stack" onSubmit={save}>
          {a.students.length > 1 && (
            <Field label="当前学生">
              <Select
                value={a.studentId}
                onChange={(e) => a.setStudentId(e.target.value)}
              >
                {a.students.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="称呼">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <Field
            label="最近学到哪里"
            hint="例如：分数的基本性质。老师会先与你确认范围。"
          >
            <Input
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
            />
          </Field>
          <Field label="偏好的讲解方式">
            <Select value={style} onChange={(e) => setStyle(e.target.value)}>
              <option>分步讲解</option>
              <option>先提问，再提示</option>
              <option>多举例子</option>
            </Select>
          </Field>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          {status && <p role="status">{status}</p>}
          <Button type="submit">保存资料</Button>
        </form>
      </section>
      {adaptiveEnabled && (
        <section className="panel section-spacer">
          <div className="section-head">
            <h2>分维度学情</h2>
            <span className="muted text-small">
              知识、习惯、效率分开记录，不合并成一个分数。
            </span>
          </div>
          {profiles.loading && !profiles.data ? (
            <StatusPanel state="loading" title="正在读取学情" />
          ) : profiles.error ? (
            <StatusPanel
              state="error"
              title={profiles.error}
              onRetry={profiles.reload}
            />
          ) : profiles.data?.length ? (
            <LearningDimensions profiles={profiles.data} />
          ) : (
            <StatusPanel title="还在积累可比较的练习">
              完成几次独立练习后，这里会按知识、习惯、效率分开显示。
            </StatusPanel>
          )}
        </section>
      )}
      <StudentAccess />
    </>
  );
}
