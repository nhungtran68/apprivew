import Link from "next/link";
import { PlatformIcon } from "./PlatformIcon";
import { ToolCatalog } from "./ToolCatalog";
import common from "./Platform.module.css";
import styles from "./Dashboard.module.css";

function CreativeIllustration() {
  return <div className={styles.heroVisual} aria-hidden="true">
    <div className={styles.orbitOne} /><div className={styles.orbitTwo} /><div className={styles.visualDot} />
    <div className={styles.scriptTile}><span><PlatformIcon name="script" size={16} />Ý tưởng mới</span><strong>Câu chuyện<br />của thương hiệu.</strong><i /><i /><i /></div>
    <div className={styles.posterTile}><div className={styles.posterTop}><span>LỜI KỂ STUDIO</span><PlatformIcon name="spark" size={16} /></div><div className={styles.posterSun} /><div className={styles.productBottle}><div /><span>mộc<span>TỰ NHIÊN MỖI NGÀY</span></span></div><div className={styles.posterBottom}>Mỗi sản phẩm,<br /><strong>một câu chuyện.</strong></div></div>
    <div className={styles.voiceTile}><span><PlatformIcon name="voice" size={19} /></span><div className={styles.wave}>{[10, 20, 12, 28, 36, 22, 14, 30, 40, 22, 32, 16, 24, 12, 20].map((height, index) => <i key={index} style={{ height }} />)}</div><span className={styles.voiceTileLabel}>Giọng kể của bạn</span></div>
    <span className={styles.floatingSpark}><PlatformIcon name="spark" size={27} /></span>
  </div>;
}

export function Dashboard() {
  return <>
    <div className={`${common.pageHeading} ${styles.dashboardHeading}`}><div><span className={common.eyebrow}>KHÔNG GIAN SÁNG TẠO</span><h1><span className={styles.desktopTitle}>Hôm nay, bạn muốn tạo điều gì?</span><span className={styles.mobileTitle}>Bạn muốn tạo điều gì?</span></h1><p>Mang ý tưởng đến gần khách hàng hơn cùng Lời Kể AI.</p></div><span className={styles.audienceLabel}><span />Dành cho người kinh doanh online</span></div>
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroContent}><span className={styles.heroEyebrow}><PlatformIcon name="spark" size={16} />TRỢ THỦ SÁNG TẠO CỦA BẠN</span><h2 id="hero-title">Ý tưởng của bạn.<br /><span>Sức mạnh của AI.</span></h2><p>Từ nội dung, hình ảnh đến giọng nói và video.<br className={styles.desktopBreak} /> Một không gian cho hành trình kinh doanh của bạn.</p><div className={styles.heroActions}><a href="#cong-cu" className={styles.heroPrimary}><span className={styles.desktopTitle}>Khám phá công cụ</span><span className={styles.mobileTitle}>Chọn công cụ</span><PlatformIcon name="arrow" size={18} /></a><a href="/studio" className={styles.heroSecondary}><PlatformIcon name="review" size={18} /><span className={styles.desktopTitle}>Mở Studio video</span><span className={styles.mobileTitle}>Mở Studio</span></a></div><div className={styles.heroFootnote}><span /><span>Studio video hiện tại đã sẵn sàng sử dụng</span></div></div>
      <CreativeIllustration />
    </section>
    <ToolCatalog />
    <section className={styles.workspaceSection} aria-labelledby="workspace-title"><div className={common.sectionHeading}><div><h2 id="workspace-title">Tiếp nối hành trình sáng tạo</h2><p>Những lối tắt cho công việc của bạn.</p></div></div><div className={styles.workspaceGrid}>
      <a href="/studio?view=projects" className={styles.workspaceCard}><span className={styles.workspaceIcon}><PlatformIcon name="folder" size={24} /></span><div><h3>Dự án video của tôi</h3><p>Mở lại các dự án đã lưu trên thiết bị này.</p><span>Đi đến dự án<PlatformIcon name="arrow" size={16} /></span></div></a>
      <Link href="/huong-dan" className={`${styles.workspaceCard} ${styles.guideCard}`}><span className={styles.workspaceIcon}><PlatformIcon name="help" size={24} /></span><div><h3>Bắt đầu cùng Lời Kể AI</h3><p>Tìm đúng công cụ cho ý tưởng và sản phẩm của bạn.</p><span>Xem hướng dẫn<PlatformIcon name="arrow" size={16} /></span></div></Link>
    </div></section>
  </>;
}
