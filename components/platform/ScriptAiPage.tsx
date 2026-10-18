"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import styles from "./ScriptAiPage.module.css";

type ScriptFormat = "review" | "story" | "tips" | "sales";
type ScriptTemplate = {
  id: string;
  title: string;
  format: ScriptFormat;
  scope: "shared" | "personal";
  description?: string;
  /** The API includes this only for the template owner. */
  prompt?: string;
};
type TemplateEditor = { id?: string; format: ScriptFormat; title: string; description: string; prompt: string };

const formats: { id: ScriptFormat; label: string; note: string; mark: string }[] = [
  { id: "review", label: "Review sản phẩm", note: "Chia sẻ trải nghiệm chân thật", mark: "01" },
  { id: "story", label: "Kể chuyện", note: "Tạo sự gần gũi, cảm xúc", mark: "02" },
  { id: "tips", label: "Mẹo & hướng dẫn", note: "Đưa kiến thức hữu ích", mark: "03" },
  { id: "sales", label: "Bán hàng", note: "Nêu lợi ích, mời hành động", mark: "04" },
];

function friendlyError(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message : fallback;
}

async function jsonResult(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; }
  catch { return {}; }
}

export default function ScriptAiPage() {
  const account = useAccount();
  if (account.status === "loading") return <div className={styles.status}>Đang tải không gian tạo kịch bản…</div>;
  if (account.status !== "ready" || !account.account) return <div className={styles.status}><h1>Tạo kịch bản AI</h1><p>{account.message || "Đăng nhập để tạo và quản lý kịch bản của bạn."}</p><Link href="/dang-nhap" className={styles.primaryButton}>Đăng nhập</Link></div>;
  // Remount all local content when the authenticated identity changes. This also
  // removes an admin's editable prompt from memory before another user sees it.
  return <ScriptAiWorkspace key={account.account.userId} />;
}

function ScriptAiWorkspace() {
  const account = useAccount();
  const isAdmin = account.account?.isAdmin === true;
  const [format, setFormat] = useState<ScriptFormat>("review");
  const [templates, setTemplates] = useState<ScriptTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [script, setScript] = useState("");
  const [editor, setEditor] = useState<TemplateEditor | null>(null);
  const [deleteId, setDeleteId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const response = await fetch("/api/script-templates", { cache: "no-store" });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Không tải được các tiêu đề mẫu.");
      setTemplates(Array.isArray(data.templates) ? data.templates as ScriptTemplate[] : []);
    } catch (cause) {
      setError(friendlyError(cause, "Không tải được các tiêu đề mẫu."));
    } finally { setTemplatesLoading(false); }
  }, []);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const visibleTemplates = templates
    .filter(item => item.format === format)
    .sort((a, b) => Number(b.scope === "shared") - Number(a.scope === "shared") || a.title.localeCompare(b.title, "vi"));
  const selectedTemplate = visibleTemplates.find(item => item.id === selectedId);

  function chooseFormat(next: ScriptFormat) {
    setFormat(next);
    setSelectedId("");
    setTitle("");
    setScript("");
    setEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function chooseTemplate(item: ScriptTemplate) {
    setSelectedId(item.id);
    setTitle(item.title);
    setScript("");
    setError("");
  }

  function startNewTemplate() {
    setEditor({ format, title: title.trim(), description: "", prompt: "" });
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function startEditTemplate(item: ScriptTemplate) {
    if (typeof item.prompt !== "string") return;
    setEditor({ id: item.id, format: item.format, title: item.title, description: item.description || "", prompt: item.prompt || "" });
    setDeleteId("");
    setError("");
    setNotice("");
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const cleanTitle = editor.title.trim();
    const cleanPrompt = editor.prompt.trim();
    if (!cleanTitle || !cleanPrompt) { setError("Hãy nhập tên tiêu đề và hướng dẫn AI cho mẫu."); return; }
    setBusy("save"); setError(""); setNotice("");
    try {
      const response = await fetch(editor.id ? `/api/script-templates/${encodeURIComponent(editor.id)}` : "/api/script-templates", {
        method: editor.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleanTitle, format: editor.format, description: editor.description.trim(), prompt: cleanPrompt }),
      });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa lưu được tiêu đề mẫu.");
      setEditor(null);
      await loadTemplates();
      setNotice(editor.id ? "Đã cập nhật tiêu đề mẫu." : isAdmin ? "Đã thêm tiêu đề chung cho tất cả thành viên." : "Đã thêm tiêu đề riêng của bạn.");
    } catch (cause) { setError(friendlyError(cause, "Chưa lưu được tiêu đề mẫu.")); }
    finally { setBusy(""); }
  }

  async function removeTemplate(item: ScriptTemplate) {
    if (typeof item.prompt !== "string" || busy) return;
    setBusy("delete"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/script-templates/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa xóa được tiêu đề mẫu.");
      if (selectedId === item.id) setSelectedId("");
      setDeleteId("");
      await loadTemplates();
      setNotice("Đã xóa tiêu đề mẫu.");
    } catch (cause) { setError(friendlyError(cause, "Chưa xóa được tiêu đề mẫu.")); }
    finally { setBusy(""); }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !brief.trim()) { setError("Hãy nhập tiêu đề và thông tin bạn muốn chia sẻ."); return; }
    setBusy("generate"); setError(""); setNotice(""); setScript("");
    try {
      const response = await fetch("/api/script-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: selectedId || undefined, format, title: title.trim(), brief: brief.trim(), durationSeconds }),
      });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa tạo được kịch bản.");
      if (typeof data.script !== "string" || !data.script.trim()) throw new Error("AI chưa trả về kịch bản. Hãy thử lại.");
      setScript(data.script.trim());
    } catch (cause) { setError(friendlyError(cause, "Chưa tạo được kịch bản.")); }
    finally { setBusy(""); }
  }

  async function copyScript() {
    if (!script) return;
    try { await navigator.clipboard.writeText(script); setNotice("Đã sao chép kịch bản."); }
    catch { setError("Không sao chép tự động được. Bạn có thể chọn và sao chép nội dung bên dưới."); }
  }

  return <div className={styles.page}>
    <nav aria-label="Đường dẫn" className={styles.breadcrumb}><Link href="/">Tổng quan</Link><span aria-hidden="true">/</span><span aria-current="page">Tạo kịch bản AI</span></nav>
    <header className={styles.hero}><span className={styles.heroIcon}><PlatformIcon name="script" size={27} /></span><div><p className={styles.eyebrow}>CÔNG CỤ SÁNG TẠO NỘI DUNG</p><h1>Tạo kịch bản AI</h1><p>Chọn cách kể, nhập điều bạn muốn chia sẻ và để AI viết thành kịch bản phù hợp.</p></div></header>

    {error && <div role="alert" className={styles.error}>{error}<button type="button" aria-label="Đóng thông báo lỗi" onClick={() => setError("")}>×</button></div>}
    {notice && <div role="status" className={styles.notice}>{notice}<button type="button" aria-label="Đóng thông báo" onClick={() => setNotice("")}>×</button></div>}

    <div className={styles.layout}>
      <div className={styles.mainColumn}>
        <section className={styles.card} aria-labelledby="format-title"><div className={styles.sectionHeading}><span className={styles.step}>1</span><div><h2 id="format-title">Chọn dạng kịch bản</h2><p>Mỗi dạng sẽ có cách triển khai nội dung riêng.</p></div></div>
          <div className={styles.formatGrid} role="group" aria-label="Dạng kịch bản">{formats.map(item => <button key={item.id} type="button" className={`${styles.formatButton} ${format === item.id ? styles.activeFormat : ""}`} aria-pressed={format === item.id} onClick={() => chooseFormat(item.id)}><span className={styles.formatMark}>{item.mark}</span><strong>{item.label}</strong><small>{item.note}</small></button>)}</div>
        </section>

        <section className={styles.card} aria-labelledby="title-heading"><div className={styles.sectionHeading}><span className={styles.step}>2</span><div><h2 id="title-heading">Nhập tiêu đề</h2><p>Viết chủ đề của bạn hoặc chọn một tiêu đề mẫu đã có hướng dẫn AI riêng.</p></div></div>
          <label className={styles.field} htmlFor="script-title">Tiêu đề kịch bản<input id="script-title" maxLength={120} value={title} onChange={event => { setTitle(event.target.value); setScript(""); }} placeholder="Ví dụ: Vì sao khách hàng thích sản phẩm này?" /></label>
          {selectedTemplate && <div className={styles.selectedNote}><PlatformIcon name="check" size={16} />Đang dùng hướng dẫn của mẫu “{selectedTemplate.title}”<button type="button" onClick={() => setSelectedId("")}>Bỏ mẫu</button></div>}
          <div className={styles.templateHeading}><h3>Tiêu đề mẫu</h3><span>{visibleTemplates.length} mẫu</span></div>
          {templatesLoading ? <p className={styles.empty}>Đang tải tiêu đề mẫu…</p> : visibleTemplates.length ? <div className={styles.templateList}>{visibleTemplates.map(item => {
            const canManage = typeof item.prompt === "string";
            return <div key={item.id} className={`${styles.templateRow} ${selectedId === item.id ? styles.selectedTemplate : ""}`}><button type="button" className={styles.templateChoose} aria-pressed={selectedId === item.id} onClick={() => chooseTemplate(item)}><span><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}</span><span className={item.scope === "shared" ? styles.sharedBadge : styles.personalBadge}>{item.scope === "shared" ? "Mẫu chung" : "Của tôi"}</span></button>{canManage && <div className={styles.templateActions}><button type="button" onClick={() => startEditTemplate(item)} aria-label={`Sửa ${item.title}`}>Sửa</button><button type="button" onClick={() => { setEditor(null); setDeleteId(item.id); }} aria-label={`Xóa ${item.title}`}>Xóa</button></div>}{deleteId === item.id && canManage && <div className={styles.deleteConfirm}><p>Xóa “{item.title}”? Thao tác này không thể hoàn tác.</p><div><button type="button" onClick={() => setDeleteId("")}>Giữ lại</button><button type="button" disabled={!!busy} onClick={() => void removeTemplate(item)}>Xóa mẫu</button></div></div>}</div>;
          })}</div> : <p className={styles.empty}>Chưa có tiêu đề mẫu cho dạng này. Bạn vẫn có thể nhập tiêu đề riêng và tạo kịch bản.</p>}
          <button type="button" className={styles.addButton} onClick={startNewTemplate}><PlatformIcon name="plus" size={18} />{isAdmin ? "Thêm tiêu đề dùng chung" : "Tạo tiêu đề của tôi"}</button>
          {editor && <form className={styles.editor} onSubmit={saveTemplate}><div className={styles.editorTop}><div><h3>{editor.id ? "Sửa tiêu đề mẫu" : "Tạo tiêu đề mẫu"}</h3><p>{isAdmin ? "Mẫu chung cho tất cả thành viên. Chỉ quản trị viên được xem hướng dẫn AI." : "Mẫu này chỉ thuộc tài khoản của bạn."}</p></div><button type="button" aria-label="Đóng biểu mẫu" onClick={() => setEditor(null)}>×</button></div><label className={styles.field}>Tên tiêu đề<input required maxLength={120} value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="Ví dụ: Review nhanh sản phẩm" /></label><label className={styles.field}>Mô tả ngắn <span>(không bắt buộc)</span><input maxLength={240} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} placeholder="Thành viên sẽ nhìn thấy mô tả này" /></label><label className={styles.field}>Hướng dẫn riêng cho AI<textarea required rows={6} maxLength={6000} value={editor.prompt} onChange={event => setEditor({ ...editor, prompt: event.target.value })} placeholder="Ví dụ: Mở đầu bằng một vấn đề thực tế, nêu trải nghiệm, không khẳng định điều chưa được cung cấp…" /></label><p className={styles.editorHint}>{isAdmin ? "Thành viên chỉ thấy tên và mô tả mẫu; nội dung hướng dẫn được giữ kín." : "Bạn có thể sửa hoặc xóa mẫu này sau khi lưu."}</p><div className={styles.editorActions}><button type="button" onClick={() => setEditor(null)}>Hủy</button><button type="submit" disabled={!!busy}>{busy === "save" ? "Đang lưu…" : "Lưu tiêu đề"}</button></div></form>}
        </section>

        <form className={styles.card} onSubmit={generate}><div className={styles.sectionHeading}><span className={styles.step}>3</span><div><h2>Cho AI biết điều cần chia sẻ</h2><p>Thông tin của bạn giúp kịch bản đúng ý và đúng sự thật.</p></div></div><label className={styles.field}>Sản phẩm, đối tượng và thông điệp chính<textarea required rows={5} maxLength={5000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Sản phẩm là gì? Dành cho ai? Điểm nổi bật nào bạn đã kiểm chứng? Bạn muốn người xem làm gì sau khi xem?" /></label><div className={styles.formFoot}><label className={styles.field}>Thời lượng dự kiến<select value={durationSeconds} onChange={event => setDurationSeconds(Number(event.target.value))}><option value={15}>15 giây</option><option value={30}>30 giây</option><option value={45}>45 giây</option><option value={60}>60 giây</option><option value={90}>90 giây</option></select></label><button type="submit" className={styles.primaryButton} disabled={!!busy || !title.trim() || !brief.trim()}><PlatformIcon name="spark" size={19} />{busy === "generate" ? "Đang viết kịch bản…" : "Tạo kịch bản"}</button></div></form>
      </div>

      <aside className={styles.resultColumn} aria-labelledby="result-title"><div className={styles.resultCard}><div className={styles.resultTop}><span className={styles.resultIcon}><PlatformIcon name="script" size={19} /></span><div><p className={styles.eyebrow}>KẾT QUẢ CỦA BẠN</p><h2 id="result-title">Kịch bản đã tạo</h2></div></div>{script ? <><div className={styles.scriptText}>{script}</div><button type="button" className={styles.copyButton} onClick={() => void copyScript()}><PlatformIcon name="check" size={18} />Sao chép kịch bản</button></> : <div className={styles.resultEmpty}><PlatformIcon name="spark" size={30} /><p>Kịch bản sẽ xuất hiện ở đây sau khi bạn nhấn “Tạo kịch bản”.</p></div>}</div></aside>
    </div>
  </div>;
}
