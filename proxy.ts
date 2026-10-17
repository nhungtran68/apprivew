import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;
  const client = createServerClient(url, key, { cookies: {
    getAll: () => request.cookies.getAll(),
    setAll(items) {
      for (const { name, value } of items) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of items) response.cookies.set(name, value, options);
      response.headers.set("Cache-Control", "private, no-store");
    },
  } });
  await client.auth.getClaims();
  return response;
}
export const config = { matcher: ["/", "/quan-tri", "/dang-nhap", "/dat-mat-khau", "/api/:path*", "/auth/:path*"] };
