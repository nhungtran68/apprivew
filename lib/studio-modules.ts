export type AiModule = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  category: "audio" | "video" | "content" | "image" | "other";
  icon: "voice" | "video" | "script" | "review" | "image" | "grid";
  tone: "violet" | "blue" | "amber" | "rose" | "green" | "slate";
  /** Controls whether the module is visible and its route can be opened. */
  available: boolean;
  capabilities: readonly { title: string; description: string }[];
  legacy?: { href: string; label: string };
};

/** Shared by the dashboard, navigation and module routes. */
export const aiModules: readonly AiModule[] = [
  {
    id: "voice",
    slug: "giong-noi-ai",
    title: "Tạo giọng nói AI",
    shortTitle: "Giọng nói",
    description: "Chuyển văn bản thành giọng nói, nhân bản giọng và xử lý âm thanh.",
    category: "audio",
    icon: "voice",
    tone: "violet",
    available: true,
    capabilities: [
      { title: "Văn bản thành giọng đọc", description: "Chuẩn bị lời đọc cho video sản phẩm, bài giới thiệu và nội dung chia sẻ." },
      { title: "Giọng riêng của bạn", description: "Quản lý giọng cá nhân để các nội dung luôn có cách thể hiện nhất quán." },
      { title: "Nghe thử và xuất âm thanh", description: "Kiểm tra lời đọc, chọn bản phù hợp và lưu âm thanh cho công việc tiếp theo." },
    ],
    legacy: { href: "/studio?view=voices", label: "Mở thư viện giọng đọc hiện có" },
  },
  {
    id: "video",
    slug: "video-ai",
    title: "Tạo video AI",
    shortTitle: "Video AI",
    description: "Quay hoặc tải video, chọn cảnh từ thư viện, viết lời thoại theo kịch bản và xuất MP4.",
    category: "video",
    icon: "video",
    tone: "blue",
    available: true,
    capabilities: [
      { title: "Quay hoặc chọn video", description: "Dùng cảnh bạn tự quay, tải video có sẵn hoặc chọn một cảnh minh họa từ thư viện." },
      { title: "Viết theo dạng kịch bản", description: "AI xem cảnh làm tư liệu và viết lời thoại dựa trên thông điệp bạn muốn chia sẻ." },
      { title: "Ghép và tải MP4", description: "Chọn giọng đọc, nghe thử rồi xuất video ngắn hoàn chỉnh." },
    ],
  },
  {
    id: "script",
    slug: "kich-ban-ai",
    title: "Tạo kịch bản AI",
    shortTitle: "Kịch bản",
    description: "Viết kịch bản video, quảng cáo và nội dung bán hàng theo cách của bạn.",
    category: "content",
    icon: "script",
    tone: "amber",
    available: true,
    capabilities: [
      { title: "Kịch bản từ ý tưởng", description: "Xây dựng lời mở đầu, nội dung chính và lời mời hành động cho từng mục tiêu." },
      { title: "Nội dung theo thương hiệu", description: "Kết hợp thông tin sản phẩm, đối tượng khách hàng và phong cách giao tiếp của bạn." },
      { title: "Lời thoại theo thời lượng", description: "Chia nội dung thành các đoạn phù hợp với nhịp kể và độ dài video mong muốn." },
    ],
  },
  {
    id: "review",
    slug: "video-review",
    title: "Tạo video review",
    shortTitle: "Video Review",
    description: "Biến tư liệu sản phẩm thành video giới thiệu và review gần gũi.",
    category: "video",
    icon: "review",
    tone: "rose",
    available: true,
    capabilities: [
      { title: "Hiểu tư liệu thực tế", description: "Kết hợp những gì có trong video với thông điệp bạn muốn gửi đến người xem." },
      { title: "Kịch bản review tự nhiên", description: "Phát triển góc kể có ích, bám thông tin bạn cung cấp về sản phẩm và trải nghiệm." },
      { title: "Ghép lời đọc và video", description: "Làm việc với kịch bản, giọng đọc và bản xuất trong cùng một quy trình." },
    ],
    legacy: { href: "/studio", label: "Tiếp tục trong Lời Kể Studio" },
  },
  {
    id: "image",
    slug: "anh-ai",
    title: "Tạo ảnh AI",
    shortTitle: "Ảnh AI",
    description: "Tạo ảnh sản phẩm, thiết kế quảng cáo và chỉnh sửa hình ảnh.",
    category: "image",
    icon: "image",
    tone: "green",
    available: true,
    capabilities: [
      { title: "Ảnh từ ý tưởng", description: "Phát triển hình ảnh theo mục đích sử dụng, bố cục và phong cách bạn lựa chọn." },
      { title: "Chỉnh ảnh có sẵn", description: "Chuẩn bị cách thay nền, chỉnh bố cục và hoàn thiện ảnh từ tư liệu của bạn." },
      { title: "Bộ ảnh đồng nhất", description: "Sắp xếp hình ảnh cùng phong cách để sử dụng xuyên suốt một chiến dịch nội dung." },
    ],
  },
  {
    id: "other",
    slug: "cong-cu-khac",
    title: "Công cụ AI khác",
    shortTitle: "Công cụ khác",
    description: "Khám phá những tiện ích AI mới cho công việc kinh doanh mỗi ngày.",
    category: "other",
    icon: "grid",
    tone: "slate",
    available: true,
    capabilities: [
      { title: "Chuẩn bị tệp nội dung", description: "Các tiện ích xử lý tệp để bạn đưa tư liệu vào quy trình sáng tạo thuận tiện hơn." },
      { title: "Tái sử dụng nội dung", description: "Chuẩn bị cách chuyển một ý tưởng thành nhiều phiên bản cho các kênh khác nhau." },
      { title: "Mở rộng theo nhu cầu", description: "Bổ sung công cụ thiết thực theo những công việc bạn sử dụng thường xuyên." },
    ],
  },
];

export function getVisibleModules(): readonly AiModule[] {
  return aiModules.filter(module => module.available);
}

export function getModuleBySlug(slug: string): AiModule | undefined {
  return aiModules.find(module => module.available && module.slug === slug);
}

export function moduleHref(module: Pick<AiModule, "slug">): string {
  return `/cong-cu/${module.slug}`;
}
