"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { accountInitials, useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import shared from "./Platform.module.css";
import styles from "./AccountPage.module.css";

const formatNumber = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

export default function AccountPage() {
  const { status, account, message, refresh } = useAccount();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const signOutInFlight = useRef(false);
  const quota = account?.quota;

  async function signOut() {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    setSignOutError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "signout" }),
      });
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error("signout-failed");
      window.location.assign("/dang-nhap");
    } catch {
      setSignOutError("Chưa đăng xuất được. Kiểm tra kết nối và thử lại.");
      signOutInFlight.current = false;
      setSigningOut(false);
    }
  }

  return <div className={styles.page}>
    <header className={shared.pageHeading}>
      <span className={shared.eyebrow}><PlatformIcon name="user" size={14} />Không gian của bạn</span>
      <h1>Cá nhân</h1>
      <p>Quản lý hồ sơ, theo dõi hạn mức sử dụng và thiết lập giọng nói của bạn.</p>
    </header>

    {status === "ready" && account ? <div className={styles.summaryGrid}>
      <section className={`${shared.panel} ${styles.identityCard}`} aria-labelledby="account-name">
        <div className={styles.identityTop}>
          <span className={styles.avatar} aria-hidden="true">{accountInitials(account.name)}</span>
          <span className={styles.role}><PlatformIcon name={account.isAdmin ? "shield" : "user"} size={14} />{account.isAdmin ? "Quản trị viên" : "Thành viên"}</span>
        </div>
        <p className={styles.cardEyebrow}>Hồ sơ tài khoản</p>
        <h2 id="account-name">{account.name}</h2>
        <p className={styles.identityDescription}>Thiết lập thông tin và phong cách để lời kể mang dấu ấn của bạn.</p>
        <Link href="/studio?view=profile" prefetch={false} className={`${shared.secondaryButton} ${styles.profileButton}`}>Chỉnh sửa hồ sơ sáng tạo<PlatformIcon name="arrow" size={18} /></Link>
      </section>

      <section className={`${shared.panel} ${styles.quotaCard}`} aria-labelledby="quota-heading">
        <div className={styles.cardTop}><span className={shared.panelIcon}><PlatformIcon name="spark" /></span><span className={styles.smallLabel}>Hạn mức hiện tại</span></div>
        <h2 id="quota-heading">Lượt sử dụng AI</h2>
        {quota ? <>
          <p className={styles.quotaValue}><strong>{formatNumber(quota.used)}</strong><span>/ {formatNumber(quota.limit)} lượt</span></p>
          {quota.limit > 0 ? <meter className={styles.usageMeter} min={0} max={quota.limit} value={Math.min(quota.used, quota.limit)} aria-label={`Đã dùng ${formatNumber(quota.used)} trên ${formatNumber(quota.limit)} lượt AI`} /> : null}
          <p className={styles.quotaDescription}>Đã dùng {formatNumber(quota.used)} lượt. Còn {formatNumber(Math.max(0, quota.limit - quota.used))} lượt trong hạn mức được cấp.</p>
        </> : <p className={styles.missingQuota}>Chưa có dữ liệu hạn mức cho tài khoản này.</p>}
        <div className={styles.quotaFooter}><span>Hạn mức do quản trị viên cấp.</span><button type="button" className={shared.textLink} onClick={refresh} disabled={signingOut}><PlatformIcon name="refresh" size={15} />Cập nhật</button></div>
      </section>
    </div> : status === "loading" ? <section className={`${shared.panel} ${styles.loadingPanel}`} role="status" aria-live="polite" aria-busy="true">
      <span className={styles.loadingAvatar} aria-hidden="true" />
      <div><h2>Đang tải tài khoản…</h2><p>Thông tin hồ sơ và hạn mức sẽ xuất hiện tại đây.</p></div>
    </section> : <section className={`${shared.panel} ${styles.statePanel}`} role={status === "error" ? "alert" : "status"}>
      <span className={shared.panelIcon}><PlatformIcon name={status === "anonymous" ? "user" : "lock"} /></span>
      <h2>{status === "anonymous" ? "Đăng nhập vào không gian của bạn" : status === "restricted" ? "Tài khoản cần được cấp quyền" : status === "unavailable" ? "Kết nối tài khoản chưa sẵn sàng" : "Chưa tải được thông tin tài khoản"}</h2>
      <p>{status === "anonymous" ? "Đăng nhập để xem hồ sơ và hạn mức sử dụng của tài khoản." : message || "Hãy thử tải lại để cập nhật thông tin của bạn."}</p>
      <div className={styles.stateActions}>{status === "anonymous" ? <Link href="/dang-nhap" className={shared.primaryButton}>Đăng nhập<PlatformIcon name="arrow" size={18} /></Link> : <button type="button" className={shared.secondaryButton} onClick={refresh} disabled={signingOut}><PlatformIcon name="refresh" size={17} />Thử lại</button>}<Link href="/huong-dan" className={shared.textLink}>Xem hướng dẫn<PlatformIcon name="arrow" size={16} /></Link></div>
    </section>}

    <section className={styles.toolsSection} aria-labelledby="personal-tools-heading">
      <div className={shared.sectionHeading}><div><h2 id="personal-tools-heading">Thiết lập của bạn</h2><p>Tiếp tục sử dụng các thiết lập đã có trong Studio.</p></div></div>
      <div className={styles.toolGrid}>
        <Link href="/studio?view=profile" prefetch={false} className={styles.toolCard}><span className={styles.toolIcon}><PlatformIcon name="user" /></span><span><strong>Hồ sơ & phong cách</strong><span>Cập nhật thông tin, sản phẩm và cách bạn muốn kể chuyện.</span></span><PlatformIcon name="arrow" size={19} /></Link>
        <Link href="/studio?view=voices" prefetch={false} className={styles.toolCard}><span className={`${styles.toolIcon} ${styles.voiceIcon}`}><PlatformIcon name="voice" /></span><span><strong>Giọng nói của tôi</strong><span>Mở thư viện giọng nói và quản lý giọng đọc trong Studio.</span></span><PlatformIcon name="arrow" size={19} /></Link>
        {status === "ready" && account?.isAdmin ? <Link href="/quan-tri" className={`${styles.toolCard} ${styles.adminCard}`}><span className={styles.toolIcon}><PlatformIcon name="shield" /></span><span><strong>Trang quản trị</strong><span>Quản lý thành viên, quyền truy cập và hạn mức AI.</span></span><PlatformIcon name="arrow" size={19} /></Link> : null}
      </div>
    </section>

    <section className={`${shared.panel} ${styles.subscriptionCard}`} aria-labelledby="subscription-heading">
      <span className={styles.subscriptionIcon}><PlatformIcon name="layers" size={26} /></span>
      <div><span className={shared.statusPill}>Đang chuẩn bị</span><h2 id="subscription-heading">Gói dịch vụ & lượt sử dụng</h2><p>Khu vực gói dịch vụ và số dư sử dụng sẽ được bổ sung sau. Hiện tại, bạn sử dụng hạn mức AI được cấp cho tài khoản.</p></div>
    </section>

    {(status === "ready" && account || status === "restricted") ? <section className={styles.sessionSection} aria-label="Phiên đăng nhập">
      <div><h2>Phiên đăng nhập</h2><p>Đăng xuất khi bạn dùng xong trên thiết bị này.</p>{signOutError ? <p className={styles.signOutError} role="alert">{signOutError}</p> : null}</div>
      <button type="button" className={`${shared.secondaryButton} ${styles.signOutButton}`} onClick={() => void signOut()} disabled={signingOut} aria-busy={signingOut}><PlatformIcon name={signingOut ? "refresh" : "logout"} size={18} />{signingOut ? "Đang đăng xuất…" : "Đăng xuất"}</button>
    </section> : null}
  </div>;
}
