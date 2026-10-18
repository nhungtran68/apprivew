"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { getVisibleModules, moduleHref } from "@/lib/studio-modules";
import { PlatformIcon } from "./PlatformIcon";
import styles from "./Platform.module.css";

const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLocaleLowerCase("vi");

export function ToolSearch() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const listId = useId();
  const searchTerm = normalize(query.trim());
  const results = getVisibleModules()
    .filter(module => normalize(`${module.title} ${module.description}`).includes(searchTerm))
    .sort((left, right) => Number(normalize(right.title).includes(searchTerm)) - Number(normalize(left.title).includes(searchTerm)));
  useEffect(() => { setOpen(false); setQuery(""); }, [pathname]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); setOpen(true); }
      if (event.key === "Escape") setOpen(false);
    }
    function outside(event: PointerEvent) { if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false); }
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, []);
  return <div className={styles.search} ref={ref} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <form role="search" onSubmit={event => { event.preventDefault(); if (results[0]) { router.push(moduleHref(results[0])); setOpen(false); input.current?.blur(); } }}>
      <PlatformIcon name="search" size={20} />
      <input ref={input} aria-label="Tìm công cụ AI" aria-controls={open ? listId : undefined} autoComplete="off" placeholder="Tìm công cụ AI…" value={query} onChange={event => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      <kbd aria-hidden="true">Ctrl K</kbd>
    </form>
    {open ? <div className={styles.searchResults} id={listId}>
      <p className={styles.searchCaption} role="status">{query ? `${results.length} công cụ phù hợp` : "Bạn muốn tạo điều gì?"}</p>
      {results.length ? <ul>{results.map(module => <li key={module.id}><Link href={moduleHref(module)} onClick={() => setOpen(false)}><PlatformIcon name={module.icon} size={20} /><span>{module.title}</span><PlatformIcon name="arrow" size={16} /></Link></li>)}</ul> : <div className={styles.searchEmpty}>Chưa tìm thấy công cụ. Thử “video”, “giọng nói” hoặc “ảnh”.</div>}
    </div> : null}
  </div>;
}
