"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { getVisibleModules, moduleHref, type AiModule } from "@/lib/studio-modules";
import { AccountProvider, accountInitials, useAccount } from "./AccountProvider";
import { PlatformIcon, type PlatformIconName } from "./PlatformIcon";
import { ToolSearch } from "./ToolSearch";
import styles from "./Platform.module.css";
import tones from "./ModuleTone.module.css";

function Brand() {
  return <Link href="/" className={styles.brand} aria-label="Lời Kể AI — Trang tổng quan"><span className={styles.brandMark}><PlatformIcon name="spark" size={24} /></span><span>Lời Kể<span className={styles.brandAI}>AI</span></span></Link>;
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { account } = useAccount();
  const navLink = (href: string, label: string, icon: PlatformIconName, tone?: AiModule["tone"]) => <Link href={href} className={`${styles.navLink} ${pathname === href ? styles.navActive : ""} ${tone ? `${styles.moduleNav} ${tones[tone]}` : ""}`} aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}><span className={styles.navIcon}><PlatformIcon name={icon} size={20} /></span><span>{label}</span>{pathname === href ? <span className={styles.activeDot} /> : null}</Link>;
  return <nav className={styles.navigation} aria-label="Điều hướng chính">
    {navLink("/", "Tổng quan", "grid")}
    <p className={styles.navLabel}>CÔNG CỤ SÁNG TẠO</p>
    {getVisibleModules().map(module => <div key={module.id}>{navLink(moduleHref(module), module.shortTitle, module.icon, module.tone)}</div>)}
    <p className={styles.navLabel}>KHÔNG GIAN CỦA BẠN</p>
    {navLink("/thu-vien", "Thư viện của tôi", "folder")}
    {navLink("/ca-nhan", "Tài khoản cá nhân", "user")}
    {navLink("/ca-nhan/nhan-ban-giong", "Nhân bản giọng", "voice")}
    {navLink("/nap-credit", "Nạp credit", "plus")}
    {account?.isAdmin ? navLink("/quan-tri", "Quản trị nền tảng", "shield") : null}
  </nav>;
}

function ShellContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { account, status } = useAccount();
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeDrawer = () => drawer.current?.close();
  useEffect(() => { drawer.current?.close(); }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const closeOnDesktop = () => { if (media.matches) drawer.current?.close(); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  const tool = getVisibleModules().find(module => pathname === moduleHref(module));
  const title = tool?.title || ({ "/": "Tổng quan", "/thu-vien": "Thư viện của tôi", "/ca-nhan": "Tài khoản cá nhân", "/ca-nhan/nhan-ban-giong": "Nhân bản giọng", "/nap-credit": "Nạp credit", "/huong-dan": "Hướng dẫn bắt đầu" }[pathname] || "Không gian sáng tạo");
  return <div className={styles.platform}>
    <a href="#noi-dung-chinh" className={styles.skipLink}>Đến nội dung chính</a>
    <aside className={styles.sidebar}>
      <div className={styles.sidebarBrand}><Brand /><span className={styles.brandTagline}>Sáng tạo cho kinh doanh</span></div>
      <Navigation />
      <div className={styles.sidebarBottom}>
        <div className={styles.studioShortcut}><span className={styles.shortcutIcon}><PlatformIcon name="review" /></span><strong>Ý tưởng thành video</strong><p>Quay, chọn cảnh, viết lời thoại và ghép video trong một công cụ.</p><a href="/cong-cu/video-ai">Mở Tạo Video AI<PlatformIcon name="arrow" size={17} /></a></div>
        <Link href="/huong-dan" className={styles.helpLink}><PlatformIcon name="help" size={20} />Hướng dẫn bắt đầu<PlatformIcon name="chevron" size={15} /></Link>
      </div>
    </aside>
    <div className={styles.mainColumn}>
      <header className={styles.topbar}>
        <div className={styles.mobileBrand}><button ref={menuButton} className={styles.iconButton} type="button" aria-label="Mở menu điều hướng" aria-haspopup="dialog" onClick={() => drawer.current?.showModal()}><PlatformIcon name="menu" /></button><Brand /></div>
        <div className={styles.breadcrumb}><span>Không gian làm việc</span><PlatformIcon name="chevron" size={14} /><strong>{title}</strong></div>
        <ToolSearch />
        {account?.credits ? <Link href="/ca-nhan" className={`${styles.creditBadge} ${account.credits.available === 0 ? styles.creditEmpty : ""}`} aria-label={`Credit khả dụng: ${new Intl.NumberFormat("vi-VN").format(account.credits.available)}. Xem mức trừ credit`}><PlatformIcon name="spark" size={15} /><span>{new Intl.NumberFormat("vi-VN").format(account.credits.available)} credit</span></Link> : null}
        <Link href={status === "anonymous" ? "/dang-nhap" : "/ca-nhan"} className={styles.accountButton} aria-label={status === "anonymous" ? "Đăng nhập tài khoản" : "Mở tài khoản cá nhân"}>
          <span className={styles.avatar}>{accountInitials(account?.name)}</span><span className={styles.accountName}>{account?.name || (status === "anonymous" ? "Đăng nhập" : "Tài khoản")}</span><PlatformIcon name="chevron" size={15} />
        </Link>
      </header>
      <main className={styles.main} id="noi-dung-chinh" tabIndex={-1}>{account?.credits?.available === 0 && pathname !== "/nap-credit" ? <div className={styles.creditNotice} role="status"><strong>Đã hết credit khả dụng.</strong> Tác vụ AI mới đang tạm dừng. <Link href="/nap-credit">Nạp thêm credit</Link></div> : null}{children}</main>
      <footer className={styles.footer}><span><strong>Lời Kể AI</strong> · Từ ý tưởng đến nội dung của bạn.</span><Link href="/huong-dan">Hướng dẫn sử dụng<PlatformIcon name="arrow" size={15} /></Link></footer>
    </div>
    <nav className={styles.bottomNav} aria-label="Điều hướng trên điện thoại">
      {[{ href: "/", label: "Tổng quan", icon: "home" as const }, { href: "/#cong-cu", label: "Công cụ AI", icon: "spark" as const }, { href: "/thu-vien", label: "Thư viện", icon: "folder" as const }, { href: "/ca-nhan", label: "Cá nhân", icon: "user" as const }].map(item => {
        const active = item.href === "/#cong-cu" ? pathname.startsWith("/cong-cu/") : item.href === "/ca-nhan" ? pathname === "/ca-nhan" || pathname.startsWith("/ca-nhan/") : pathname === item.href;
        return <Link key={item.href} href={item.href} className={active ? styles.bottomActive : ""} aria-current={active ? "page" : undefined}><PlatformIcon name={item.icon} size={22} /><span>{item.label}</span></Link>;
      })}
    </nav>
    <dialog ref={drawer} className={styles.drawer} aria-labelledby="menu-title" onClick={event => { if (event.target === event.currentTarget) closeDrawer(); }} onClose={() => menuButton.current?.focus()}>
      <div className={styles.drawerContent}><div className={styles.drawerTop}><h2 id="menu-title">Không gian sáng tạo</h2><button autoFocus type="button" className={styles.iconButton} onClick={closeDrawer} aria-label="Đóng menu điều hướng"><PlatformIcon name="close" /></button></div><Brand /><Navigation onNavigate={closeDrawer} /><Link href="/huong-dan" className={styles.helpLink} onClick={closeDrawer}><PlatformIcon name="help" size={20} />Hướng dẫn bắt đầu</Link></div>
    </dialog>
  </div>;
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return <AccountProvider><ShellContent>{children}</ShellContent></AccountProvider>;
}
