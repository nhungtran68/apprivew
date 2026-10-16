import AuthForm from "@/components/AuthForm";
import { supabaseConfigured } from "@/lib/studio-supabase";
export const dynamic = "force-dynamic";
export default function Password() { return <AuthForm configured={supabaseConfigured()} updatePassword />; }
