import Studio from "@/components/Studio";

const VIEWS = ["studio", "projects", "voices", "profile", "guide"] as const;

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams;
  const initialView = VIEWS.find(item => item === view) || "studio";
  return <Studio initialView={initialView} />;
}
