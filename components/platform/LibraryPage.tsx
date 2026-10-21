"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { deleteLibraryAsset, getLibraryAssets, getLibraryAssetUrl, type LibraryAsset } from "@/lib/library-client";
import { PlatformIcon } from "./PlatformIcon";
import shared from "./Platform.module.css";
import styles from "./LibraryPage.module.css";

type Kind = "video" | "audio";

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function duration(value: number | null) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  if (!total) return "";
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

function expiry(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function expiresSoon(iso: string, kind: Kind) {
  const remaining = new Date(iso).getTime() - Date.now();
  const warningDays = kind === "video" ? 1 : 7;
  return remaining > 0 && remaining <= warningDays * 24 * 60 * 60 * 1000;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Thư viện chưa phản hồi. Hãy thử lại.";
}

export default function LibraryPage() {
  const [kind, setKind] = useState<Kind>("video");
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setAssets(await getLibraryAssets()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function showPreview(asset: LibraryAsset) {
    if (preview?.id === asset.id) { setPreview(null); return; }
    setActionId(asset.id); setError("");
    try { setPreview({ id: asset.id, url: await getLibraryAssetUrl(asset.id) }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setActionId(""); }
  }

  async function download(asset: LibraryAsset) {
    setActionId(asset.id); setError("");
    try {
      const url = await getLibraryAssetUrl(asset.id, true);
      const link = document.createElement("a");
      link.href = url;
      link.download = asset.title;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setActionId(""); }
  }

  async function remove(asset: LibraryAsset) {
    if (!window.confirm(`Xóa “${asset.title}” khỏi Thư viện? Tệp sẽ không thể lấy lại.`)) return;
    setActionId(asset.id); setError("");
    try {
      await deleteLibraryAsset(asset.id);
      setAssets(current => current.filter(item => item.id !== asset.id));
      if (preview?.id === asset.id) setPreview(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setActionId(""); }
  }

  const visible = assets.filter(asset => asset.kind === kind);
  const videoCount = assets.filter(asset => asset.kind === "video").length;
  const audioCount = assets.filter(asset => asset.kind === "audio").length;

  return <div className={styles.page}>
    <header className={shared.pageHeading}>
      <span className={shared.eyebrow}><PlatformIcon name="folder" size={14} />Nội dung của bạn</span>
      <h1>Thư viện</h1>
      <p>Xem lại, nghe thử và tải những video, lời đọc đã tạo. Tệp chỉ hiển thị trong tài khoản của bạn.</p>
    </header>
    <div className={styles.tabs} role="group" aria-label="Loại tệp trong thư viện">
      <button type="button" aria-pressed={kind === "video"} className={kind === "video" ? styles.activeTab : ""} onClick={() => { setKind("video"); setPreview(null); }}><PlatformIcon name="video" size={19} />Video <span>{videoCount}</span></button>
      <button type="button" aria-pressed={kind === "audio"} className={kind === "audio" ? styles.activeTab : ""} onClick={() => { setKind("audio"); setPreview(null); }}><PlatformIcon name="voice" size={19} />Âm thanh <span>{audioCount}</span></button>
    </div>
    <section className={styles.content} aria-live="polite">
      <div className={styles.contentHeading}>
        <div><h2>{kind === "video" ? "Video đã tạo" : "Lời đọc đã tạo"}</h2><p>{kind === "video" ? "Video lưu 7 ngày sau khi ghép thành công." : "Âm thanh lưu 30 ngày sau khi tạo thành công."}</p></div>
        <button type="button" className={styles.refresh} onClick={() => void refresh()} disabled={loading || Boolean(actionId)}><PlatformIcon name="refresh" size={17} />Làm mới</button>
      </div>
      {error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => void refresh()}>Thử tải lại</button></div> : null}
      {loading ? <p className={styles.loading} role="status">Đang tải Thư viện…</p> : visible.length ? <div className={styles.grid}>
        {visible.map(asset => <article className={styles.card} key={asset.id}>
          <div className={`${styles.iconBox} ${asset.kind === "audio" ? styles.audioIcon : ""}`}><PlatformIcon name={asset.kind === "video" ? "video" : "voice"} size={23} /></div>
          <div className={styles.cardBody}>
            <h3 title={asset.title}>{asset.title}</h3>
            <p>{[duration(asset.duration_seconds), fileSize(asset.size_bytes)].filter(Boolean).join(" · ")}</p>
            <p className={expiresSoon(asset.expires_at, asset.kind) ? styles.expiring : styles.expiry}><PlatformIcon name="clock" size={14} /> {expiresSoon(asset.expires_at, asset.kind) ? "Sắp hết hạn · " : ""}Tự xóa ngày {expiry(asset.expires_at)}</p>
          </div>
          <div className={styles.cardActions}>
            <button type="button" onClick={() => void showPreview(asset)} disabled={Boolean(actionId)}>{preview?.id === asset.id ? "Đóng" : actionId === asset.id ? "Đang mở…" : asset.kind === "video" ? "Xem" : "Nghe"}</button>
            <button type="button" className={styles.download} onClick={() => void download(asset)} disabled={Boolean(actionId)}>Tải về</button>
            <button type="button" className={styles.delete} onClick={() => void remove(asset)} disabled={Boolean(actionId)} aria-label={`Xóa ${asset.title}`}>Xóa</button>
          </div>
          {preview?.id === asset.id ? <div className={styles.preview}>{asset.kind === "video" ? <video src={preview.url} controls playsInline preload="metadata" /> : <audio src={preview.url} controls preload="metadata" />}</div> : null}
        </article>)}
      </div> : <div className={styles.empty}>
        <span><PlatformIcon name={kind === "video" ? "video" : "voice"} size={28} /></span>
        <h3>{kind === "video" ? "Chưa có video trong Thư viện" : "Chưa có lời đọc trong Thư viện"}</h3>
        <p>{kind === "video" ? "Video mới sẽ được lưu sau khi ghép thành công. Bạn vẫn có thể tải MP4 ngay trên trang tạo video." : "Lời đọc mới sẽ xuất hiện ở đây sau khi tạo thành công."}</p>
        <Link href={kind === "video" ? "/cong-cu/video-ai" : "/cong-cu/giong-noi-ai"} className={shared.primaryButton}>{kind === "video" ? "Tạo Video AI" : "Tạo giọng nói AI"}<PlatformIcon name="arrow" size={17} /></Link>
      </div>}
    </section>
    <aside className={styles.projectNote}><span><PlatformIcon name="folder" size={21} /></span><div><h2>Dự án Studio trên thiết bị này</h2><p>Dự án đã lưu trong Studio vẫn nằm ở trình duyệt và thiết bị đã tạo; chúng chưa đồng bộ vào Thư viện tài khoản.</p><Link href="/studio?view=projects" prefetch={false}>Mở dự án Studio <PlatformIcon name="arrow" size={16} /></Link></div></aside>
  </div>;
}
