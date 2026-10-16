import { NextResponse } from "next/server";
import { createStudioSupabaseServer } from "@/lib/studio-supabase";
export async function GET(request: Request) {
  const url = new URL(request.url), hash = url.searchParams.get("token_hash"), type = url.searchParams.get("type");
  if (hash && (type === "signup" || type === "recovery" || type === "invite" || type === "email")) {
    try {
      const client = await createStudioSupabaseServer();
      const { error } = await client.auth.verifyOtp({ token_hash: hash, type });
      if (!error) return NextResponse.redirect(new URL(type === "recovery" || type === "invite" ? "/dat-mat-khau" : "/", url.origin));
    } catch { /* invalid or expired link */ }
  }
  return NextResponse.redirect(new URL("/dang-nhap?error=link", url.origin));
}
