"use client";
import { useEffect, useState } from "react";
type Member = { user_id: string; email: string; display_name: string; role: string; enabled: boolean; ai_units_limit: number; ai_units_used: number; voice_clone_limit: number; voice_clone_used: number };
export default function AdminPanel() {
  const [members, setMembers] = useState<Member[]>([]), [busy, setBusy] = useState(""), [message, setMessage] = useState("");
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [cloneDrafts, setCloneDrafts] = useState<Record<string, number>>({});
  async function load() {
    try {
      const response = await fetch("/api/admin/members", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chưa tải được thành viên.");
      setMembers(data.members || []);
      setDrafts(Object.fromEntries((data.members || []).map((member: Member) => [member.user_id, member.ai_units_limit])));
      setCloneDrafts(Object.fromEntries((data.members || []).map((member: Member) => [member.user_id, member.voice_clone_limit])));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Kết nối gián đoạn."); }
  }
  useEffect(() => { void load(); }, []);
  async function save(member: Member, values: Record<string, unknown>) {
    setBusy(member.user_id); setMessage("");
    try {
      const response = await fetch("/api/admin/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: member.user_id, ...values }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chưa lưu được thay đổi.");
      await load(); setMessage("Đã cập nhật thành viên.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Kết nối gián đoạn."); }
    finally { setBusy(""); }
  }
  return <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 20px", fontSize: 16 }}>
    <a href="/">← Về tổng quan</a><h1 style={{ margin: "24px 0 12px", fontSize: 30 }}>Thành viên</h1>
    <p>Cấp quyền và hạn mức dùng AI cho từng tài khoản.</p>
    <p style={{ fontSize: 14, color: "#65705f", margin: "12px 0 24px" }}>Mỗi lần phân tích hoặc viết lời tính 1 lượt. Giọng đọc tính theo độ dài lời, gồm cả lần tạo lại; nhân bản giọng tính 10 lượt. Lượt đã gửi tới dịch vụ vẫn được tính nếu dịch vụ trả lỗi.</p>
    {message && <p role="status" style={{ padding: 14, background: "#fff1e9", borderRadius: 10, marginBottom: 20 }}>{message}</p>}
    <div style={{ display: "grid", gap: 14 }}>{members.map((member) => <section key={member.user_id} style={{ border: "1px solid #dfe5da", background: "white", padding: 20, borderRadius: 14, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 210px" }}><strong>{member.display_name || member.email}</strong><div style={{ color: "#697561", fontSize: 14 }}>{member.email}</div><small>{member.role === "admin" ? "Quản trị viên" : member.enabled ? "Đang hoạt động" : "Chờ duyệt / tạm khóa"} · Đã dùng {member.ai_units_used} lượt · Clone giọng: {member.role === "admin" ? "không giới hạn" : `${member.voice_clone_used}/${member.voice_clone_limit}`}</small></div>
      <label style={{ display: "grid", gap: 5 }}>Hạn mức<input aria-label={`Hạn mức ${member.email}`} style={{ width: 110, minHeight: 44 }} type="number" min={0} max={100000} value={drafts[member.user_id] ?? member.ai_units_limit} onChange={(event) => setDrafts({ ...drafts, [member.user_id]: Number(event.target.value) })} /></label>
      <label style={{ display: "grid", gap: 5 }}>Lượt clone<input aria-label={`Lượt clone ${member.email}`} style={{ width: 110, minHeight: 44 }} type="number" min={0} max={100} disabled={member.role === "admin"} value={cloneDrafts[member.user_id] ?? member.voice_clone_limit} onChange={(event) => setCloneDrafts({ ...cloneDrafts, [member.user_id]: Number(event.target.value) })} /></label>
      <button className="button primary" disabled={Boolean(busy)} onClick={() => save(member, { aiUnitsLimit: drafts[member.user_id], ...(member.role !== "admin" ? { voiceCloneLimit: cloneDrafts[member.user_id] } : {}) })}>Lưu</button>
      {member.role !== "admin" && <button className="button secondary" disabled={Boolean(busy)} onClick={() => save(member, { enabled: !member.enabled })}>{member.enabled ? "Tạm khóa" : "Cấp quyền"}</button>}
    </section>)}</div>
    {!members.length && !message && <p role="status">Đang tải danh sách…</p>}
  </main>;
}
