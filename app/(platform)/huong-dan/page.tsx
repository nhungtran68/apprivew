import type { Metadata } from "next";
import Link from "next/link";
import { getVisibleModules, moduleHref } from "@/lib/studio-modules";
import { PlatformIcon } from "@/components/platform/PlatformIcon";
import common from "@/components/platform/Platform.module.css";
import styles from "@/components/platform/Guide.module.css";

export const metadata: Metadata = { title: "Hướng dẫn bắt đầu | Lời Kể AI" };

export default function Guide() {
  return <>
    <div className={common.pageHeading}><span className={common.eyebrow}>CÙNG BẠN BẮT ĐẦU</span><h1>Từ ý tưởng đầu tiên.</h1><p>Một vài gợi ý để bạn tìm đúng không gian sáng tạo và tiếp tục công việc đang làm.</p></div>
    <section className={styles.startCard}><span className={styles.startIcon}><PlatformIcon name="review" size={30} /></span><div><span className={common.statusPill}>Đang sử dụng được</span><h2>Bắt đầu với Studio video</h2><p>Quay hoặc tải video, viết lời kể, chọn giọng đọc và ghép thành video. Các chức năng hiện tại vẫn nằm trong Studio của bạn.</p><div className={styles.actions}><a href="/studio" className={common.primaryButton}>Mở Studio video<PlatformIcon name="arrow" size={18} /></a><a href="/studio?view=guide" className={common.secondaryButton}>Xem hướng dẫn Studio</a></div></div></section>
    <section className={styles.guideSection} aria-labelledby="guide-tools"><div className={common.sectionHeading}><div><h2 id="guide-tools">Chọn công cụ theo việc bạn cần</h2><p>Các không gian chuyên biệt đang được hoàn thiện từng bước.</p></div></div><div className={styles.toolGuide}>{getVisibleModules().map(module => <Link key={module.id} href={moduleHref(module)}><span><PlatformIcon name={module.icon} /></span><div><h3>{module.title}</h3><p>{module.description}</p></div><PlatformIcon name="chevron" size={18} /></Link>)}</div></section>
    <section className={styles.guideSection} aria-labelledby="questions-title"><div className={common.sectionHeading}><div><h2 id="questions-title">Có thể bạn đang thắc mắc</h2></div></div><div className={styles.questions}>
      <details><summary>Tôi có thể dùng những chức năng nào ngay bây giờ?<PlatformIcon name="plus" size={18} /></summary><p>Studio video, tạo kịch bản, tạo giọng nói và các công cụ đang hiển thị trong trang tổng quan đều có lối vào riêng. Tác vụ AI cần tài khoản còn đủ credit và dịch vụ tương ứng đang hoạt động.</p></details>
      <details><summary>Các dự án video cũ của tôi nằm ở đâu?<PlatformIcon name="plus" size={18} /></summary><p>Mở “Thư viện của tôi” rồi chọn “Mở dự án của tôi”. Dự án được lưu trong trình duyệt trên thiết bị đã tạo video. Hãy dùng đúng thiết bị, trình duyệt và địa chỉ website đã sử dụng trước đây; bản xem trước và website chính có kho lưu riêng.</p></details>
      <details><summary>Tôi xem số dư và mức trừ ở đâu?<PlatformIcon name="plus" size={18} /></summary><p>Trang “Tài khoản cá nhân” hiển thị credit khả dụng và mức trừ cho từng tác vụ. Chọn “Chỉnh sửa hồ sơ sáng tạo” để cập nhật phong cách nội dung trong Studio.</p></details>
      <details><summary>Mở công cụ hoặc xem trước có trừ credit không?<PlatformIcon name="plus" size={18} /></summary><p>Mở trang công cụ và xem lại kết quả đã tạo không trừ credit. Khi bạn yêu cầu AI tạo nội dung hoặc xử lý video, hệ thống tính theo từng tác vụ và dừng nếu không đủ credit.</p></details>
    </div></section>
    <div className={styles.guideFooter}><PlatformIcon name="user" size={23} /><div><h3>Không gian mang dấu ấn của bạn</h3><p>Thông tin và phong cách sáng tạo được quản lý trong tài khoản cá nhân.</p></div><Link href="/ca-nhan" className={common.secondaryButton}>Mở tài khoản<PlatformIcon name="arrow" size={17} /></Link></div>
  </>;
}
