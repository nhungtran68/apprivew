"use client";

import { useState, type FormEvent } from "react";
import styles from "./PixabayVideoPicker.module.css";

type PixabayVideo = {
  id: number;
  tags: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  thumbnail: string;
  videoUrl: string;
  pageUrl: string;
  user: string;
};

type SearchResult = { videos?: PixabayVideo[]; hasMore?: boolean; error?: string };

function durationLabel(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

async function errorFrom(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({})) as { error?: string };
  return data.error || fallback;
}

export default function PixabayVideoPicker({ onSelect, disabled = false }: { onSelect: (file: File) => Promise<void> | void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [videos, setVideos] = useState<PixabayVideo[]>([]);
  const [preview, setPreview] = useState<PixabayVideo | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (term.length < 2) { setError("Nhập ít nhất 2 ký tự để tìm cảnh phù hợp."); return; }
    setSearching(true);
    setError("");
    setPreview(null);
    try {
      const response = await fetch(`/api/pixabay/videos?q=${encodeURIComponent(term)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorFrom(response, "Chưa tìm được cảnh Pixabay. Hãy thử lại."));
      const result = await response.json() as SearchResult;
      setVideos((result.videos || []).filter(video => Number.isFinite(video.duration) && video.duration >= 2 && video.duration <= 90));
      setLastQuery(term);
      setSearched(true);
    } catch (cause) {
      setVideos([]);
      setSearched(true);
      setError(cause instanceof Error ? cause.message : "Chưa tìm được cảnh Pixabay. Hãy thử lại.");
    } finally {
      setSearching(false);
    }
  }

  async function useVideo(video: PixabayVideo) {
    if (loadingVideo || disabled) return;
    setLoadingVideo(true);
    setError("");
    try {
      const response = await fetch("/api/pixabay/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: video.id, quality: video.size > 60 * 1024 * 1024 ? "small" : "medium" }),
      });
      if (!response.ok) throw new Error(await errorFrom(response, "Chưa tải được cảnh đã chọn."));
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 60 * 1024 * 1024) throw new Error("Cảnh này lớn hơn 60 MB. Hãy chọn cảnh khác.");
      const blob = await response.blob();
      if (!blob.size || blob.size > 60 * 1024 * 1024) throw new Error("Cảnh này chưa phù hợp để xuất video. Hãy chọn cảnh khác.");
      await onSelect(new File([blob], `pixabay-${video.id}.mp4`, { type: "video/mp4" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chưa dùng được cảnh này. Hãy thử cảnh khác.");
    } finally {
      setLoadingVideo(false);
    }
  }

  return <section className={styles.panel} aria-labelledby="pixabay-picker-title">
    <div className={styles.heading}>
      <div>
        <span className={styles.eyebrow}>Thư viện cảnh minh họa</span>
        <h2 id="pixabay-picker-title">Tạo video từ Pixabay</h2>
        <p>Tìm một video có sẵn để làm nền cho lời kể của bạn. Sau khi chọn cảnh, hãy nhập ý muốn chia sẻ và chọn dạng kịch bản.</p>
      </div>
      <span className={styles.mark}>P</span>
    </div>

    <form className={styles.search} onSubmit={search}>
      <label htmlFor="pixabay-query">Tìm cảnh theo chủ đề</label>
      <div className={styles.searchRow}>
        <input id="pixabay-query" value={query} onChange={event => setQuery(event.target.value)} maxLength={80} placeholder="Ví dụ: đóng gói hàng, quán cà phê…" disabled={searching || loadingVideo || disabled} />
        <button type="submit" disabled={searching || loadingVideo || disabled}>{searching ? "Đang tìm…" : "Tìm video"}</button>
      </div>
    </form>

    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {searched && !error && !videos.length ? <p className={styles.empty}>Chưa tìm thấy cảnh phù hợp cho “{lastQuery}”. Hãy thử từ khóa ngắn hơn.</p> : null}

    {videos.length ? <>
      <div className={styles.resultHeading}><strong>Cảnh phù hợp</strong><span>Chọn một cảnh để xem trước</span></div>
      <div className={styles.grid}>
        {videos.map(video => <button key={video.id} type="button" className={`${styles.card} ${preview?.id === video.id ? styles.selected : ""}`} onClick={() => setPreview(video)} disabled={loadingVideo || disabled} aria-pressed={preview?.id === video.id}>
          <span className={styles.thumbnail}>
            {/* Pixabay returns thumbnail URLs for its own search results. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={video.thumbnail} alt="" loading="lazy" />
            <span className={styles.duration}>{durationLabel(video.duration)}</span>
          </span>
          <span className={styles.cardText}><strong>{video.tags || `Video #${video.id}`}</strong><small>Pixabay · {video.user || "Tác giả"}</small></span>
        </button>)}
      </div>
    </> : null}

    {preview ? <div className={styles.preview}>
      <video key={preview.id} src={preview.videoUrl} poster={preview.thumbnail} controls playsInline preload="metadata" aria-label={`Xem trước ${preview.tags}`} />
      <div className={styles.previewDetails}>
        <div><strong>{preview.tags || "Cảnh đã chọn"}</strong><span>{durationLabel(preview.duration)} · {preview.width} × {preview.height}</span></div>
        <button type="button" onClick={() => void useVideo(preview)} disabled={loadingVideo || disabled}>{loadingVideo ? "Đang chuẩn bị…" : "Dùng cảnh này"}</button>
      </div>
      <p>Cảnh kho chỉ để minh họa, không thay cho hình ảnh thật hoặc bằng chứng về sản phẩm. <a href={preview.pageUrl} target="_blank" rel="noopener noreferrer">Xem nguồn trên Pixabay</a></p>
    </div> : null}

    <p className={styles.credit}>Video có sẵn từ <a href="https://pixabay.com/videos/" target="_blank" rel="noopener noreferrer">Pixabay</a>. Bạn sẽ tự duyệt cảnh trước khi dùng.</p>
  </section>;
}
