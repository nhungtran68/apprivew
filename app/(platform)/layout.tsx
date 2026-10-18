import type { ReactNode } from "react";
import { PlatformShell } from "@/components/platform/PlatformShell";

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
