import styles from "@/components/platform/Platform.module.css";

export default function Loading() {
  return <section className={styles.panel} role="status" aria-live="polite"><span className={styles.eyebrow}>LỜI KỂ AI</span><h2>Đang mở không gian của bạn…</h2><p>Vui lòng chờ trong giây lát.</p></section>;
}
