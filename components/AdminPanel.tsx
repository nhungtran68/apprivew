"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./AdminPanel.module.css";

type Member = {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  enabled: boolean;
  credit_balance?: number;
  credit_reserved?: number;
  credit_available?: number;
};

const formatNumber = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

export default function AdminPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const pendingGrants = useRef<Record<string, { amount: number; key: string }>>({});

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/members", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chưa tải được thành viên.");
      setMembers(Array.isArray(data.members) ? data.members : []);
      return true;
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "Kết nối gián đoạn.");
      return false;
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(member: Member, values: Record<string, unknown>, successMessage: string, idempotencyKey?: string) {
    setBusy(member.user_id);
    setMessage("");
    try {
      const response = await fetch("/api/admin/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        body: JSON.stringify({ userId: member.user_id, ...values }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chưa lưu được thay đổi.");
      if (typeof values.creditDelta === "number") {
        delete pendingGrants.current[member.user_id];
        setCreditDrafts(current => ({ ...current, [member.user_id]: "" }));
      }
      if (!await load()) throw new Error("Đã lưu thay đổi, nhưng chưa tải lại được số dư. Hãy làm mới trang để kiểm tra.");
      setIsError(false);
      setMessage(successMessage);
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "Kết nối gián đoạn.");
    } finally { setBusy(""); }
  }

  function grant(member: Member) {
    const amount = Number(creditDrafts[member.user_id]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) {
      setIsError(true);
      setMessage("Nhập số credit muốn cấp từ 1 đến 1.000.000.");
      return;
    }
    const previous = pendingGrants.current[member.user_id];
    const key = previous?.amount === amount ? previous.key : crypto.randomUUID();
    pendingGrants.current[member.user_id] = { amount, key };
    void save(member, { creditDelta: amount }, `Đã cấp ${formatNumber(amount)} credit cho ${member.display_name || member.email}.`, key);
  }

  return <main className={styles.page}>
    <Link href="/" className={styles.back}>← Về tổng quan</Link>
    <header className={styles.heading}><span>QUẢN TRỊ THÀNH VIÊN</span><h1>Credit của thành viên</h1><p>Cấp credit để thành viên sử dụng các công cụ AI. Khi credit khả dụng về 0, hệ thống dừng tác vụ AI mới.</p></header>
    {message && <p className={`${styles.message} ${isError ? styles.error : ""}`} role={isError ? "alert" : "status"}>{message}</p>}
    <div className={styles.list}>
      {members.map(member => {
        const available = Number.isSafeInteger(member.credit_available) ? member.credit_available! : null;
        const balance = Number.isSafeInteger(member.credit_balance) ? member.credit_balance! : null;
        const reserved = Number.isSafeInteger(member.credit_reserved) ? member.credit_reserved! : null;
        const draft = creditDrafts[member.user_id] ?? "";
        return <section key={member.user_id} className={styles.card} aria-label={`Tài khoản ${member.email}`}>
          <div className={styles.member}><div><strong>{member.display_name || member.email}</strong><span>{member.email}</span></div><span className={`${styles.status} ${member.enabled ? styles.active : styles.locked}`}>{member.role === "admin" ? "Quản trị viên" : member.enabled ? "Đang hoạt động" : "Đã khóa"}</span></div>
          <div className={styles.wallet}><div><small>Credit khả dụng</small><strong>{available === null ? "—" : formatNumber(available)}</strong></div><div><small>Số dư</small><strong>{balance === null ? "—" : formatNumber(balance)}</strong></div><div><small>Đang giữ</small><strong>{reserved === null ? "—" : formatNumber(reserved)}</strong></div></div>
          <div className={styles.actions}><label>Cấp thêm credit<input type="number" inputMode="numeric" min={1} max={1_000_000} step={1} placeholder="Ví dụ: 500" value={draft} onChange={event => setCreditDrafts(current => ({ ...current, [member.user_id]: event.target.value }))} disabled={Boolean(busy)} /></label><button type="button" className={styles.grant} disabled={Boolean(busy) || !draft} onClick={() => grant(member)}>{busy === member.user_id ? "Đang lưu…" : "Cấp credit"}</button>{member.role !== "admin" && <button type="button" className={styles.toggle} disabled={Boolean(busy)} onClick={() => void save(member, { enabled: !member.enabled }, member.enabled ? "Đã khóa tài khoản." : "Đã mở khóa tài khoản.")}>{member.enabled ? "Khóa tài khoản" : "Mở khóa"}</button>}</div>
        </section>;
      })}
    </div>
    {loading && !members.length ? <p className={styles.empty} role="status">Đang tải danh sách thành viên…</p> : null}
    {!loading && !members.length && !isError ? <p className={styles.empty}>Chưa có thành viên nào.</p> : null}
  </main>;
}
