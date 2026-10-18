"use client";

import Link from "next/link";
import { useState } from "react";
import { getVisibleModules, moduleHref } from "@/lib/studio-modules";
import { PlatformIcon } from "./PlatformIcon";
import common from "./Platform.module.css";
import styles from "./Dashboard.module.css";
import tones from "./ModuleTone.module.css";

const filters = [
  { id: "all", title: "Tất cả công cụ" },
  { id: "content", title: "Nội dung" },
  { id: "visual", title: "Hình ảnh & video" },
  { id: "audio", title: "Âm thanh" },
] as const;
const categoryLabels = { audio: "ÂM THANH", video: "VIDEO", content: "NỘI DUNG", image: "HÌNH ẢNH", other: "KHÁM PHÁ" };
// Temporarily hide these dashboard cards while keeping their modules available.
const hiddenHomeModuleIds = new Set(["review", "other"]);

export function ToolCatalog() {
  const [filter, setFilter] = useState<string>("all");
  const modules = getVisibleModules().filter(module => !hiddenHomeModuleIds.has(module.id));
  const visible = modules.filter(module => filter === "all" || (filter === "visual" ? module.category === "video" || module.category === "image" : module.category === filter));
  return <section className={styles.catalog} id="cong-cu" aria-labelledby="catalog-title">
    <div className={common.sectionHeading}><div><h2 id="catalog-title">Bộ công cụ của bạn<span className={common.sectionCount}>{modules.length}</span></h2><p>Chọn công cụ phù hợp. Bắt đầu từ điều bạn muốn tạo.</p></div><span className={styles.catalogNote}><PlatformIcon name="layers" size={16} />Một nơi, nhiều khả năng</span></div>
    <div className={styles.filters} role="group" aria-label="Lọc công cụ theo mục đích">{filters.map(item => <button type="button" key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? styles.filterActive : ""} onClick={() => setFilter(item.id)}>{item.title}</button>)}</div>
    <div className={styles.toolGrid}>
      {visible.map(module => <Link className={`${styles.toolCard} ${tones[module.tone]}`} href={moduleHref(module)} key={module.id} aria-label={`Khám phá ${module.title}`}>
        <div className={styles.toolCardTop}><span className={styles.toolIcon}><PlatformIcon name={module.icon} size={27} /></span><span className={styles.toolCategory}>{categoryLabels[module.category]}</span></div>
        <h3>{module.title}</h3><p>{module.description}</p>
        <div className={styles.toolCardBottom}><span className={styles.toolAction}>Mở công cụ<PlatformIcon name="arrow" size={17} /></span>{module.id === "review" ? <span className={styles.availableBadge}>Có Studio hiện tại</span> : <span className={styles.preparingBadge}>Đang chuẩn bị</span>}</div>
      </Link>)}
    </div>
    <span className="visually-hidden" role="status">Đang hiển thị {visible.length} công cụ.</span>
  </section>;
}
