import type { Metadata } from "next";
import TopUpPage from "@/components/platform/TopUpPage";

export const metadata: Metadata = { title: "Nạp credit | Lời Kể AI" };

export default function Page() {
  return <TopUpPage />;
}
