import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, jsonBody, errorMessage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
export function Activate() {
  const reset = useLocation().pathname === "/reset";
  const [token, setToken] = useState(
      () =>
        new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
    ),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(reset ? "/api/auth/reset" : "/api/auth/activate", {
        method: "POST",
        ...jsonBody({ token, password }),
      });
      window.history.replaceState(null, "", window.location.pathname);
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="standalone-page">
      <section className="panel">
        <h1>{reset ? "重设密码" : "激活学习账号"}</h1>
        {done ? (
          <>
            <p>设置成功，可以登录了。</p>
            <Button asChild>
              <Link to="/">返回登录</Link>
            </Button>
          </>
        ) : (
          <form className="form-stack" onSubmit={submit}>
            <Field label={reset ? "重置凭据" : "邀请凭据"}>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <Field label="设置密码" hint="至少10个字符，最多128个字符">
              <Input
                type="password"
                minLength={10}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <Button disabled={busy}>{busy ? "正在设置…" : "确认设置"}</Button>
            <Link to="/" className="text-link">
              返回登录
            </Link>
          </form>
        )}
      </section>
    </main>
  );
}
