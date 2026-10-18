"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Account = { userId: string; name: string; isAdmin: boolean; quota?: { used: number; limit: number }; voiceCloning?: { used: number; limit: number; remaining: number | null; unlimited: boolean } };
type AccountState = { status: "loading" | "ready" | "anonymous" | "restricted" | "unavailable" | "error"; account?: Account; message?: string };
type AccountContextValue = AccountState & { refresh: () => void };
const AccountContext = createContext<AccountContextValue>({ status: "loading", refresh: () => {} });

// The existing authenticated endpoint remains the single source of account and
// usage data. Module visibility is presentation only, never authorization.
export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>({ status: "loading" });
  const currentRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch("/api/config", { signal: controller.signal, cache: "no-store", credentials: "same-origin" });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 401) { setState({ status: "anonymous" }); return; }
        if (response.status === 403) {
          setState({ status: "restricted", message: "Tài khoản đang chờ cấp quyền hoặc đã tạm khóa. Hãy liên hệ quản trị viên." }); return;
        }
        if (data.code === "AUTH_NOT_CONFIGURED") {
          setState({ status: "unavailable", message: "Kết nối tài khoản đang được chuẩn bị. Bạn vẫn có thể khám phá các công cụ." }); return;
        }
        if (!response.ok || typeof data.userId !== "string" || !data.userId) throw new Error("account-unavailable");
        const validQuota = Number.isFinite(data.quota?.used) && data.quota.used >= 0 && Number.isFinite(data.quota?.limit) && data.quota.limit >= 0;
        setState({ status: "ready", account: {
          userId: data.userId,
          name: typeof data.memberName === "string" && data.memberName.trim() ? data.memberName.trim() : "Thành viên",
          isAdmin: data.isAdmin === true,
          ...(validQuota ? { quota: { used: data.quota.used, limit: data.quota.limit } } : {}),
          ...(data.voiceCloning && Number.isFinite(data.voiceCloning.used) && Number.isFinite(data.voiceCloning.limit) ? { voiceCloning: { used: data.voiceCloning.used, limit: data.voiceCloning.limit, remaining: data.voiceCloning.remaining, unlimited: data.voiceCloning.unlimited === true } } : {}),
        } });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error", message: "Chưa tải được thông tin tài khoản. Vui lòng thử lại." });
      }
    })();
  }, []);

  useEffect(() => { refresh(); return () => currentRequest.current?.abort(); }, [refresh]);
  return <AccountContext.Provider value={{ ...state, refresh }}>{children}</AccountContext.Provider>;
}

export const useAccount = () => useContext(AccountContext);
export function accountInitials(name?: string) {
  if (!name) return "LK";
  return name.split(/\s+/).filter(Boolean).slice(-2).map(word => Array.from(word)[0]).join("").toLocaleUpperCase("vi");
}
