"use client";
import Link from "next/link";
import styles from "@/components/platform/Platform.module.css";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <section className={styles.panel} role="alert"><div className={styles.pageHeading}><span className={styles.eyebrow}>KẾT NỐI GIÁN ĐOẠN</span><h1>Chưa mở được trang này</h1><p>Vui lòng thử tải lại hoặc quay về trang tổng quan.</p></div><button className={styles.primaryButton} onClick={reset}>Thử lại</button>{" "}<Link className={styles.secondaryButton} href="/">Về tổng quan</Link></section>;
}
