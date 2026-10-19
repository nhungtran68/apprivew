"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { accountInitials, useAccount, type CreditRates } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import shared from "./Platform.module.css";
import styles from "./AccountPage.module.css";

const formatNumber = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
const creditItems: { key: keyof CreditRates; title: string; unit: string }[] = [
  { key: "script", title: "Viết hoặc tạo lại kịch bản", unit: "mỗi lần tạo" },
  { key: "analyze", title: "Phân tích video", unit: "mỗi lần phân tích" },
  { key: "scenePlan", title: "AI chọn phân cảnh", unit: "mỗi lần tìm cảnh theo kịch bản" },
  { key: "ttsPer100Chars", title: "Tạo giọng nói", unit: "mỗi 100 ký tự, làm tròn lên" },
  { key: "clone", title: "Nhân bản giọng", unit: "mỗi giọng tạo thành công" },
  { key: "stockPer2MiB", title: "Lấy video thư viện", unit: "mỗi 2 MiB dữ liệu, làm tròn lên" },
];

export default function AccountPage() {
  const { status, account, message, refresh } = useAccount();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const signOutInFlight = useRef(false);
  const credits = account?.credits;
  const rates = account?.creditRates;

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
      <p>Quản lý hồ sơ, xem số dư credit và mức trừ của từng công cụ.</p>
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

      <section className={`${shared.panel} ${styles.quotaCard}`} aria-labelledby="credits-heading">
        <div className={styles.cardTop}><span className={shared.panelIcon}><PlatformIcon name="spark" /></span><span className={styles.smallLabel}>Ví sử dụng</span></div>
        <h2 id="credits-heading">Credit khả dụng</h2>
        {credits ? <>
          <p className={styles.quotaValue}><strong>{formatNumber(credits.available)}</strong><span>credit</span></p>
          <div className={styles.creditDetails}><span>Số dư: <strong>{formatNumber(credits.balance)}</strong></span><span>Đang giữ cho tác vụ: <strong>{formatNumber(credits.reserved)}</strong></span></div>
          {credits.available === 0 ? <p className={styles.exhausted} role="status">Bạn đã hết credit khả dụng. Các tác vụ AI sẽ tạm dừng cho đến khi nạp thêm credit.</p> : <p className={styles.quotaDescription}>Mỗi tác vụ trừ credit theo bảng bên dưới khi thực hiện thành công.</p>}
        </> : <p className={styles.missingQuota}>Chưa tải được số dư credit. Hãy cập nhật lại trước khi tạo nội dung.</p>}
        <Link href="/nap-credit" className={`${shared.primaryButton} ${styles.topUpButton}`}><PlatformIcon name="plus" size={18} />Nạp credit</Link>
        <div className={styles.quotaFooter}><span>Credit nạp qua payOS hoặc do quản trị viên cấp.</span><button type="button" className={shared.textLink} onClick={refresh} disabled={signingOut}><PlatformIcon name="refresh" size={15} />Cập nhật số dư</button></div>
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
        {status === "ready" && account?.isAdmin ? <Link href="/quan-tri" className={`${styles.toolCard} ${styles.adminCard}`}><span className={styles.toolIcon}><PlatformIcon name="shield" /></span><span><strong>Trang quản trị</strong><span>Quản lý thành viên, quyền truy cập và cấp credit.</span></span><PlatformIcon name="arrow" size={19} /></Link> : null}
      </div>
    </section>

    <section className={`${shared.panel} ${styles.subscriptionCard}`} aria-labelledby="subscription-heading">
      <span className={styles.subscriptionIcon}><PlatformIcon name="layers" size={26} /></span>
      <div className={styles.rateContent}><h2 id="subscription-heading">Mức trừ credit</h2><p>Các bước AI trong cùng một video được cộng theo từng mục. Xem trước nội dung đã tạo không trừ thêm credit.</p>
        {rates ? <ul className={styles.rateList}>{creditItems.map(item => <li key={item.key}><span><strong>{item.title}</strong><small>{item.unit}</small></span><b>{formatNumber(rates[item.key])} credit</b></li>)}</ul> : <p className={styles.missingRates}>Chưa tải được bảng mức trừ. Vui lòng cập nhật số dư để xem giá hiện hành.</p>}
        <p className={styles.rateFootnote}>Tạo giọng và lấy video thư viện có mức trừ tăng theo độ dài hoặc dung lượng thực tế. Đoạn giọng phải tạo lại được tính thêm. Tác vụ xác nhận thất bại được hoàn credit; tác vụ mất kết nối cần đối soát trước.</p>
      </div>
    </section>

    {(status === "ready" && account || status === "restricted") ? <section className={styles.sessionSection} aria-label="Phiên đăng nhập">
      <div><h2>Phiên đăng nhập</h2><p>Đăng xuất khi bạn dùng xong trên thiết bị này.</p>{signOutError ? <p className={styles.signOutError} role="alert">{signOutError}</p> : null}</div>
      <button type="button" className={`${shared.secondaryButton} ${styles.signOutButton}`} onClick={() => void signOut()} disabled={signingOut} aria-busy={signingOut}><PlatformIcon name={signingOut ? "refresh" : "logout"} size={18} />{signingOut ? "Đang đăng xuất…" : "Đăng xuất"}</button>
    </section> : null}
  </div>;
}
