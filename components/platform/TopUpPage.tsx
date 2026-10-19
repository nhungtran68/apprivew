"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "./AccountProvider";
import { PlatformIcon } from "./PlatformIcon";
import shared from "./Platform.module.css";
import styles from "./TopUpPage.module.css";

type Pack = { id: string; name: string; credits: number; priceVnd: number; description: string };
type Order = { orderCode: string | number; status: string; credits: number; priceVnd: number; credited: boolean };

const number = new Intl.NumberFormat("vi-VN");
const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

function errorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error.trim()) return data.error;
  return fallback;
}

function isPack(value: unknown): value is Pack {
  if (!value || typeof value !== "object") return false;
  const pack = value as Record<string, unknown>;
  return typeof pack.id === "string" && typeof pack.name === "string" && typeof pack.description === "string" &&
    Number.isSafeInteger(pack.credits) && Number(pack.credits) > 0 && Number.isSafeInteger(pack.priceVnd) && Number(pack.priceVnd) > 0;
}

function orderLabel(order: Order) {
  if (order.credited) return "Đã cộng credit";
  const status = order.status.toUpperCase();
  if (status === "PAID" || status === "SUCCESS" || status === "COMPLETED") return "Đã nhận thanh toán, đang cộng credit";
  if (status === "CANCELLED" || status === "CANCELED") return "Đơn đã hủy";
  if (status === "EXPIRED") return "Đơn đã hết hạn";
  if (status === "FAILED") return "Thanh toán chưa thành công";
  return "Đang chờ thanh toán";
}

function orderMessage(order: Order) {
  if (order.credited) return `${number.format(order.credits)} credit đã được cộng vào ví. Bạn có thể tiếp tục dùng các công cụ AI.`;
  const status = order.status.toUpperCase();
  if (status === "CANCELLED" || status === "CANCELED") return "Đơn này đã hủy. Nếu bạn đã chuyển khoản, hãy bấm Kiểm tra lại; nếu chưa, chọn gói bên dưới để tạo đơn mới.";
  if (status === "EXPIRED") return "Liên kết thanh toán đã hết hạn. Chọn một gói bên dưới để tạo đơn mới.";
  if (status === "FAILED") return "Thanh toán chưa thành công. Bạn có thể chọn lại gói bên dưới.";
  return "Hệ thống sẽ tự kiểm tra và cập nhật số dư khi khoản thanh toán được xác nhận.";
}

function isTerminal(order: Order) {
  return order.credited || ["CANCELLED", "CANCELED", "EXPIRED", "FAILED"].includes(order.status.toUpperCase());
}

export default function TopUpPage() {
  const { status, account } = useAccount();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [paymentReady, setPaymentReady] = useState(false);
  const [loadingPacks, setLoadingPacks] = useState(true);
  const [packsError, setPacksError] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [busyPackId, setBusyPackId] = useState("");
  const [orderCode, setOrderCode] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [orderError, setOrderError] = useState("");
  const [checkingOrder, setCheckingOrder] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [checkAgain, setCheckAgain] = useState(0);
  const checkoutInFlight = useRef(false);
  const checkoutRequest = useRef<{ packId: string; requestId: string } | null>(null);
  const creditedNotice = useRef(new Set<string>());

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("orderCode");
    if (value && /^\d{1,20}$/.test(value)) setOrderCode(value);
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    const controller = new AbortController();
    void (async () => {
      setLoadingPacks(true);
      setPacksError("");
      try {
        const response = await fetch("/api/payments/packs", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(errorMessage(data, "Chưa tải được các gói credit. Hãy thử lại sau."));
        if (!Array.isArray(data.packs) || !data.packs.every(isPack)) throw new Error("Danh sách gói credit chưa sẵn sàng. Hãy thử lại sau.");
        if (!controller.signal.aborted) {
          setPacks(data.packs);
          setPaymentReady(data.paymentReady === true);
        }
      } catch (error) {
        if (!controller.signal.aborted) setPacksError(error instanceof Error ? error.message : "Chưa tải được các gói credit.");
      } finally {
        if (!controller.signal.aborted) setLoadingPacks(false);
      }
    })();
    return () => controller.abort();
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || !orderCode) return;
    let cancelled = false;
    let running = false;
    let checks = 0;
    let ticks = 0;
    let timer: ReturnType<typeof setInterval>;
    setPollingStopped(false);
    setCheckingOrder(true);
    const check = async (reconcile = false) => {
      if (running || cancelled) return;
      running = true;
      checks += 1;
      try {
        const response = await fetch(`/api/payments/orders/${encodeURIComponent(orderCode)}${reconcile ? "/reconcile" : ""}`, { method: reconcile ? "POST" : "GET", credentials: "same-origin", cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(errorMessage(data, "Chưa kiểm tra được đơn thanh toán."));
        if (!data || typeof data.status !== "string" || typeof data.credited !== "boolean") throw new Error("Trạng thái thanh toán chưa sẵn sàng.");
        if (cancelled) return;
        const next: Order = data;
        setOrder(next);
        setOrderError("");
        if (next.credited && !creditedNotice.current.has(orderCode)) {
          creditedNotice.current.add(orderCode);
          window.dispatchEvent(new Event("studio-credits-changed"));
        }
        if (isTerminal(next)) clearInterval(timer);
      } catch (error) {
        if (!cancelled) setOrderError(error instanceof Error ? error.message : "Chưa kiểm tra được đơn thanh toán.");
      } finally {
        running = false;
        if (!cancelled) setCheckingOrder(false);
        if (checks >= 60) { clearInterval(timer); if (!cancelled) setPollingStopped(true); }
      }
    };
    timer = setInterval(() => { ticks += 1; void check(ticks % 6 === 0); }, 5000);
    // The provider callback is only navigation. Check payOS server-side in
    // case its signed webhook arrives late or the browser returns first.
    void check(true);
    return () => { cancelled = true; clearInterval(timer); };
  }, [status, orderCode, checkAgain]);

  async function startCheckout(packId: string) {
    if (checkoutInFlight.current || !paymentReady) return;
    checkoutInFlight.current = true;
    setCheckoutError("");
    setBusyPackId(packId);
    if (checkoutRequest.current?.packId !== packId) checkoutRequest.current = { packId, requestId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/payments/orders", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checkoutRequest.current),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(errorMessage(data, "Chưa tạo được đơn thanh toán. Hãy thử lại."));
      if (data.credited === true && typeof data.orderCode === "string") {
        window.location.assign(`/nap-credit?orderCode=${encodeURIComponent(data.orderCode)}`);
        return;
      }
      if ((data.status === "cancelled" || data.status === "expired") && typeof data.orderCode === "string") {
        checkoutRequest.current = null;
        throw new Error("Đơn trước đã đóng. Bấm chọn gói một lần nữa để tạo đơn mới.");
      }
      if (typeof data.checkoutUrl !== "string") throw new Error("Liên kết thanh toán chưa sẵn sàng.");
      const checkoutUrl = new URL(data.checkoutUrl);
      if (checkoutUrl.origin !== "https://pay.payos.vn" || !/^\/web\/[a-zA-Z0-9_-]{16,200}$/.test(checkoutUrl.pathname) || checkoutUrl.search || checkoutUrl.hash)
        throw new Error("Liên kết thanh toán không hợp lệ.");
      window.location.assign(checkoutUrl.href);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Chưa tạo được đơn thanh toán.");
      checkoutInFlight.current = false;
      setBusyPackId("");
    }
  }

  const balance = account?.credits?.available;
  return <div className={styles.page}>
    <header className={shared.pageHeading}>
      <span className={shared.eyebrow}><PlatformIcon name="spark" size={14} />Thanh toán an toàn</span>
      <h1>Nạp credit</h1>
      <p>Chọn gói phù hợp. Credit chỉ được cộng sau khi hệ thống xác nhận thanh toán thành công.</p>
    </header>

    {status === "anonymous" ? <section className={`${shared.panel} ${styles.accessPanel}`}><h2>Đăng nhập để nạp credit</h2><p>Mỗi khoản nạp được ghi vào đúng tài khoản thành viên của bạn.</p><Link href="/dang-nhap" className={shared.primaryButton}>Đăng nhập<PlatformIcon name="arrow" size={17} /></Link></section>
      : status !== "ready" ? <section className={`${shared.panel} ${styles.accessPanel}`} role="status"><h2>{status === "loading" ? "Đang tải tài khoản…" : "Chưa mở được ví credit"}</h2><p>Hãy kiểm tra tài khoản và thử lại trước khi thanh toán.</p><Link href="/ca-nhan" className={shared.secondaryButton}>Xem tài khoản<PlatformIcon name="arrow" size={17} /></Link></section>
      : <>
        <div className={styles.balanceStrip}><span><PlatformIcon name="spark" size={19} />Số dư hiện tại</span><strong>{balance === undefined ? "Đang cập nhật" : `${number.format(balance)} credit`}</strong></div>

        {orderCode ? <section className={`${shared.panel} ${styles.orderPanel}`} aria-live="polite" aria-labelledby="payment-status-title">
          <div className={styles.orderHeading}><span className={`${styles.orderIcon} ${order?.credited ? styles.successIcon : ""}`}><PlatformIcon name={order?.credited ? "check" : "clock"} size={23} /></span><div><span className={styles.kicker}>ĐƠN THANH TOÁN {orderCode}</span><h2 id="payment-status-title">{order ? orderLabel(order) : "Đang kiểm tra thanh toán"}</h2></div></div>
          {order ? <p>{orderMessage(order)}</p> : <p>Vui lòng giữ trang này mở trong lúc hệ thống kiểm tra đơn.</p>}
          {orderError ? <p className={styles.errorText} role="alert">{orderError}</p> : null}
          <div className={styles.orderActions}><button type="button" className={shared.secondaryButton} disabled={checkingOrder} onClick={() => setCheckAgain(value => value + 1)}><PlatformIcon name="refresh" size={17} />{checkingOrder ? "Đang kiểm tra…" : "Kiểm tra lại"}</button><Link href="/ca-nhan" className={shared.textLink}>Xem ví credit<PlatformIcon name="arrow" size={17} /></Link></div>
          {pollingStopped && !order?.credited ? <p className={styles.quietNote}>Hệ thống đã tạm dừng kiểm tra tự động. Bấm “Kiểm tra lại” để cập nhật.</p> : null}
        </section> : null}

        <section className={styles.packSection} aria-labelledby="pack-heading"><div className={shared.sectionHeading}><div><h2 id="pack-heading">Chọn gói credit</h2><p>Thanh toán một lần, không tự gia hạn.</p></div></div>
          {checkoutError ? <p className={styles.errorBox} role="alert">{checkoutError}</p> : null}
          {!loadingPacks && !packsError && !paymentReady ? <p className={styles.activationNotice} role="status"><PlatformIcon name="clock" size={19} />Thanh toán đang được kích hoạt. Bạn có thể xem các gói; nút mua sẽ mở khi quản trị viên kết nối payOS.</p> : null}
          {loadingPacks ? <div className={styles.loadingGrid} role="status" aria-live="polite">Đang tải các gói credit…</div> : packsError ? <div className={styles.errorBox} role="alert">{packsError}</div> : packs.length === 0 ? <div className={styles.errorBox}>Hiện chưa có gói credit để nạp.</div> : <div className={styles.packGrid}>{packs.map(pack => <article key={pack.id} className={styles.packCard}>
            <div className={styles.packTop}><span className={styles.packIcon}><PlatformIcon name="spark" size={20} /></span><span className={styles.oneTime}>Thanh toán một lần</span></div>
            <h3>{pack.name}</h3><p className={styles.packDescription}>{pack.description}</p>
            <p className={styles.packCredits}><strong>{number.format(pack.credits)}</strong> credit</p>
            <div className={styles.packBottom}><span>{money.format(pack.priceVnd)}</span><button type="button" className={shared.primaryButton} disabled={!paymentReady || Boolean(busyPackId)} onClick={() => void startCheckout(pack.id)} aria-busy={busyPackId === pack.id}>{busyPackId === pack.id ? "Đang mở thanh toán…" : paymentReady ? "Chọn gói này" : "Sắp mở thanh toán"}<PlatformIcon name="arrow" size={17} /></button></div>
          </article>)}</div>}
        </section>
        <aside className={styles.guidance}><PlatformIcon name="shield" size={20} /><p>Bạn thanh toán trên trang payOS. Nếu đã chuyển tiền nhưng credit chưa hiển thị, hãy quay lại trang này và bấm “Kiểm tra lại”; giữ mã đơn để được hỗ trợ đối soát.</p></aside>
      </>}
  </div>;
}
