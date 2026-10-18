import Link from "next/link";
import { PlatformIcon } from "./PlatformIcon";
import shared from "./Platform.module.css";
import styles from "./LibraryPage.module.css";

export default function LibraryPage() {
  return <div className={styles.page}>
    <header className={shared.pageHeading}>
      <span className={shared.eyebrow}><PlatformIcon name="folder" size={14} />Nơi lưu giữ sáng tạo</span>
      <h1>Thư viện</h1>
      <p>Trở lại dự án của bạn và tiếp tục từ nơi đã dừng trong Studio.</p>
    </header>

    <section className={styles.projectCard} aria-labelledby="existing-projects-heading">
      <div className={styles.projectContent}>
        <span className={styles.availableLabel}><span />Đã có trong Studio</span>
        <h2 id="existing-projects-heading">Những câu chuyện<br className={styles.desktopBreak} /> bạn đang thực hiện.</h2>
        <p>Mở danh sách dự án để tiếp tục chỉnh sửa video, lời thoại và giọng đọc đã lưu.</p>
        <Link href="/studio?view=projects" prefetch={false} className={shared.primaryButton}>Mở dự án của tôi<PlatformIcon name="arrow" size={18} /></Link>
      </div>
      <div className={styles.folderArtwork} aria-hidden="true">
        <div className={styles.sheetBack} /><div className={styles.sheetFront}><PlatformIcon name="video" size={34} /><span /><span /></div><div className={styles.folderFront}><PlatformIcon name="folder" size={27} /><span>Dự án của bạn</span><PlatformIcon name="arrow" size={19} /></div>
        <span className={styles.soundBadge}><PlatformIcon name="voice" size={22} /></span>
      </div>
    </section>

    <div className={styles.storageNote}>
      <span className={styles.noteIcon}><PlatformIcon name="shield" size={21} /></span>
      <div><h2>Dự án được lưu trên trình duyệt này</h2><p>Video và dự án hiện được giữ trong trình duyệt trên thiết bị bạn đã sử dụng. Hãy mở đúng trình duyệt, thiết bị và địa chỉ website để tìm lại công việc.</p><p>Bản xem trước dùng địa chỉ riêng nên không chia sẻ dự án đã lưu trên trang đang sử dụng. Bạn có thể tải bản sao dự án từ Studio rồi nhập lại khi cần chuyển nơi làm việc.</p></div>
    </div>

    <section className={styles.futureSection} aria-labelledby="unified-library-heading">
      <div className={shared.sectionHeading}><div><h2 id="unified-library-heading">Thư viện nội dung</h2><p>Một không gian chung cho tài nguyên sáng tạo.</p></div><span className={shared.statusPill}>Đang chuẩn bị</span></div>
      <div className={`${shared.panel} ${styles.futurePanel}`}>
        <div className={styles.mediaIcons} aria-hidden="true"><span><PlatformIcon name="image" size={25} /></span><span><PlatformIcon name="video" size={29} /></span><span><PlatformIcon name="voice" size={25} /></span></div>
        <h3>Hình ảnh, video và âm thanh.<br />Cùng một nơi.</h3>
        <p>Thư viện nội dung chung sẽ được bổ sung để bạn quản lý tài nguyên giữa các công cụ. Trong lúc này, hãy mở Studio để làm việc với dự án và giọng nói hiện có.</p>
        <Link href="/studio?view=voices" prefetch={false} className={shared.textLink}>Mở thư viện giọng nói<PlatformIcon name="arrow" size={17} /></Link>
      </div>
    </section>

    <aside className={styles.helpNote}><PlatformIcon name="help" size={19} /><p>Cần tìm lại dự án hoặc chuyển sang thiết bị khác?</p><Link href="/huong-dan" className={shared.textLink}>Xem hướng dẫn<PlatformIcon name="arrow" size={16} /></Link></aside>
  </div>;
}
