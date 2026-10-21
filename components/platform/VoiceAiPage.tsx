"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import { downloadSpeechSegments } from "@/lib/studio-upload";
import styles from "./VoiceAiPage.module.css";

type Voice = { voiceId: string; name: string; category: string; group?: string; previewUrl?: string; isPersonalClone?: boolean };
type CuratedVoice = { voice_id: string; name: string; enabled: boolean; kind: "system" | "admin_clone" };
type AdminCloneCandidate = { voice_id: string; name: string; enabled: boolean; kind: "admin_clone"; previewUrl?: string };
type AudioResult = { audioPath: string; audioMime: string; duration: number; voiceId?: string; audioUrl?: string };
type PendingVoiceTask = { requestId: string; createdAt: string };
const scriptTypes = ".txt,.md,.csv,.srt,.vtt";
// The standalone player/download path accepts one file up to 180 seconds.
// Keep generated speech within that practical bound until long-form chunking exists.
const MAX_SCRIPT = 1200;
const friendlyError = (value: unknown) => value instanceof Error ? value.message : "Có lỗi kết nối. Hãy thử lại.";

export default function VoiceAiPage() {
  const account = useAccount();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [curated, setCurated] = useState<CuratedVoice[]>([]);
  const [adminCloneCandidates, setAdminCloneCandidates] = useState<AdminCloneCandidate[]>([]);
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audio, setAudio] = useState<AudioResult | null>(null);
  const [audioSrc, setAudioSrc] = useState("");
  const [pendingTasks, setPendingTasks] = useState<PendingVoiceTask[]>([]);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [catalogBusy, setCatalogBusy] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const activeSrc = useRef("");
  const lastRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const requestInFlight = useRef(false);
  const tracking = useRef<AbortController | null>(null);
  const loading = account.status === "loading";
  const isAdmin = account.status === "ready" && account.account?.isAdmin === true;

  const load = useCallback(async () => {
    setBusy("loading"); setError("");
    try {
      const [vr, cr] = await Promise.all([fetch("/api/voices", { cache: "no-store" }), fetch("/api/voice-catalog", { cache: "no-store" })]);
      const [vd, cd] = await Promise.all([vr.json(), cr.json()]);
      if (!vr.ok) throw new Error(vd.error || "Không tải được danh sách giọng.");
      if (!cr.ok) throw new Error(cd.error || "Không tải được danh sách giọng được duyệt.");
      const items = Array.isArray(vd.voices) ? vd.voices as Voice[] : [];
      setVoices(items); setCurated(Array.isArray(cd.voices) ? cd.voices : []); setAdminCloneCandidates(Array.isArray(cd.candidates) ? cd.candidates : []);
      setSelected(previous => items.some(item => item.voiceId === previous) ? previous : items[0]?.voiceId || "");
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
  }, []);

  useEffect(() => { if (account.status === "ready") void load(); }, [account.status, load]);
  const loadPendingTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/voice-over/recover", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      setPendingTasks(Array.isArray(result.tasks) ? result.tasks.filter((item: PendingVoiceTask) => typeof item.requestId === "string" && typeof item.createdAt === "string") : []);
    } catch { /* The main voice workflow remains available if recovery listing is offline. */ }
  }, []);
  useEffect(() => { if (account.status === "ready") void loadPendingTasks(); }, [account.status, loadPendingTasks]);
  useEffect(() => () => { tracking.current?.abort(); if (activeSrc.current) URL.revokeObjectURL(activeSrc.current); }, []);

  const visible = voices.filter(voice => (group === "all" || (group === "personal" ? voice.category === "cloned" : voice.category !== "cloned")) && (!search.trim() || voice.name.toLocaleLowerCase("vi").includes(search.toLocaleLowerCase("vi").trim())));
  const shareableVoices = (() => {
    const byId = new Map<string, Voice>();
    for (const voice of voices) byId.set(voice.voiceId, voice);
    // The verified candidate kind wins over legacy display metadata.
    for (const candidate of adminCloneCandidates) byId.set(candidate.voice_id, { voiceId: candidate.voice_id, name: candidate.name, category: "cloned", previewUrl: candidate.previewUrl });
    return [...byId.values()].sort((a,b) => Number(b.category === "cloned") - Number(a.category === "cloned") || a.name.localeCompare(b.name,"vi"));
  })();

  async function readScript(file: File) {
    setError(""); setNotice("");
    if (!file.size || file.size > 100000 || !/\.(txt|md|csv|srt|vtt)$/i.test(file.name)) { setError("Chọn tệp TXT, MD, CSV, SRT hoặc VTT tối đa 100 KB."); return; }
    try {
      const value = (await file.text()).replace(/^\uFEFF/, "").replace(/^WEBVTT[^\n]*\n/i, "").replace(/^\d+\s*$/gm, "").replace(/^\d\d:\d\d(?::\d\d)?[,.]\d+\s*-->[^\n]*$/gm, "").trim();
      if (!value || value.length > MAX_SCRIPT) throw new Error("Mỗi tệp giọng hỗ trợ tối đa 1.200 ký tự. Hãy chia kịch bản dài thành các đoạn ngắn hơn.");
      setText(value); setAudio(null); setNotice("Đã nhập kịch bản từ " + file.name);
    } catch (err) { setError(friendlyError(err)); }
  }

  function acceptAudioResult(result: AudioResult) {
    if (!result || typeof result.audioPath !== "string" || !["audio/mpeg", "audio/wav"].includes(result.audioMime) || !Number.isFinite(result.duration) || result.duration <= 0)
      throw new Error("Đã nhận tác vụ nhưng tệp lời đọc chưa sẵn sàng. Hãy dùng nút khôi phục bên dưới.");
    if (activeSrc.current) URL.revokeObjectURL(activeSrc.current);
    activeSrc.current = ""; setAudioSrc(""); setAudio(result);
    window.dispatchEvent(new Event("studio-credits-changed"));
  }

  async function trackPending(task: PendingVoiceTask, controller: AbortController, initialReason?: string) {
    setPendingTasks(previous => previous.some(item => item.requestId === task.requestId) ? previous : [task, ...previous]);
    setBusy("recover"); setNotice(initialReason === "MAZIAO_REJECTED" || initialReason === "MAZIAO_UNAVAILABLE"
      ? "Maziao tạm gián đoạn khi kiểm tra kết quả. Tác vụ đã được gửi; ứng dụng đang lấy lại chính tác vụ này, không tính thêm lượt tạo."
      : "Lời đọc đã được gửi. Đang kiểm tra kết quả; không gửi thêm yêu cầu tạo giọng.");
    const limit = Date.now() + 8 * 60_000;
    let invalidResponses = 0;
    while (!controller.signal.aborted && Date.now() < limit) {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      if (controller.signal.aborted) return;
      const response = await fetch("/api/voice-over/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: task.requestId }), signal: controller.signal });
      const result = await response.json();
      if (response.status === 202 && result.pending === true) {
        invalidResponses = result.reason === "MAZIAO_INVALID_RESPONSE" ? invalidResponses + 1 : 0;
        if (invalidResponses >= 2) throw new Error("Dịch vụ đã nhận tác vụ nhưng trả kết quả chưa đúng định dạng. Tác vụ vẫn được giữ; hãy dùng Lấy lại lời đọc sau hoặc liên hệ quản trị viên.");
        continue;
      }
      if (!response.ok) throw new Error(result.error || "Chưa lấy lại được lời đọc. Hãy thử lại sau.");
      acceptAudioResult(result);
      lastRequest.current = null;
      setPendingTasks(previous => previous.filter(item => item.requestId !== task.requestId));
      setNotice("Đã tạo lời đọc. Bấm Nghe hoặc Tải MP3/WAV để nhận tệp.");
      await loadPendingTasks();
      return;
    }
    if (!controller.signal.aborted) setNotice("Maziao chưa trả file sau thời gian chờ. Trạng thái chờ đã kết thúc trên trang; bấm Lấy lại lời đọc sau để kiểm tra cùng tác vụ, không tạo lượt mới.");
  }

  async function generate() {
    if (requestInFlight.current || busy || !selected || !text.trim()) return;
    requestInFlight.current = true;
    const controller = new AbortController(); tracking.current = controller;
    setBusy("speech"); setError(""); setNotice("");
    try {
      const payload = { voiceId: selected, text: text.trim(), speed, volume, pitch };
      const fingerprint = JSON.stringify(payload);
      if (lastRequest.current?.fingerprint !== fingerprint) lastRequest.current = { fingerprint, id: crypto.randomUUID() };
      const existing = pendingTasks.find(task => task.requestId === lastRequest.current?.id);
      if (existing) { await trackPending(existing, controller); return; }
      const response = await fetch("/api/voice-over", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": lastRequest.current.id }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (response.status === 202 && result.pending === true) {
        await trackPending({ requestId: lastRequest.current.id, createdAt: new Date().toISOString() }, controller, result.reason);
        return;
      }
      if (!response.ok) {
        if (!["MAZIAO_INVALID_RESPONSE", "MAZIAO_TIMEOUT", "MAZIAO_UNAVAILABLE", "MAZIAO_REJECTED", "MAZIAO_AUDIO_DOWNLOAD", "INVALID_AUDIO", "AUDIO_STORE_FAILED", "AUDIO_LINK_FAILED", "CREDIT_LEDGER_UNAVAILABLE"].includes(result.code)) lastRequest.current = null;
        throw new Error(result.error || "Không tạo được giọng đọc.");
      }
      acceptAudioResult(result);
      setPendingTasks(previous => previous.filter(task => task.requestId !== lastRequest.current?.id));
      lastRequest.current = null; await loadPendingTasks();
      setNotice("Đã tạo lời đọc. Bấm Nghe hoặc Tải MP3/WAV để nhận tệp.");
    } catch (err) { if (!controller.signal.aborted) { setError(friendlyError(err)); await loadPendingTasks(); } }
    finally { if (tracking.current === controller) { requestInFlight.current = false; tracking.current = null; setBusy(""); } }
  }

  async function recover(task: PendingVoiceTask) {
    if (requestInFlight.current || busy) return;
    requestInFlight.current = true;
    const controller = new AbortController(); tracking.current = controller;
    setBusy("recover"); setError(""); setNotice("");
    try { await trackPending(task, controller); }
    catch (err) { if (!controller.signal.aborted) setError(friendlyError(err)); }
    finally { if (tracking.current === controller) { requestInFlight.current = false; tracking.current = null; await loadPendingTasks(); setBusy(""); } }
  }

  function stopTracking() {
    tracking.current?.abort(); tracking.current = null;
    requestInFlight.current = false;
    setBusy("");
    setNotice("Đã dừng chờ trên trang này. Tác vụ vẫn tiếp tục xử lý; hãy dùng Lấy lại lời đọc để nhận file, không tạo lượt mới.");
  }

  async function downloadAudio(save: boolean) {
    if (!audio || busy) return;
    setBusy("download"); setError("");
    try {
      const [item] = await downloadSpeechSegments([{ start: 0, end: audio.duration, text, audioPath: audio.audioPath, audioMime: audio.audioMime }]);
      const raw = atob(item.audioBase64);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: audio.audioMime });
      const url = URL.createObjectURL(blob);
      if (activeSrc.current) URL.revokeObjectURL(activeSrc.current);
      activeSrc.current = url; setAudioSrc(url);
      if (save) {
        const link = document.createElement("a");
        link.href = url; link.download = "loi-ke-ai-" + Date.now() + (audio.audioMime === "audio/mpeg" ? ".mp3" : ".wav");
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setNotice(save ? "Đã gửi tệp xuống trình duyệt. Tệp vẫn được giữ để tải lại." : "Đã nhận lời đọc, có thể nghe ngay bên dưới.");
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
  }

  async function deletePersonalVoice(voice: Voice) {
    if (busy || isAdmin || !voice.isPersonalClone || deleteCandidate !== voice.voiceId) return;
    setBusy("delete"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/voices/${encodeURIComponent(voice.voiceId)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error(result.error || "Không xóa được giọng này. Hãy thử lại.");
      setDeleteCandidate("");
      setVoices(previous => previous.filter(item => item.voiceId !== voice.voiceId));
      setSelected(previous => previous === voice.voiceId ? "" : previous);
      setNotice(`Đã xóa giọng ${voice.name}. Bạn có thể tạo giọng khác.`);
      await load();
      account.refresh();
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
  }

  async function synchronizeVoices() {
    if (syncBusy || busy) return;
    setSyncBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/voices/sync", { method: "POST", headers: { "Content-Type": "application/json" } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Không đồng bộ được giọng từ API.");
      setNotice(`Đã cập nhật ${result.synced} giọng, gồm ${result.adminClones} giọng thuộc tài khoản quản trị.`);
      await load();
    } catch (err) { setError(friendlyError(err)); }
    finally { setSyncBusy(false); }
  }

  async function approve(voice: Voice, enabled: boolean) {
    setCatalogBusy(voice.voiceId); setError("");
    try {
      const kind = voice.category === "cloned" ? "admin_clone" : "system";
      const response = await fetch("/api/voice-catalog", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: voice.voiceId, name: voice.name, enabled, kind }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Chưa lưu được quyền giọng.");
      setCurated(previous => [...previous.filter(item => item.voice_id !== voice.voiceId), result.voice]);
      setNotice(enabled ? "Đã cho phép thành viên sử dụng giọng này." : "Đã ẩn giọng khỏi thành viên.");
    } catch (err) { setError(friendlyError(err)); }
    finally { setCatalogBusy(""); }
  }

  return <main className={styles.page}>
    <nav className={styles.breadcrumb}><Link href="/">Tổng quan</Link><span>/</span><span>Tạo giọng nói AI</span></nav>
    <header className={styles.hero}>
      <div className={styles.heroIcon}><PlatformIcon name="voice" size={30}/></div>
      <div><span className={styles.kicker}>CÔNG CỤ SÁNG TẠO ÂM THANH</span><h1>Tạo giọng nói AI</h1><p>Chọn giọng, nhập lời thoại và tạo âm thanh tiếng Việt tự nhiên.</p></div>
    </header>
    {account.status !== "ready" ? <section className={styles.notice}><strong>{loading ? "Đang kiểm tra tài khoản…" : account.status === "anonymous" ? "Cần đăng nhập để tạo giọng" : "Tài khoản chưa sẵn sàng"}</strong><p>{account.message || "Đăng nhập để xem thư viện giọng và tạo âm thanh."}</p>{account.status === "anonymous" ? <Link href="/dang-nhap">Đăng nhập →</Link> : <button onClick={account.refresh}>Thử lại</button>}</section> :
    <>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.success} role="status">{notice}</div>}
      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>01</span><h2>Chọn giọng nói</h2></div><button className={styles.textButton} onClick={() => void load()} disabled={Boolean(busy)}><PlatformIcon name="refresh" size={17}/> Làm mới</button></div>
            <div className={styles.filterBar}><input aria-label="Tìm kiếm giọng nói" placeholder="Tìm giọng theo tên..." value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="Nhóm giọng" value={group} onChange={e => setGroup(e.target.value)}><option value="all">Tất cả giọng</option><option value="shared">Giọng thư viện</option><option value="personal">Giọng cá nhân</option></select></div>
            <p className={styles.muted}>Muốn thêm giọng riêng? <Link href="/ca-nhan/nhan-ban-giong" className={styles.scriptLink}>Nhân bản giọng trong Cá nhân <PlatformIcon name="arrow" size={16}/></Link></p>
            {busy === "loading" && voices.length === 0 ? <p className={styles.muted}>Đang tải giọng nói đã lưu…</p> : visible.length ? <div className={styles.voiceGrid}>{visible.map(voice =>
              <article key={voice.voiceId} className={selected === voice.voiceId ? styles.voiceSelected : styles.voiceItem}>
                <button type="button" className={styles.voiceSelectButton} disabled={Boolean(busy)} onClick={() => { setSelected(voice.voiceId); setAudio(null); setAudioSrc(""); }}>
                  <span className={styles.voiceAvatar}><PlatformIcon name="voice" size={22}/></span>
                  <span className={styles.voiceCopy}><strong>{voice.name}</strong><small>{voice.category === "cloned" ? "Giọng cá nhân" : "Giọng thư viện"}</small></span>
                  {selected === voice.voiceId && <PlatformIcon name="check" size={19}/>}
                </button>
                {voice.previewUrl ? <audio aria-label={`Nghe thử ${voice.name}`} controls preload="none" className={styles.voicePreview} src={voice.previewUrl}>Trình duyệt chưa hỗ trợ nghe thử.</audio> : <span className={styles.previewUnavailable}>Chưa có bản nghe thử</span>}
                {!isAdmin && voice.isPersonalClone === true && (deleteCandidate === voice.voiceId ?
                  <div className={styles.deleteConfirm} role="group" aria-label={`Xác nhận xóa giọng ${voice.name}`}>
                    <p>Xóa hẳn giọng này? Giọng đã xóa không thể khôi phục. Hãy tải về lời đọc cần giữ trước khi rời trang.</p>
                    <div className={styles.deleteActions}>
                      <button type="button" className={styles.deleteCancel} disabled={Boolean(busy)} onClick={() => setDeleteCandidate("")}>Giữ giọng</button>
                      <button type="button" className={styles.deleteConfirmButton} disabled={Boolean(busy)} onClick={() => void deletePersonalVoice(voice)}>{busy === "delete" ? "Đang xóa…" : "Xác nhận xóa"}</button>
                    </div>
                  </div> :
                  <button type="button" className={styles.deleteTrigger} disabled={Boolean(busy)} onClick={() => setDeleteCandidate(voice.voiceId)}>Xóa giọng để tạo giọng khác</button>)}
              </article>
            )}</div> : <p className={styles.muted}>Chưa có giọng được cấp quyền trong nhóm này. {isAdmin ? "Hãy làm mới danh sách giọng." : "Quản trị viên sẽ chọn giọng phù hợp cho bạn."}</p>}
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>02</span><h2>Nhập lời thoại</h2></div><span className={styles.counter}>{text.length.toLocaleString("vi-VN")} / {MAX_SCRIPT.toLocaleString("vi-VN")}</span></div>
            <textarea aria-label="Nội dung lời thoại" className={styles.textarea} value={text} maxLength={MAX_SCRIPT} placeholder="Nhập nội dung cần chuyển thành giọng nói tại đây…" onChange={e => { setText(e.target.value); setAudio(null); setAudioSrc(""); }} />
            <div className={styles.scriptFooter}><label className={styles.upload}><PlatformIcon name="plus" size={18}/> Tải kịch bản lên<input ref={fileInput} type="file" accept={scriptTypes} onChange={e => { const file=e.target.files?.[0]; if(file) void readScript(file); e.target.value=""; }}/></label><Link href="/cong-cu/kich-ban-ai" className={styles.scriptLink}>Chưa có kịch bản? Tạo bằng AI <PlatformIcon name="arrow" size={16}/></Link></div>
          </section>
          <section className={`${styles.card} ${styles.settingsCard}`}>
            <details className={styles.audioSettings}>
              <summary className={styles.settingsToggle}>
                <span className={styles.step}>03</span>
                <span className={styles.settingsCopy}><strong>Cấu hình âm thanh</strong><small>Nên giữ mặc định để giọng đọc tự nhiên.</small></span>
                <span className={styles.settingsArrow} aria-hidden="true"/>
              </summary>
              <div className={styles.settingsControls}>
                {([{ label: "Tốc độ", value: speed, set: setSpeed, min: 0.8, max: 1.2 }, { label: "Âm lượng", value: volume, set: setVolume, min: 0.5, max: 1.5 }, { label: "Cao độ", value: pitch, set: setPitch, min: 0.8, max: 1.2 }] as const).map(setting => <label className={styles.slider} key={setting.label}><span><strong>{setting.label}</strong><output>{setting.value.toFixed(2)}{setting.label === "Tốc độ" ? "x" : ""}</output></span><input type="range" min={setting.min} max={setting.max} step="0.05" value={setting.value} onChange={e => setting.set(Number(e.target.value))}/></label>)}
                <button type="button" className={styles.reset} onClick={() => { setSpeed(1); setVolume(1); setPitch(1); }}>Đặt lại mặc định</button>
              </div>
            </details>
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>04</span><h2>Tạo và tải giọng đọc</h2></div></div>
            <button className={styles.generate} onClick={() => void generate()} disabled={Boolean(busy) || !selected || !text.trim()}>{busy === "speech" ? "Đã gửi lời đọc, đang chờ…" : busy === "recover" ? "Đang lấy kết quả giọng…" : "Tạo giọng nói AI"} <PlatformIcon name="arrow" size={19}/></button>
            {busy === "recover" && <button type="button" className={styles.textButton} onClick={stopTracking}>Dừng chờ trên trang này</button>}
            {pendingTasks.length > 0 && <div className={styles.result}><strong>Lời đọc đã gửi, có thể lấy lại</strong><p className={styles.muted}>Nếu lần tạo trước bị gián đoạn, lấy lại tệp từ tác vụ cũ mà không tạo thêm lượt mới.</p><div className={styles.resultButtons}>{pendingTasks.map(task => <button key={task.requestId} type="button" disabled={Boolean(busy)} onClick={() => void recover(task)}>{busy === "recover" ? "Đang lấy lại…" : `Lấy lại lời đọc ${new Date(task.createdAt).toLocaleString("vi-VN")}`}</button>)}</div></div>}
            {audio && <div className={styles.result}><strong>Đã tạo lời đọc • {audio.duration.toFixed(1)} giây</strong><div className={styles.resultButtons}><button onClick={() => void downloadAudio(false)} disabled={Boolean(busy)}>Nghe lời đọc</button><button onClick={() => void downloadAudio(true)} disabled={Boolean(busy)}>Tải MP3 / WAV</button></div>{audioSrc && <audio controls src={audioSrc} className={styles.player}/>}<p className={styles.muted}>Nếu mất mạng khi tải, bấm lại để nhận chính tệp đã tạo, không tạo lại từ đầu.</p></div>}
          </section>
        </div>
      </div>
      {isAdmin && <section className={styles.card}><div className={styles.sectionHeading}><div><span className={styles.step}>ADMIN</span><h2>Giọng dùng chung cho tất cả thành viên</h2></div><button className={styles.textButton} disabled={syncBusy || Boolean(busy)} onClick={() => void synchronizeVoices()}>{syncBusy ? "Đang đồng bộ…" : "Đồng bộ giọng từ API"}</button></div><p className={styles.muted}>Bật một lần tại đây để mọi tài khoản thành viên nhìn thấy giọng đó. Bạn có thể chia sẻ cả giọng thư viện và các giọng do chính tài khoản quản trị nhân bản. Giọng clone của thành viên khác vẫn luôn riêng tư.</p><div className={styles.catalogGrid}>{shareableVoices.map(voice => {
        const enabled = curated.some(item => item.voice_id === voice.voiceId && item.enabled);
        const isClone = voice.category === "cloned";
        return <article className={styles.catalogRow} key={voice.voiceId}>
          <span><strong>{voice.name}</strong>
            {!isClone && <small>Giọng thư viện · {enabled ? "Đang dùng chung" : "Chưa chia sẻ"}</small>}
          </span>
          <input type="checkbox" aria-label={`Cho thành viên dùng giọng ${voice.name}`} checked={enabled} disabled={Boolean(catalogBusy)} onChange={e => void approve(voice, e.target.checked)}/>
          {voice.previewUrl ? <audio controls preload="none" aria-label={`Nghe thử ${voice.name}`} className={styles.catalogPreview} src={voice.previewUrl}/> : <small className={styles.catalogPreview}>Chưa có bản nghe thử</small>}
        </article>;
      })}</div></section>}
    </>}
  </main>;
}
