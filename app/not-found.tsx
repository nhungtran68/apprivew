import { PlatformShell } from "@/components/platform/PlatformShell";
import MissingPage from "./(platform)/not-found";

export default function NotFound() {
  return <PlatformShell><MissingPage /></PlatformShell>;
}
