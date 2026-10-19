"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import styles from "./ScriptAiPage.module.css";

type ScriptFormat = "review" | "story" | "tips" | "sales";
type ScriptType = {
  id: string;
  title: string;
  scope: "shared" | "personal";
  description?: string;
  /** The API includes this only for the owner. */
  prompt?: string;
};
type BuiltInType = {
  format: ScriptFormat;
  title: string;
  description: string;
  /** The API includes this only for the administrator. */
  prompt?: string;
};
type TypeEditor = { id?: string; title: string; description: string; prompt: string };
type BuiltInEditor = { format: ScriptFormat; title: string; description: string; prompt: string };
type Selection = { kind: "builtIn"; format: ScriptFormat } | { kind: "custom"; id: string };

const builtInTypes: { id: ScriptFormat; label: string; note: string; mark: string }[] = [
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
  const scriptCost = account.account?.creditRates?.script ?? 10;
  const availableCredits = account.account?.credits?.available;
  const [selection, setSelection] = useState<Selection>({ kind: "builtIn", format: "review" });
  const [builtins, setBuiltins] = useState<BuiltInType[]>(builtInTypes.map(item => ({
    format: item.id, title: item.label, description: item.note,
  })));
  const [types, setTypes] = useState<ScriptType[]>([]);
  const [typesLoading, setTypesLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [script, setScript] = useState("");
  const [editor, setEditor] = useState<TypeEditor | null>(null);
  const [builtInEditor, setBuiltInEditor] = useState<BuiltInEditor | null>(null);
  const [deleteId, setDeleteId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadTypes = useCallback(async () => {
    setTypesLoading(true);
    try {
      const response = await fetch("/api/script-templates", { cache: "no-store" });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Không tải được các dạng kịch bản.");
      const next = Array.isArray(data.templates) ? data.templates as ScriptType[] : [];
      const loadedBuiltins = Array.isArray(data.builtins) ? data.builtins as BuiltInType[] : [];
      setBuiltins(builtInTypes.map(item => {
        const saved = loadedBuiltins.find(value => value.format === item.id);
        return {
          format: item.id,
          title: typeof saved?.title === "string" ? saved.title : item.label,
          description: typeof saved?.description === "string" ? saved.description : item.note,
          ...(isAdmin && typeof saved?.prompt === "string" ? { prompt: saved.prompt } : {}),
        };
      }));
      setTypes(next);
      setSelection(previous => previous.kind === "custom" && !next.some(item => item.id === previous.id)
        ? { kind: "builtIn", format: "review" }
        : previous);
    } catch (cause) {
      setError(friendlyError(cause, "Không tải được các dạng kịch bản."));
    } finally { setTypesLoading(false); }
  }, [isAdmin]);

  useEffect(() => { void loadTypes(); }, [loadTypes]);

  const selectedCustom = selection.kind === "custom" ? types.find(item => item.id === selection.id) : undefined;

  function chooseBuiltIn(format: ScriptFormat) {
    setSelection({ kind: "builtIn", format });
    setScript("");
    setEditor(null);
    setBuiltInEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function chooseCustom(item: ScriptType) {
    setSelection({ kind: "custom", id: item.id });
    // The video topic stays independent of the selected script type.
    setScript("");
    setEditor(null);
    setBuiltInEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function startNewType() {
    setEditor({ title: "", description: "", prompt: "" });
    setBuiltInEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function startEditType(item: ScriptType) {
    if (typeof item.prompt !== "string") return;
    setEditor({ id: item.id, title: item.title, description: item.description || "", prompt: item.prompt });
    setBuiltInEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  function startEditBuiltIn(item: BuiltInType) {
    if (!isAdmin) return;
    setSelection({ kind: "builtIn", format: item.format });
    setScript("");
    setBuiltInEditor({ format: item.format, title: item.title, description: item.description, prompt: item.prompt || "" });
    setEditor(null);
    setDeleteId("");
    setError("");
    setNotice("");
  }

  async function saveBuiltIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isAdmin || !builtInEditor || busy) return;
    const cleanTitle = builtInEditor.title.trim();
    const cleanPrompt = builtInEditor.prompt.trim();
    if (!cleanTitle || !cleanPrompt) { setError("Hãy nhập tên dạng kịch bản và prompt hướng dẫn AI."); return; }
    setBusy("saveBuiltin"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/script-builtins/${builtInEditor.format}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ title: cleanTitle, description: builtInEditor.description.trim(), prompt: cleanPrompt }),
      });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa lưu được dạng kịch bản.");
      setBuiltInEditor(null);
      await loadTypes();
      setNotice("Đã cập nhật dạng kịch bản dùng chung.");
    } catch (cause) { setError(friendlyError(cause, "Chưa lưu được dạng kịch bản.")); }
    finally { setBusy(""); }
  }

  async function saveType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const cleanTitle = editor.title.trim();
    const cleanPrompt = editor.prompt.trim();
    if (!cleanTitle || !cleanPrompt) { setError("Hãy nhập tên dạng kịch bản và hướng dẫn AI."); return; }
    setBusy("save"); setError(""); setNotice("");
    try {
      const response = await fetch(editor.id ? `/api/script-templates/${encodeURIComponent(editor.id)}` : "/api/script-templates", {
        method: editor.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleanTitle, description: editor.description.trim(), prompt: cleanPrompt }),
      });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa lưu được dạng kịch bản.");
      const saved = data.template as ScriptType | undefined;
      setEditor(null);
      await loadTypes();
      if (saved?.id) { setSelection({ kind: "custom", id: saved.id }); setScript(""); }
      setNotice(editor.id ? "Đã cập nhật dạng kịch bản." : isAdmin ? "Đã thêm dạng kịch bản dùng chung." : "Đã thêm dạng kịch bản của bạn.");
    } catch (cause) { setError(friendlyError(cause, "Chưa lưu được dạng kịch bản.")); }
    finally { setBusy(""); }
  }

  async function removeType(item: ScriptType) {
    if (typeof item.prompt !== "string" || busy) return;
    setBusy("delete"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/script-templates/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa xóa được dạng kịch bản.");
      if (selection.kind === "custom" && selection.id === item.id) { setSelection({ kind: "builtIn", format: "review" }); setScript(""); }
      setDeleteId("");
      await loadTypes();
      setNotice("Đã xóa dạng kịch bản.");
    } catch (cause) { setError(friendlyError(cause, "Chưa xóa được dạng kịch bản.")); }
    finally { setBusy(""); }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (availableCredits !== undefined && availableCredits < scriptCost) { setError(`Cần ${scriptCost} credit để tạo kịch bản. Hiện bạn còn ${availableCredits} credit khả dụng.`); return; }
    if (!title.trim() || brief.trim().length < 5) { setError("Hãy nhập chủ đề video và thông tin bạn muốn chia sẻ."); return; }
    setBusy("generate"); setError(""); setNotice(""); setScript("");
    try {
      const selectedType = selection.kind === "custom" ? { templateId: selection.id } : { format: selection.format };
      const response = await fetch("/api/script-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...selectedType, title: title.trim(), brief: brief.trim(), durationSeconds }),
      });
      const data = await jsonResult(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Chưa tạo được kịch bản.");
      if (typeof data.script !== "string" || !data.script.trim()) throw new Error("AI chưa trả về kịch bản. Hãy thử lại.");
      setScript(data.script.trim());
      window.dispatchEvent(new Event("studio-credits-changed"));
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
    <header className={styles.hero}><span className={styles.heroIcon}><PlatformIcon name="script" size={27} /></span><div><p className={styles.eyebrow}>CÔNG CỤ SÁNG TẠO NỘI DUNG</p><h1>Tạo kịch bản AI</h1><p>Chọn dạng kịch bản, nhập chủ đề video và nói điều bạn muốn chia sẻ.</p></div></header>

    {error && <div role="alert" className={styles.error}>{error}<button type="button" aria-label="Đóng thông báo lỗi" onClick={() => setError("")}>×</button></div>}
    {notice && <div role="status" className={styles.notice}>{notice}<button type="button" aria-label="Đóng thông báo" onClick={() => setNotice("")}>×</button></div>}

    <div className={styles.layout}>
      <div className={styles.mainColumn}>
        <section className={styles.card} aria-labelledby="format-title">
          <div className={styles.sectionHeading}><span className={styles.step}>1</span><div><h2 id="format-title">Chọn dạng kịch bản</h2><p>Mỗi dạng có cách viết riêng. Bạn cũng có thể thêm dạng mới kèm hướng dẫn cho AI.</p></div></div>
          <div className={styles.formatGrid} role="group" aria-label="Dạng kịch bản">
            {builtInTypes.map(item => {
              const current = builtins.find(value => value.format === item.id) || { format: item.id, title: item.label, description: item.note };
              const active = selection.kind === "builtIn" && selection.format === item.id;
              return <div key={item.id} className={`${styles.builtInType} ${active ? styles.activeFormat : ""}`}>
                <button type="button" className={styles.formatButton} aria-pressed={active} onClick={() => chooseBuiltIn(item.id)}><span className={styles.formatMark}>{item.mark}</span><strong>{current.title}</strong><small>{current.description}</small><span className={styles.sharedBadge}>Dùng chung</span></button>
                {isAdmin && <div className={styles.builtInActions}><button type="button" disabled={typesLoading || !!busy} onClick={() => startEditBuiltIn(current)} aria-label={`Sửa dạng ${current.title} và prompt hướng dẫn`}>Sửa</button></div>}
              </div>;
            })}
            {isAdmin && builtInEditor && <form className={`${styles.editor} ${styles.builtInEditor}`} onSubmit={saveBuiltIn}>
              <div className={styles.editorTop}><div><h3>Chỉnh sửa dạng kịch bản có sẵn</h3><p>Tên và mô tả hiển thị cho mọi thành viên; prompt chỉ quản trị viên xem được.</p></div><button type="button" aria-label="Đóng biểu mẫu" onClick={() => setBuiltInEditor(null)}>×</button></div>
              <label className={styles.field}>Tên dạng kịch bản<input required maxLength={120} value={builtInEditor.title} onChange={event => setBuiltInEditor({ ...builtInEditor, title: event.target.value })} /></label>
              <label className={styles.field}>Mô tả ngắn <span>(không bắt buộc)</span><input maxLength={240} value={builtInEditor.description} onChange={event => setBuiltInEditor({ ...builtInEditor, description: event.target.value })} /></label>
              <label className={styles.field}>Prompt hướng dẫn AI<textarea required rows={7} maxLength={6000} value={builtInEditor.prompt} onChange={event => setBuiltInEditor({ ...builtInEditor, prompt: event.target.value })} placeholder="Nêu cấu trúc, giọng điệu, cách mở đầu và kết thúc cho dạng kịch bản này. Chỉ dùng thông tin người dùng cung cấp; không bịa trải nghiệm hay kết quả." /></label>
              <p className={styles.editorHint}>Prompt được áp dụng khi bất kỳ thành viên nào chọn dạng này để tạo kịch bản.</p>
              <div className={styles.editorActions}><button type="button" onClick={() => setBuiltInEditor(null)}>Hủy</button><button type="submit" disabled={!!busy}>{busy === "saveBuiltin" ? "Đang lưu…" : "Lưu thay đổi"}</button></div>
            </form>}
            {types.map(item => {
              const canManage = typeof item.prompt === "string";
              const active = selection.kind === "custom" && selection.id === item.id;
              return <div key={item.id} className={`${styles.customType} ${active ? styles.activeFormat : ""}`}>
                <button type="button" className={styles.customTypeChoose} aria-pressed={active} onClick={() => chooseCustom(item)}><span className={`${styles.formatMark} ${styles.customMark}`}><PlatformIcon name="spark" size={14} /></span><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}<span className={item.scope === "shared" ? styles.sharedBadge : styles.personalBadge}>{item.scope === "shared" ? "Dùng chung" : "Của tôi"}</span></button>
                {canManage && <div className={styles.customActions}><button type="button" onClick={() => startEditType(item)} aria-label={`Sửa dạng ${item.title}`}>Sửa</button><button type="button" onClick={() => { setEditor(null); setDeleteId(item.id); }} aria-label={`Xóa dạng ${item.title}`}>Xóa</button></div>}
                {deleteId === item.id && canManage && <div className={styles.deleteConfirm}><p>Xóa dạng “{item.title}”? Thao tác này không thể hoàn tác.</p><div><button type="button" onClick={() => setDeleteId("")}>Giữ lại</button><button type="button" disabled={!!busy} onClick={() => void removeType(item)}>Xóa dạng</button></div></div>}
              </div>;
            })}
          </div>
          {typesLoading && <p role="status" className={styles.loadingTypes}>Đang tải dạng kịch bản của bạn…</p>}
          <button type="button" className={styles.addButton} onClick={startNewType}><PlatformIcon name="plus" size={18} />{isAdmin ? "Thêm dạng kịch bản dùng chung" : "Tạo dạng kịch bản của tôi"}</button>
          {editor && <form className={styles.editor} onSubmit={saveType}>
            <div className={styles.editorTop}><div><h3>{editor.id ? "Sửa dạng kịch bản" : "Tạo dạng kịch bản mới"}</h3><p>{isAdmin ? "Dạng của quản trị viên xuất hiện cho tất cả thành viên." : "Dạng này chỉ thuộc tài khoản của bạn."}</p></div><button type="button" aria-label="Đóng biểu mẫu" onClick={() => setEditor(null)}>×</button></div>
            <label className={styles.field}>Tên dạng kịch bản<input required maxLength={120} value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="Ví dụ: Chia sẻ câu chuyện khách hàng" /></label>
            <label className={styles.field}>Mô tả ngắn <span>(không bắt buộc)</span><input maxLength={240} value={editor.description} onChange={event => setEditor({ ...editor, description: event.target.value })} placeholder="Giúp người dùng biết khi nào nên chọn dạng này" /></label>
            <label className={styles.field}>Prompt hướng dẫn AI<textarea required rows={6} maxLength={6000} value={editor.prompt} onChange={event => setEditor({ ...editor, prompt: event.target.value })} placeholder="Ví dụ: Mở đầu bằng vấn đề thực tế; kể trải nghiệm theo trình tự; kết bằng lời mời hành động. Không thêm thông tin chưa được người dùng cung cấp." /></label>
            <p className={styles.editorHint}>{isAdmin ? "Thành viên chỉ thấy tên và mô tả của dạng này, không thấy prompt." : "Bạn có thể sửa hoặc xóa dạng này sau khi lưu."}</p>
            <div className={styles.editorActions}><button type="button" onClick={() => setEditor(null)}>Hủy</button><button type="submit" disabled={!!busy}>{busy === "save" ? "Đang lưu…" : "Lưu dạng kịch bản"}</button></div>
          </form>}
        </section>

        <section className={styles.card} aria-labelledby="title-heading">
          <div className={styles.sectionHeading}><span className={styles.step}>2</span><div><h2 id="title-heading">Nhập chủ đề video</h2><p>Đây là nội dung video bạn muốn tạo, độc lập với dạng kịch bản đã chọn.</p></div></div>
          <label className={styles.field} htmlFor="script-title">Tiêu đề hoặc chủ đề video<input id="script-title" maxLength={120} value={title} onChange={event => { setTitle(event.target.value); setScript(""); }} placeholder="Ví dụ: Vì sao khách hàng thích sản phẩm này?" /></label>
          {selectedCustom && <p className={styles.selectedNote}><PlatformIcon name="check" size={16} />Đang dùng dạng “{selectedCustom.title}”</p>}
        </section>
        <form className={styles.card} onSubmit={generate}><div className={styles.sectionHeading}><span className={styles.step}>3</span><div><h2>Cho AI biết điều cần chia sẻ</h2><p>Thông tin của bạn giúp kịch bản đúng ý và đúng sự thật.</p></div></div><label className={styles.field}>Sản phẩm, đối tượng và thông điệp chính<textarea required rows={5} maxLength={5000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Sản phẩm là gì? Dành cho ai? Điểm nổi bật nào bạn đã kiểm chứng? Bạn muốn người xem làm gì sau khi xem?" /></label><div className={styles.formFoot}><label className={styles.field}>Thời lượng dự kiến<select value={durationSeconds} onChange={event => setDurationSeconds(Number(event.target.value))}><option value={15}>15 giây</option><option value={30}>30 giây</option><option value={45}>45 giây</option><option value={60}>60 giây</option><option value={90}>90 giây</option></select></label><button type="submit" className={styles.primaryButton} disabled={!!busy || !title.trim() || brief.trim().length < 5 || (availableCredits !== undefined && availableCredits < scriptCost)}><PlatformIcon name="spark" size={19} />{busy === "generate" ? "Đang viết kịch bản…" : "Tạo kịch bản"}</button></div><p className={styles.creditHint}>{scriptCost} credit mỗi lần tạo{availableCredits !== undefined ? ` · Còn ${availableCredits} credit khả dụng` : ""}{availableCredits !== undefined && availableCredits < scriptCost ? <> · <Link href="/ca-nhan">Xem số dư</Link></> : null}</p></form>
      </div>

      <aside className={styles.resultColumn} aria-labelledby="result-title"><div className={styles.resultCard}><div className={styles.resultTop}><span className={styles.resultIcon}><PlatformIcon name="script" size={19} /></span><div><p className={styles.eyebrow}>KẾT QUẢ CỦA BẠN</p><h2 id="result-title">Kịch bản đã tạo</h2></div></div>{script ? <><div className={styles.scriptText}>{script}</div><button type="button" className={styles.copyButton} onClick={() => void copyScript()}><PlatformIcon name="check" size={18} />Sao chép kịch bản</button></> : <div className={styles.resultEmpty}><PlatformIcon name="spark" size={30} /><p>Kịch bản sẽ xuất hiện ở đây sau khi bạn nhấn “Tạo kịch bản”.</p></div>}</div></aside>
    </div>
  </div>;
}
