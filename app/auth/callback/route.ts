import { NextResponse } from "next/server";
import { createStudioSupabaseServer } from "@/lib/studio-supabase";
export async function GET(request: Request) {
  const url = new URL(request.url), code = url.searchParams.get("code");
  const next = url.searchParams.get("next") === "/dat-mat-khau" ? "/dat-mat-khau" : "/";
  if (code) {
    try {
      const client = await createStudioSupabaseServer();
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(next, url.origin));
    } catch { /* show controlled sign-in error */ }
  }
  return NextResponse.redirect(new URL("/dang-nhap?error=link", url.origin));
}
