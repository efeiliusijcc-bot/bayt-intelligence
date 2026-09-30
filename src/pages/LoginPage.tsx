import { useState, type FormEvent } from "react";
import { Button, Input } from "@fluentui/react-components";
import { LockClosed24Regular } from "@fluentui/react-icons";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

export function LoginPage() {
  const { session, login } = useAuth();
  const location = useLocation();
  const requested = (location.state as { from?: unknown } | null)?.from;
  const destination = typeof requested === "string" && requested.startsWith("/") && !requested.startsWith("//") &&
    !requested.startsWith("/login") ? requested : "/dashboard";
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (session) return <Navigate to={destination} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { await login(user.trim(), password); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败，请重试"); }
    finally { setBusy(false); }
  };

  return <main className="login-shell">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-mark"><LockClosed24Regular aria-hidden="true" /></div>
      <span className="login-eyebrow">Bayt Intelligence</span>
      <h1 id="login-title">登录人才数据管理平台</h1>
      <p>登录一次，在此浏览器中保持 7 天。简历和采集操作仅对已登录用户开放。</p>
      <form onSubmit={submit}>
        <label><span>账号</span><Input value={user} onChange={(_, data) => setUser(data.value)} autoComplete="username" required autoFocus /></label>
        <label><span>密码</span><Input type="password" value={password} onChange={(_, data) => setPassword(data.value)} autoComplete="current-password" required /></label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <Button type="submit" appearance="primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</Button>
      </form>
    </section>
  </main>;
}
