import Link from "next/link";
import { getVisibleModules, moduleHref, type AiModule } from "@/lib/studio-modules";
import { PlatformIcon } from "./PlatformIcon";
import tones from "./ModuleTone.module.css";
import styles from "./ModulePage.module.css";

export default function ModulePage({ module }: { module: AiModule }) {
  const isImageModule = module.id === "image";
  const related = getVisibleModules().filter(item => item.id !== module.id).slice(0, 3);

  return (
    <div className={`${styles.page} ${tones[module.tone]}`}>
      <nav aria-label="Đường dẫn" className={styles.breadcrumb}>
        <Link href="/">Tổng quan</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{module.title}</span>
      </nav>

      <header className={styles.heading}>
        <div className={styles.moduleIcon}>
          <PlatformIcon name={module.icon} size={26} />
        </div>
        <div className={styles.headingText}>
          <p className={styles.eyebrow}>KHÔNG GIAN SÁNG TẠO</p>
          <h1>{module.title}</h1>
          <p className={styles.description}>{module.description}</p>
        </div>
        <span className={styles.stage}><span aria-hidden="true" />{isImageModule ? "Đang xây dựng" : "Đang chuẩn bị"}</span>
      </header>

      <section className={styles.workspace} aria-labelledby="workspace-status">
        <div className={styles.preparation}>
          <div className={styles.preparationIcon} aria-hidden="true">
            <PlatformIcon name={module.icon} size={32} />
          </div>
          <p className={styles.sectionLabel}>{isImageModule ? "TẠO ẢNH AI" : "MỘT KHÔNG GIAN RIÊNG CHO CÔNG VIỆC CỦA BẠN"}</p>
          <h2 id="workspace-status">{isImageModule ? "Chức năng đang xây dựng" : `Không gian ${module.title.toLocaleLowerCase("vi")} đang được hoàn thiện`}</h2>
          <p className={styles.preparationText}>{isImageModule ? "Vui lòng quay lại sau." : "Các tính năng bên dưới đang được chuẩn bị để bạn thực hiện công việc trong một quy trình dễ sử dụng."}</p>
          <Link href="/" className={styles.backLink}><span aria-hidden="true">←</span> {isImageModule ? "Quay lại trang chủ" : "Về trang tổng quan"}</Link>
        </div>

        {!isImageModule ? <div className={styles.capabilities}>
          <div className={styles.capabilitiesHeading}>
            <h3>Những tính năng sắp có</h3>
            <span>Định hướng không gian</span>
          </div>
          <div className={styles.capabilityGrid}>
            {module.capabilities.map((capability, index) => (
              <article key={capability.title} className={styles.capability}>
                <span className={styles.capabilityNumber}>0{index + 1}</span>
                <h4>{capability.title}</h4>
                <p>{capability.description}</p>
              </article>
            ))}
          </div>
        </div> : null}
      </section>

      {module.legacy ? (
        <aside className={styles.existingWorkspace} aria-labelledby="existing-workspace-title">
          <div className={styles.existingIcon}><PlatformIcon name={module.icon} size={22} /></div>
          <div>
            <h2 id="existing-workspace-title">Tiếp tục với công cụ hiện có</h2>
            <p>{module.id === "voice" ? "Thư viện và giọng cá nhân của bạn đang có trong Lời Kể Studio." : "Quy trình tạo video review hiện có vẫn sẵn sàng trong Lời Kể Studio."}</p>
          </div>
          <Link href={module.legacy.href} prefetch={false} className={styles.legacyLink}>{module.legacy.label}<span aria-hidden="true">↗</span></Link>
        </aside>
      ) : null}

      {!isImageModule ? <section className={styles.related} aria-labelledby="related-modules-title">
        <div className={styles.relatedHeading}>
          <div><p className={styles.eyebrow}>CÙNG MỘT NỀN TẢNG</p><h2 id="related-modules-title">Khám phá không gian khác</h2></div>
          <Link href="/">Xem tất cả <span aria-hidden="true">→</span></Link>
        </div>
        <div className={styles.relatedGrid}>
          {related.map(item => (
            <Link key={item.id} href={moduleHref(item)} className={`${styles.relatedCard} ${tones[item.tone]}`}>
              <span className={styles.relatedIcon}><PlatformIcon name={item.icon} size={21} /></span>
              <span><strong>{item.title}</strong><span className={styles.relatedNote}>Khám phá không gian</span></span>
              <span className={styles.relatedArrow} aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section> : null}
    </div>
  );
}
