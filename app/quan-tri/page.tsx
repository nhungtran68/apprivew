import { redirect } from "next/navigation";
import AdminPanel from "@/components/AdminPanel";
import { createStudioSupabaseServer, supabaseConfigured } from "@/lib/studio-supabase";
import { getMember } from "@/lib/studio-server";
export const dynamic = "force-dynamic";
export default async function Admin() {
  if (!supabaseConfigured()) return <main style={{ maxWidth: 640, padding: 32, margin: "60px auto" }}><h1>Chưa kết nối Supabase</h1><p>Cấu hình tài khoản và cơ sở dữ liệu trước khi quản lý thành viên.</p><a href="/">Về ứng dụng</a></main>;
  const client = await createStudioSupabaseServer();
  const { data } = await client.auth.getUser();
  if (!data.user) redirect("/dang-nhap");
  let allowed = false;
  try { const member = await getMember(data.user.id); allowed = member.enabled && member.role === "admin"; } catch { /* controlled access state */ }
  if (!allowed) return <main style={{ maxWidth: 640, padding: 32, margin: "60px auto" }}><h1>Trang quản trị</h1><p>Tài khoản của bạn chưa có quyền quản trị.</p><a href="/">Về ứng dụng</a></main>;
  return <AdminPanel />;
}
