import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { api, jsonBody, errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { StatusPanel } from "../components/StatusPanel";
export function Profile() {
  const a = useAuth();
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
    </>
  );
}
