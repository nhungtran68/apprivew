"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cleanupAnalysisMedia, prepareMaziaoVoiceSample, uploadVoiceSamples } from "@/lib/studio-upload";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import styles from "./VoiceClonePage.module.css";

type Voice = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl?: string;
  isPersonalClone?: boolean;
  status?: string;
};
type VoiceProvider = "maziao" | "eleven" | "saydi";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Có lỗi kết nối. Hãy thử lại.";
}

export default function VoiceClonePage() {
  const account = useAccount();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [provider, setProvider] = useState<VoiceProvider | "">("");
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState<"clone" | "delete" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneGender, setCloneGender] = useState<"female" | "male">("female");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const operationInFlight = useRef(false);
  const cloneRequest = useRef<{ file: File; name: string; provider: VoiceProvider; id: string } | null>(null);
  const isAdmin = account.status === "ready" && account.account?.isAdmin === true;
  const personalVoices = voices.filter(voice => voice.category === "cloned" && (isAdmin || voice.isPersonalClone === true));

  const loadVoices = useCallback(async (signal?: AbortSignal) => {
    setListLoading(true);
    try {
      const response = await fetch("/api/voices", { cache: "no-store", signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chưa tải được giọng cá nhân.");
      if (!signal?.aborted) {
        setProvider(["maziao", "eleven", "saydi"].includes(data.provider) ? data.provider : "");
        setVoices(Array.isArray(data.voices) ? data.voices : []);
      }
    } catch (err) {
      if (!signal?.aborted) setError(errorMessage(err));
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (account.status !== "ready") return;
    const controller = new AbortController();
    void loadVoices(controller.signal);
    return () => controller.abort();
  }, [account.status, loadVoices]);

  async function cloneVoice() {
    if (operationInFlight.current || !provider || !cloneName.trim() || !cloneFile || !consent) return;
    operationInFlight.current = true;
    setBusy("clone"); setError(""); setNotice("");
    let paths: string[] = [];
    try {
      if (provider === "saydi" && cloneFile.size > 10 * 1024 * 1024) throw new Error("Mẫu giọng SaydiVoice cần nhỏ hơn 10 MB.");
      const sample = provider === "saydi" ? cloneFile : await prepareMaziaoVoiceSample(cloneFile);
      const uploaded = await uploadVoiceSamples([sample]);
      paths = uploaded.samplePaths;
      const name = cloneName.trim();
      if (!cloneRequest.current || cloneRequest.current.file !== cloneFile || cloneRequest.current.name !== name || cloneRequest.current.provider !== provider)
        cloneRequest.current = { file: cloneFile, name, provider, id: crypto.randomUUID() };
      const response = await fetch("/api/voices", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": cloneRequest.current.id },
        body: JSON.stringify({ name, consent: true, samplePaths: paths, ...(provider === "saydi" ? {} : { gender: cloneGender }) }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (["SAYDI_REJECTED", "SAYDI_RATE_LIMIT", "VOICE_CLONE_FAILED", "VOICE_SAMPLE_TOO_LARGE", "INVALID_VOICE_SAMPLE"].includes(data.code)) cloneRequest.current = null;
        throw new Error(data.error || "Không nhân bản được giọng.");
      }
      cloneRequest.current = null;
      setCloneName(""); setCloneFile(null); setConsent(false);
      if (fileInput.current) fileInput.current.value = "";
      window.dispatchEvent(new Event("studio-credits-changed"));
      await loadVoices();
      const status = typeof data.status === "string" ? data.status : typeof data.voice?.status === "string" ? data.voice.status : "";
      setNotice(provider === "saydi" && status === "processing"
        ? "Mẫu giọng đang được xử lý. Hãy làm mới danh sách sau ít phút để kiểm tra."
        : "Đã nhân bản giọng thành công. Bạn có thể nghe mẫu trong danh sách bên dưới.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (paths.length) await cleanupAnalysisMedia(paths).catch(() => {});
      operationInFlight.current = false;
      setBusy("");
    }
  }

  async function deleteVoice(voice: Voice) {
    if ((provider !== "maziao" && provider !== "saydi") || operationInFlight.current || isAdmin || !voice.isPersonalClone || deleteCandidate !== voice.voiceId) return;
    operationInFlight.current = true;
    setBusy("delete"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/voices/${encodeURIComponent(voice.voiceId)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error(data.error || "Không xóa được giọng này.");
      setDeleteCandidate("");
      setVoices(previous => previous.filter(item => item.voiceId !== voice.voiceId));
      setNotice(`Đã xóa giọng ${voice.name}. Bạn có thể tạo giọng khác.`);
      window.dispatchEvent(new Event("studio-credits-changed"));
      await loadVoices();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      operationInFlight.current = false;
      setBusy("");
    }
  }

  return <div className={styles.page}>
    <Link href="/ca-nhan" className={styles.backLink}><PlatformIcon name="arrow" size={17} />Về trang cá nhân</Link>
    <header className={styles.heading}>
      <span className={styles.eyebrow}><PlatformIcon name="voice" size={17} />GIỌNG CỦA BẠN</span>
      <h1>Nhân bản giọng</h1>
      <p>Tạo giọng AI từ bản thu của chính bạn, sau đó dùng giọng ấy để đọc lời thoại và làm video.</p>
    </header>

    {account.status !== "ready" ? <section className={styles.state} role={account.status === "error" ? "alert" : "status"}>
      <h2>{account.status === "loading" ? "Đang kiểm tra tài khoản…" : account.status === "anonymous" ? "Đăng nhập để nhân bản giọng" : "Tài khoản chưa sẵn sàng"}</h2>
      <p>{account.message || "Đăng nhập để xem và quản lý giọng cá nhân của bạn."}</p>
      {account.status === "anonymous" ? <Link href="/dang-nhap" className={styles.actionLink}>Đăng nhập</Link> : account.status !== "loading" ? <button type="button" className={styles.actionLink} onClick={account.refresh}>Thử lại</button> : null}
    </section> : <>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.success} role="status">{notice}</p> : null}
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="clone-form-title">
          <div className={styles.cardHeading}><span className={styles.icon}><PlatformIcon name="voice" size={22} /></span><div><h2 id="clone-form-title">Tạo giọng cá nhân</h2><p>Chọn bản thu sạch, rõ lời và ít tiếng ồn.</p></div></div>
          {provider === "maziao" ? <p className={styles.hint}>Bản thu cần ít nhất 3 giây; hệ thống dùng tối đa 8 giây đầu để tạo giọng.</p> : provider === "saydi" ? <p className={styles.hint}>Chọn bản thu âm thanh rõ tiếng. Mẫu giọng có thể cần ít phút để xử lý.</p> : null}
          {account.account?.creditRates ? <p className={styles.cost}>Phí nhân bản thành công: <strong>{account.account.creditRates.clone.toLocaleString("vi-VN")} credit</strong></p> : null}
          {provider !== "saydi" && account.account?.voiceCloning ? <p className={styles.limit}>Đã tạo {account.account.voiceCloning.used.toLocaleString("vi-VN")} giọng{account.account.voiceCloning.unlimited ? "" : ` / ${account.account.voiceCloning.limit.toLocaleString("vi-VN")} giọng được phép`}.</p> : null}
          <label className={styles.field} htmlFor="personal-clone-name">Tên giọng<input id="personal-clone-name" value={cloneName} maxLength={100} onChange={event => setCloneName(event.target.value)} placeholder="Ví dụ: Giọng kể của tôi" /></label>
          {provider === "maziao" && <label className={styles.field} htmlFor="personal-clone-gender">Loại giọng<select id="personal-clone-gender" value={cloneGender} onChange={event => setCloneGender(event.target.value as "female" | "male")}><option value="female">Giọng nữ</option><option value="male">Giọng nam</option></select></label>}
          <label className={styles.upload} htmlFor="personal-clone-sample"><strong>Chọn mẫu giọng</strong><span>{provider === "saydi" ? "WAV, MP3, M4A, OGG, FLAC hoặc WebM · tối đa 10 MB" : "MP3, WAV hoặc M4A · tối đa 25 MB"}</span><input ref={fileInput} id="personal-clone-sample" type="file" accept={provider === "saydi" ? "audio/*,video/webm" : "audio/*"} onChange={event => setCloneFile(event.target.files?.[0] || null)} /></label>
          {cloneFile ? <p className={styles.selectedFile}>Đã chọn: <strong>{cloneFile.name}</strong></p> : null}
          <label className={styles.consent}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>Đây là giọng của tôi hoặc tôi được chủ giọng đồng ý nhân bản và sử dụng.</span></label>
          <button type="button" className={styles.submit} disabled={Boolean(busy) || !provider || !consent || !cloneName.trim() || !cloneFile} aria-busy={busy === "clone"} onClick={() => void cloneVoice()}>{busy === "clone" ? "Đang nhân bản giọng…" : "Nhân bản giọng nói"}</button>
        </section>

        <section className={styles.card} aria-labelledby="personal-voices-title">
          <div className={styles.listHeading}><div><h2 id="personal-voices-title">Giọng đã tạo</h2><p>Nghe lại bản mẫu trước khi dùng hoặc thay giọng.</p></div><button type="button" className={styles.refresh} onClick={() => { setError(""); void loadVoices(); }} disabled={listLoading || Boolean(busy)}><PlatformIcon name="refresh" size={17} />Làm mới</button></div>
          {listLoading && !voices.length ? <p className={styles.empty} role="status">Đang tải giọng cá nhân…</p> : personalVoices.length ? <ul className={styles.voiceList}>{personalVoices.map(voice => <li className={styles.voiceItem} key={voice.voiceId}>
            <div className={styles.voiceName}><span className={styles.voiceAvatar}><PlatformIcon name="voice" size={20} /></span><strong>{voice.name}</strong></div>
            {voice.status === "processing" ? <p className={styles.noPreview}>Giọng đang xử lý. Hãy làm mới danh sách sau ít phút.</p> : voice.status === "failed" ? <p className={styles.noPreview}>Chưa nhân bản thành công. Hãy thử một bản thu khác.</p> : voice.previewUrl ? <audio controls preload="none" className={styles.player} aria-label={`Nghe thử ${voice.name}`} src={voice.previewUrl}>Trình duyệt chưa hỗ trợ phát âm thanh.</audio> : <p className={styles.noPreview}>Chưa có bản nghe thử. Hãy bấm Làm mới sau ít phút.</p>}
            {(provider === "maziao" || provider === "saydi") && !isAdmin && voice.isPersonalClone ? deleteCandidate === voice.voiceId ? <div className={styles.deleteConfirm} role="group" aria-label={`Xác nhận xóa giọng ${voice.name}`}><p>Xóa hẳn giọng này? Bạn sẽ không thể khôi phục.</p><div><button type="button" onClick={() => setDeleteCandidate("")} disabled={Boolean(busy)}>Giữ giọng</button><button type="button" className={styles.deleteFinal} onClick={() => void deleteVoice(voice)} disabled={Boolean(busy)}>{busy === "delete" ? "Đang xóa…" : "Xác nhận xóa"}</button></div></div> : <button type="button" className={styles.deleteTrigger} onClick={() => setDeleteCandidate(voice.voiceId)} disabled={Boolean(busy)}>Xóa giọng để tạo giọng khác</button> : null}
          </li>)}</ul> : <p className={styles.empty}>{listLoading ? "Đang tải giọng cá nhân…" : "Bạn chưa có giọng cá nhân. Hãy tạo giọng đầu tiên bằng mẫu của bạn."}</p>}
          <Link href="/cong-cu/giong-noi-ai" className={styles.useVoice}>Dùng giọng để tạo âm thanh<PlatformIcon name="arrow" size={17} /></Link>
        </section>
      </div>
    </>}
  </div>;
}
