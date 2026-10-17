import { createStudioSupabaseServer } from "@/lib/studio-supabase";
import { apiError, json, limitedJson } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const origin = new URL(request.url).origin;
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new StudioError("INVALID_ORIGIN", "Yêu cầu phải được gửi từ ứng dụng.", 403);
    const body = await limitedJson(request, 5000);
    const action = String(body.action || "login");
    const client = await createStudioSupabaseServer();
    if (action === "signout") {
      const result = await client.auth.signOut();
      if (result.error) throw new StudioError("SIGNOUT_FAILED", "Chưa đăng xuất được. Hãy thử lại.", 502);
      return json({ ok: true });
    }
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (action === "update") {
      const { data } = await client.auth.getUser();
      if (!data.user) throw new StudioError("SIGN_IN_REQUIRED", "Liên kết đặt mật khẩu đã hết hạn. Hãy yêu cầu liên kết mới.", 401);
      if (password.length < 10 || password.length > 128) throw new StudioError("INVALID_PASSWORD", "Mật khẩu cần từ 10 đến 128 ký tự.");
      const result = await client.auth.updateUser({ password });
      if (result.error) throw new StudioError("PASSWORD_FAILED", "Chưa cập nhật được mật khẩu. Kiểm tra yêu cầu bảo mật rồi thử lại.", 422);
      return json({ ok: true, message: "Đã lưu mật khẩu mới." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new StudioError("INVALID_EMAIL", "Nhập địa chỉ email hợp lệ.");
    if (action === "recover") {
      await client.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/dat-mat-khau` });
      return json({ ok: true, message: "Nếu email có tài khoản, bạn sẽ nhận được liên kết đặt lại mật khẩu. Kiểm tra cả thư rác." });
    }
    if (password.length < (action === "register" ? 10 : 1) || password.length > 128) throw new StudioError("INVALID_PASSWORD", "Mật khẩu đăng ký cần từ 10 đến 128 ký tự.");
    if (action === "register") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      const result = await client.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: `${origin}/auth/callback` } });
      if (result.error) throw new StudioError("REGISTER_FAILED", "Chưa tạo được tài khoản. Kiểm tra email, mật khẩu hoặc liên hệ quản trị viên.", 422);
      return json({ ok: true, message: "Đã gửi yêu cầu đăng ký. Xác nhận email nếu có thư, rồi chờ quản trị viên cấp quyền." });
    }
    if (action !== "login") throw new StudioError("INVALID_ACTION", "Thao tác không hợp lệ.");
    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) throw new StudioError("LOGIN_FAILED", "Email hoặc mật khẩu chưa đúng, hoặc email chưa được xác nhận.", 401);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
