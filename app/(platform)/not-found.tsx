import Link from "next/link";
import { PlatformIcon } from "@/components/platform/PlatformIcon";
import styles from "@/components/platform/Platform.module.css";

export default function NotFound() {
  return <section className={styles.panel}><span className={styles.panelIcon}><PlatformIcon name="search" /></span><div className={styles.pageHeading}><span className={styles.eyebrow}>KHÔNG TÌM THẤY CÔNG CỤ</span><h1>Không gian này chưa có sẵn</h1><p>Công cụ có thể chưa được mở hoặc đường dẫn đã thay đổi. Khám phá các công cụ đang hiển thị trên trang tổng quan.</p></div><Link className={styles.primaryButton} href="/">Về tổng quan<PlatformIcon name="arrow" size={18} /></Link></section>;
}
