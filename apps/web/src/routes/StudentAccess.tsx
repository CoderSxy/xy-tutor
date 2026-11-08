import { useState } from "react";
import { useAuth } from "../lib/auth";
import { useRemote } from "../lib/useRemote";
import { api, jsonBody, errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
export function StudentAccess() {
  const a = useAuth();
  const owner =
    a.students.find((s) => s.id === a.studentId)?.permission === "owner";
  const access = useRemote<
    { userId: string; login: string; permission: string }[]
  >(owner ? `/api/students/${a.studentId}/access` : null);
  const [login, setLogin] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const grant = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/students/${a.studentId}/access`, {
        method: "POST",
        ...jsonBody({ login }),
      });
      setLogin("");
      access.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (userId: string) => {
    try {
      await api(`/api/students/${a.studentId}/access`, {
        method: "DELETE",
        ...jsonBody({ userId }),
      });
      access.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!owner)
    return (
      <p className="muted">
        当前账号为受授权访问者。授权变更由学生账号所有者管理。
      </p>
    );
  return (
    <section className="panel section-spacer">
      <h2>学习资料访问授权</h2>
      <p className="muted">
        只有明确授权的账号能访问你的私有学习资料。管理员不会自动获得访问权。
      </p>
      <div className="form-grid">
        <Field label="授权账号">
          <Input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="填写已有账号"
          />
        </Field>
        <div className="form-actions">
          <Button disabled={!login.trim() || busy} onClick={() => void grant()}>
            授予访问权
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="access-list">
        {access.data?.map((row) => (
          <div className="list-row" key={row.userId}>
            <span>
              {row.login} · {row.permission === "owner" ? "所有者" : "已授权"}
            </span>
            {row.permission !== "owner" && (
              <Button variant="danger" onClick={() => void revoke(row.userId)}>
                撤销访问
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
