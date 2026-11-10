import { useState, type FormEvent } from "react";
import { useAuth } from "../../lib/auth";
import { useRemote } from "../../lib/useRemote";
import { api, jsonBody, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Field, Input, Select } from "../../components/ui/field";
import { StatusPanel } from "../../components/StatusPanel";
export function Accounts() {
  const a = useAuth();
  const accounts = useRemote<{ id: string; login: string; role: string }[]>(
    a.session?.actor.role === "admin" ? "/api/admin/accounts" : null,
  );
  const [login, setLogin] = useState(""),
    [role, setRole] = useState("student"),
    [link, setLink] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  if (a.session?.actor.role !== "admin")
    return <StatusPanel state="error" title="需要管理员权限" />;
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ activationToken: string }>(
        "/api/admin/invitations",
        { method: "POST", ...jsonBody({ login, role }) },
      );
      setLink(
        `${window.location.origin}/activate#token=${encodeURIComponent(result.activationToken)}`,
      );
      setCopied(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async (userId: string) => {
    try {
      const result = await api<{ resetToken: string }>(
        "/api/admin/password-resets",
        { method: "POST", ...jsonBody({ userId }) },
      );
      setLink(
        `${window.location.origin}/reset#token=${encodeURIComponent(result.resetToken)}`,
      );
      setCopied(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <div className="page-heading">
        <h1>账号管理</h1>
        <p>邀请学习账号或管理员。管理员权限不自动授予学生私有资料访问权。</p>
      </div>
      <section className="panel">
        <h2>创建邀请</h2>
        <form className="form-grid" onSubmit={invite}>
          <Field label="新账号">
            <Input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              minLength={2}
              maxLength={80}
              required
            />
          </Field>
          <Field label="账号角色">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="student">学生</option>
              <option value="admin">管理员</option>
            </Select>
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "正在创建…" : "生成邀请链接"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {link && (
          <div className="section-spacer">
            <Field
              label="一次性邀请 / 重置链接"
              hint="仅提供给对应账号使用者。凭据有有效期，页面关闭后不会再次显示。"
            >
              <Input value={link} readOnly onFocus={(e) => e.target.select()} />
            </Field>
            <div className="form-actions">
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  } catch {
                    setError("无法自动复制，请选中链接手动复制");
                  }
                }}
              >
                {copied ? "已复制" : "复制链接"}
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="panel section-spacer">
        <h2>已有账号</h2>
        {accounts.loading ? (
          <StatusPanel state="loading" title="正在读取账号" />
        ) : accounts.error ? (
          <StatusPanel state="error" title={accounts.error} />
        ) : (
          accounts.data?.map((u) => (
            <div className="list-row" key={u.id}>
              <div>
                <h3>{u.login}</h3>
                <p>{u.role === "admin" ? "管理员" : "学生"}</p>
              </div>
              <Button variant="outline" onClick={() => void reset(u.id)}>
                签发重置凭据
              </Button>
            </div>
          ))
        )}
      </section>
      <section className="panel section-spacer">
        <h2>服务配置</h2>
        <p className="muted">
          模型、文件存储和 OCR 使用服务器环境配置，不在浏览器中填写密钥。
        </p>
        <div className="service-status">
          <span>
            辅导模型：
            {a.capabilities?.llmConfigured
              ? "已填写配置，需真实验证"
              : "尚未配置"}
          </span>
          <span>
            OSS：
            {a.capabilities?.uploadsConfigured
              ? "已填写配置，需真实验证"
              : "尚未配置"}
          </span>
          <span>
            OCR：
            {a.capabilities?.ocrConfigured
              ? "已填写配置，需真实验证"
              : "尚未配置"}
          </span>
        </div>
        <p className="text-small muted">
          部署者可参考项目
          docs/runbooks/external-services.md。真实网关地址已预留为
          api.nerosun.cn，模型名称与 Key 仍需填写。
        </p>
      </section>
    </>
  );
}
