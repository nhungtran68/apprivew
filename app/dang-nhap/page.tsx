import AuthForm from "@/components/AuthForm";
import { supabaseConfigured } from "@/lib/studio-supabase";
export const dynamic = "force-dynamic";
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return <AuthForm configured={supabaseConfigured()} linkError={params.error === "link"} />;
}
