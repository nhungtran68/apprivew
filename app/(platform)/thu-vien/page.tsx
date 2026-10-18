import type { Metadata } from "next";
import LibraryPage from "@/components/platform/LibraryPage";

export const metadata: Metadata = { title: "Thư viện | Lời Kể AI" };

export default function Page() {
  return <LibraryPage />;
}
