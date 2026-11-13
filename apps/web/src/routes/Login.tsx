import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ArrowRight } from "lucide-react";
import { api, jsonBody, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
export function Login() {
  const auth = useAuth();
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", {
        method: "POST",
        ...jsonBody({ login, password }),
      });
      await auth.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="brand">
          <BookOpen size={32} />
          <span>XY Tutor</span>
        </div>
        <h1>
          不止做对一道题，
          <br />
          更要学明白。
        </h1>
        <p>
          从一个问题开始。提问、练习、回顾，每一步理解都留在这里。
        </p>
      </section>
      <main className="auth-form">
        <div>
          <h1>登录</h1>
          <p className="muted">学生与教师共用这个入口，登录后回到上次的进度。</p>
          <form className="form-stack" onSubmit={submit}>
            <Field label="账号">
              <Input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="密码">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {(error || auth.error) && (
              <p className="error-text" role="alert">
                {error || auth.error}
              </p>
            )}
            <Button disabled={busy} type="submit">
              {busy ? "正在登录…" : "登录"}
              <ArrowRight size={16} />
            </Button>
          </form>
          <p className="auth-footer">
            已有邀请？
            <Link to="/activate" className="text-link">
              激活账号
            </Link>{" "}
            ·{" "}
            <Link to="/reset" className="text-link">
              重设密码
            </Link>
          </p>
          <p className="muted text-small">
            首次使用请向管理员获取邀请；忘记密码可申请重置凭据。
          </p>
        </div>
      </main>
    </div>
  );
}
