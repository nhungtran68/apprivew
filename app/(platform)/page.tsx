import type { Metadata } from "next";
import { Dashboard } from "@/components/platform/Dashboard";

export const metadata: Metadata = {
  title: "Tổng quan | Lời Kể AI",
  description: "Không gian công cụ AI cho người kinh doanh online: giọng nói, video, kịch bản, video review và hình ảnh.",
  alternates: { canonical: "/" },
};

export default function Home() { return <Dashboard />; }
