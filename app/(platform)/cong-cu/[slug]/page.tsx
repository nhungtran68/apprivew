import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ModulePage from "@/components/platform/ModulePage";
import VoiceAiPage from "@/components/platform/VoiceAiPage";
import ScriptAiPage from "@/components/platform/ScriptAiPage";
import { getModuleBySlug, getVisibleModules } from "@/lib/studio-modules";

type ModuleRouteProps = { params: Promise<{ slug: string }> };

// This phase exposes only the modules explicitly enabled in the registry.
// Unknown or hidden slugs are rejected before starting a streamed page.
export const dynamicParams = false;

export function generateStaticParams() {
  return getVisibleModules().map(module => ({ slug: module.slug }));
}

export async function generateMetadata({ params }: ModuleRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const module = getModuleBySlug(slug);
  if (!module) notFound();

  return {
    title: `${module.title} | Lời Kể AI`,
    description: module.description,
  };
}

export default async function ModuleRoute({ params }: ModuleRouteProps) {
  const { slug } = await params;
  const module = getModuleBySlug(slug);
  if (!module) notFound();

  if (module.id === "voice") return <VoiceAiPage />;
  if (module.id === "script") return <ScriptAiPage />;
  return <ModulePage module={module} />;
}
