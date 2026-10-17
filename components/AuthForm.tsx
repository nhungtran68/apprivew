"use client";
import { useState, type FormEvent } from "react";
import styles from "./AuthForm.module.css";

export default function AuthForm({ configured, updatePassword = false, linkError = false }: { configured: boolean; updatePassword?: boolean; linkError?: boolean }) {
  const [mode, setMode] = useState(updatePassword ? "update" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(linkError ? "Liên kết không hợp lệ hoặc đã hết hạn. Hãy đăng nhập hoặc yêu cầu liên kết mới." : "");
  const [error, setError] = useState(linkError);
  const labels: Record<string, string> = { login: "Đăng nhập", register: "Đăng ký thành viên", recover: "Lấy lại mật khẩu", update: "Đặt mật khẩu mới" };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!configured || busy) return;
    setBusy(true); setMessage(""); setError(false);
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: mode, email, password, name }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Chưa hoàn tất. Hãy thử lại.");
      setPassword("");
      if (mode === "login" || mode === "update") window.location.assign("/");
      else setMessage(result.message || "Đã gửi yêu cầu.");
    } catch (reason) { setError(true); setMessage(reason instanceof Error ? reason.message : "Kết nối gián đoạn. Hãy thử lại."); }
    finally { setBusy(false); }
  }
  function changeMode(next: string) { setMode(next); setMessage(""); setPassword(""); setError(false); }
  return <main className={styles.page}>
    <a className={styles.brand} href="/"><span aria-hidden="true">▸</span> Lời Kể</a>
    <section className={styles.card}>
      <span className={styles.eyebrow}>KHÔNG GIAN CỦA BẠN</span>
      <h1>{labels[mode]}</h1>
      <p>Giữ những câu chuyện và giọng kể của riêng bạn.</p>
      {!configured ? <div className={styles.notice} role="status"><strong>Ứng dụng đang chờ kết nối tài khoản.</strong><p>Quản trị viên cần cấu hình Supabase trên Vercel. Bạn chưa thể đăng ký hoặc đăng nhập ở bản này.</p><a href="/">Xem giao diện ứng dụng</a></div> : <form onSubmit={submit}>
        {mode === "register" && <label>Tên của bạn<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label>}
        {mode !== "update" && <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required /></label>}
        {mode !== "recover" && <label>Mật khẩu<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === "login" ? 1 : 10} maxLength={128} required />{mode !== "login" && <small>Tối thiểu 10 ký tự.</small>}</label>}
        {message && <div className={error ? styles.error : styles.notice} role={error ? "alert" : "status"}>{message}</div>}
        <button className={styles.primary} disabled={busy}>{busy ? "Đang xử lý…" : labels[mode]}</button>
        {mode === "register" && <small className={styles.note}>Tài khoản mới cần quản trị viên cấp quyền và hạn mức trước khi dùng AI.</small>}
      </form>}
      {configured && <div className={styles.links}>{mode === "login" ? <><button type="button" onClick={() => changeMode("register")} disabled={busy}>Chưa có tài khoản? Đăng ký</button><button type="button" onClick={() => changeMode("recover")} disabled={busy}>Quên mật khẩu?</button></> : <button type="button" onClick={() => changeMode("login")} disabled={busy}>Quay lại đăng nhập</button>}</div>}
    </section>
    <p className={styles.footer}>Quay thật. Kể đúng ý. Bằng giọng của bạn.</p>
  </main>;
}
