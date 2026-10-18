"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import { downloadSpeechSegments, prepareMaziaoVoiceSample, uploadVoiceSamples, cleanupAnalysisMedia } from "@/lib/studio-upload";
import styles from "./VoiceAiPage.module.css";

type Voice = { voiceId: string; name: string; category: string; group?: string; previewUrl?: string };
type CuratedVoice = { voice_id: string; name: string; enabled: boolean; kind: "system" | "admin_clone" };
type AudioResult = { audioPath: string; audioMime: string; duration: number; voiceId: string; audioUrl?: string };
const scriptTypes = ".txt,.md,.csv,.srt,.vtt";
const MAX_SCRIPT = 6000;
const friendlyError = (value: unknown) => value instanceof Error ? value.message : "Có lỗi kết nối. Hãy thử lại.";

export default function VoiceAiPage() {
  const account = useAccount();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [curated, setCurated] = useState<CuratedVoice[]>([]);
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
  const [cloneName, setCloneName] = useState("");
  const [cloneGender, setCloneGender] = useState<"female" | "male">("female");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [catalogBusy, setCatalogBusy] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const activeSrc = useRef("");
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
      setVoices(items); setCurated(Array.isArray(cd.voices) ? cd.voices : []);
      setSelected(previous => items.some(item => item.voiceId === previous) ? previous : items[0]?.voiceId || "");
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
  }, []);

  useEffect(() => { if (account.status === "ready") void load(); }, [account.status, load]);
  useEffect(() => () => { if (activeSrc.current) URL.revokeObjectURL(activeSrc.current); }, []);

  const visible = voices.filter(voice => (group === "all" || (group === "personal" ? voice.category === "cloned" : voice.category !== "cloned")) && (!search.trim() || voice.name.toLocaleLowerCase("vi").includes(search.toLocaleLowerCase("vi").trim())));
  const selectedVoice = voices.find(voice => voice.voiceId === selected);
  const cloning = account.status === "ready" ? (account.account as typeof account.account & { voiceCloning?: { used: number; limit: number; remaining: number | null; unlimited: boolean } })?.voiceCloning : undefined;

  async function readScript(file: File) {
    setError(""); setNotice("");
    if (!file.size || file.size > 100000 || !/\.(txt|md|csv|srt|vtt)$/i.test(file.name)) { setError("Chọn tệp TXT, MD, CSV, SRT hoặc VTT tối đa 100 KB."); return; }
    try {
      const value = (await file.text()).replace(/^\uFEFF/, "").replace(/^WEBVTT[^\n]*\n/i, "").replace(/^\d+\s*$/gm, "").replace(/^\d\d:\d\d(?::\d\d)?[,.]\d+\s*-->[^\n]*$/gm, "").trim();
      if (!value || value.length > MAX_SCRIPT) throw new Error("Kịch bản cần từ 1 đến 6.000 ký tự.");
      setText(value); setAudio(null); setNotice("Đã nhập kịch bản từ " + file.name);
    } catch (err) { setError(friendlyError(err)); }
  }

  async function generate() {
    if (busy || !selected || !text.trim()) return;
    setBusy("speech"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/voice-over", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: selected, text: text.trim(), speed, volume, pitch }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Không tạo được giọng đọc.");
      if (activeSrc.current) URL.revokeObjectURL(activeSrc.current);
      activeSrc.current = ""; setAudioSrc(""); setAudio(result); setNotice("Maziao đã tạo lời đọc. Bấm Nghe hoặc Tải MP3/WAV để nhận tệp.");
      account.refresh();
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
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
        link.click();
      }
      setNotice(save ? "Đã gửi tệp xuống trình duyệt. Tệp vẫn được giữ để tải lại." : "Đã nhận lời đọc, có thể nghe ngay bên dưới.");
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(""); }
  }

  async function clone() {
    if (!cloneName.trim() || !cloneFile || !consent || busy) return;
    setBusy("clone"); setError(""); setNotice("");
    let paths: string[] = [];
    try {
      const sample = await prepareMaziaoVoiceSample(cloneFile);
      const uploaded = await uploadVoiceSamples([sample]); paths = uploaded.samplePaths;
      const response = await fetch("/api/voices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: cloneName.trim(), consent: true, samplePaths: paths, gender: cloneGender }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không nhân bản được giọng.");
      setCloneName(""); setCloneFile(null); setConsent(false);
      await load(); account.refresh();
      setSelected(data.voiceId || ""); setNotice("Đã tạo giọng cá nhân thành công.");
    } catch (err) { setError(friendlyError(err)); }
    finally { if (paths.length) await cleanupAnalysisMedia(paths).catch(() => {}); setBusy(""); }
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
      <div><span className={styles.kicker}>CÔNG CỤ SÁNG TẠO ÂM THANH</span><h1>Tạo giọng nói AI</h1><p>Chọn giọng, nhập lời thoại và tạo âm thanh tiếng Việt với Maziao.</p></div>
      <span className={styles.provider}>MAZIAO AI</span>
    </header>
    {account.status !== "ready" ? <section className={styles.notice}><strong>{loading ? "Đang kiểm tra tài khoản…" : account.status === "anonymous" ? "Cần đăng nhập để tạo giọng" : "Tài khoản chưa sẵn sàng"}</strong><p>{account.message || "Đăng nhập để xem thư viện giọng và sử dụng Maziao."}</p>{account.status === "anonymous" ? <Link href="/dang-nhap">Đăng nhập →</Link> : <button onClick={account.refresh}>Thử lại</button>}</section> :
    <>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.success} role="status">{notice}</div>}
      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>01</span><h2>Chọn giọng nói</h2></div><button className={styles.textButton} onClick={() => void load()} disabled={Boolean(busy)}><PlatformIcon name="refresh" size={17}/> Làm mới</button></div>
            <div className={styles.filterBar}><input aria-label="Tìm kiếm giọng nói" placeholder="Tìm giọng theo tên..." value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="Nhóm giọng" value={group} onChange={e => setGroup(e.target.value)}><option value="all">Tất cả giọng</option><option value="shared">Giọng thư viện</option><option value="personal">Giọng cá nhân</option></select></div>
            {busy === "loading" ? <p className={styles.muted}>Đang tải giọng nói…</p> : visible.length ? <div className={styles.voiceGrid}>{visible.map(voice => <button key={voice.voiceId} type="button" className={selected === voice.voiceId ? styles.voiceSelected : styles.voiceItem} onClick={() => { setSelected(voice.voiceId); setAudio(null); setAudioSrc(""); }}><span className={styles.voiceAvatar}><PlatformIcon name="voice" size={22}/></span><span><strong>{voice.name}</strong><small>{voice.category === "cloned" ? "Giọng cá nhân" : "Giọng Maziao"}</small></span>{selected === voice.voiceId && <PlatformIcon name="check" size={19}/>}</button>)}</div> : <p className={styles.muted}>Chưa có giọng được cấp quyền trong nhóm này. {isAdmin ? "Hãy làm mới danh sách Maziao." : "Quản trị viên sẽ chọn giọng phù hợp cho bạn."}</p>}
            {selectedVoice?.previewUrl && <audio controls className={styles.player} src={selectedVoice.previewUrl}>Trình duyệt chưa hỗ trợ nghe thử.</audio>}
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>02</span><h2>Nhập lời thoại</h2></div><span className={styles.counter}>{text.length.toLocaleString("vi-VN")} / {MAX_SCRIPT.toLocaleString("vi-VN")}</span></div>
            <textarea aria-label="Nội dung lời thoại" className={styles.textarea} value={text} maxLength={MAX_SCRIPT} placeholder="Nhập nội dung cần chuyển thành giọng nói tại đây…" onChange={e => { setText(e.target.value); setAudio(null); setAudioSrc(""); }} />
            <div className={styles.scriptFooter}><label className={styles.upload}><PlatformIcon name="plus" size={18}/> Tải kịch bản lên<input ref={fileInput} type="file" accept={scriptTypes} onChange={e => { const file=e.target.files?.[0]; if(file) void readScript(file); e.target.value=""; }}/></label><Link href="/cong-cu/kich-ban-ai" className={styles.scriptLink}>Chưa có kịch bản? Tạo bằng AI <PlatformIcon name="arrow" size={16}/></Link></div>
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>03</span><h2>Tạo và tải giọng đọc</h2></div></div>
            <p className={styles.muted}>Chi phí AI sẽ tính theo số ký tự và tác vụ thực tế. Lời thoại dưới 100 ký tự có thể bị Maziao từ chối ở model Vieten.</p>
            <button className={styles.generate} onClick={() => void generate()} disabled={Boolean(busy) || !selected || !text.trim()}>{busy === "speech" ? "Đang tạo giọng, vui lòng chờ…" : "Tạo giọng nói AI"} <PlatformIcon name="arrow" size={19}/></button>
            {audio && <div className={styles.result}><strong>Đã tạo lời đọc • {audio.duration.toFixed(1)} giây</strong><div className={styles.resultButtons}><button onClick={() => void downloadAudio(false)} disabled={Boolean(busy)}>Nghe lời đọc</button><button onClick={() => void downloadAudio(true)} disabled={Boolean(busy)}>Tải MP3 / WAV</button></div>{audioSrc && <audio controls src={audioSrc} className={styles.player}/>}<p className={styles.muted}>Nếu mất mạng khi tải, bấm lại để nhận chính tệp đã tạo, không gửi lại Maziao.</p></div>}
          </section>
        </div>
        <aside className={styles.sidebar}>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>04</span><h2>Cấu hình âm thanh</h2></div></div>
            {([{ label: "Tốc độ", value: speed, set: setSpeed, min: 0.8, max: 1.2 }, { label: "Âm lượng", value: volume, set: setVolume, min: 0.5, max: 1.5 }, { label: "Cao độ", value: pitch, set: setPitch, min: 0.8, max: 1.2 }] as const).map(setting => <label className={styles.slider} key={setting.label}><span><strong>{setting.label}</strong><output>{setting.value.toFixed(2)}{setting.label === "Tốc độ" ? "x" : ""}</output></span><input type="range" min={setting.min} max={setting.max} step="0.05" value={setting.value} onChange={e => setting.set(Number(e.target.value))}/></label>)}
            <button className={styles.reset} onClick={() => { setSpeed(1); setVolume(1); setPitch(1); }}>Đặt lại mặc định</button>
          </section>
          <section className={styles.card}>
            <div className={styles.sectionHeading}><div><span className={styles.step}>05</span><h2>Nhân bản giọng</h2></div></div>
            <p className={styles.muted}>{isAdmin ? "Tài khoản quản trị không giới hạn số lần clone, vẫn áp dụng hạn mức AI." : "Mỗi tài khoản thành viên mặc định có 3 lượt nhân bản giọng."}</p>
            <div className={styles.quota}>{isAdmin ? "Không giới hạn lượt clone" : cloning ? "Đã dùng " + cloning.used + " / " + cloning.limit + " lượt" : "Kiểm tra hạn mức tại trang cá nhân"}</div>
            <label className={styles.field}>Tên giọng<input value={cloneName} onChange={e => setCloneName(e.target.value)} placeholder="Ví dụ: Giọng của tôi"/></label>
            <label className={styles.field}>Loại giọng<select value={cloneGender} onChange={e => setCloneGender(e.target.value as "female"|"male")}><option value="female">Giọng nữ</option><option value="male">Giọng nam</option></select></label>
            <label className={styles.uploadBlock}>Chọn mẫu giọng MP3, WAV, M4A (3–8 giây)<input type="file" accept="audio/*" onChange={e => setCloneFile(e.target.files?.[0] || null)}/></label>
            <label className={styles.consent}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> Tôi sở hữu giọng nói này hoặc được chủ giọng đồng ý nhân bản.</label>
            <button className={styles.cloneButton} disabled={Boolean(busy) || !consent || !cloneName.trim() || !cloneFile || (!isAdmin && cloning?.remaining === 0)} onClick={() => void clone()}>{busy === "clone" ? "Đang nhân bản…" : "Nhân bản giọng nói"}</button>
          </section>
        </aside>
      </div>
      {isAdmin && <section className={styles.card}><div className={styles.sectionHeading}><div><span className={styles.step}>ADMIN</span><h2>Giọng dùng chung cho tất cả thành viên</h2></div></div><p className={styles.muted}>Bật một lần tại đây để mọi tài khoản thành viên nhìn thấy giọng đó. Bạn có thể chia sẻ cả giọng Maziao hệ thống và các giọng do chính tài khoản quản trị nhân bản. Giọng clone của thành viên khác vẫn luôn riêng tư.</p><div className={styles.catalogGrid}>{voices.map(voice => { const enabled=curated.some(item => item.voice_id === voice.voiceId && item.enabled); const isClone=voice.category === "cloned"; return <label className={styles.catalogRow} key={voice.voiceId}><span><strong>{voice.name}</strong><small>{isClone ? "Giọng nhân bản của quản trị viên" : "Giọng hệ thống Maziao"} · {enabled ? "Đang dùng chung" : "Chưa chia sẻ"}</small></span><input type="checkbox" checked={enabled} disabled={Boolean(catalogBusy)} onChange={e => void approve(voice,e.target.checked)}/></label>; })}</div></section>}
    </>}
  </main>;
}
