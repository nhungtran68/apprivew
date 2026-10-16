# Kiểm chứng bản DeepSeek / Vercel

Ngày kiểm tra: 16/10/2026. Không có khóa AI thật hoặc dự án Supabase trong môi trường kiểm tra.

## Đã kiểm tra

- TypeScript của ứng dụng và bản nguồn sạch, không dựa vào các tệp Next.js đã sinh.
- Production build Next.js, gồm các trang và API. Môi trường Windows cục bộ chặn tiến trình con; bản dựng cục bộ dùng `STUDIO_BUILD_IN_PROCESS=1`. Vercel dùng cấu hình Next.js mặc định.
- `pnpm test`: 14 kiểm tra hành vi backend và 10 kiểm tra giao diện/dự án. Kiểm tra provider dùng phản hồi mô phỏng rõ ràng trong tests; không xác nhận dịch vụ AI thật.
- Trình duyệt: giao diện máy tính và điện thoại, thư viện dự án, xuất và tải MP4 bằng FFmpeg WASM thật.
- Tệp MP4 tải từ bản Next.js có H.264/yuv420p, 30 fps, AAC 48 kHz stereo; video kiểm tra 160×90 dài 3 giây. Không đăng tệp lên Facebook hoặc mở bằng CapCut trong phiên này.
- Trích ảnh thật từ MP4 và WebM do MediaRecorder tạo. Cả hai trả ảnh JPEG khác nhau, mốc tăng đúng, kích thước nằm trong giới hạn. WebM có duration `Infinity` vẫn trích được nhờ thời gian ghi. Tệp sai định dạng bị từ chối; object URL được giải phóng cả khi lỗi.
- Khi chưa cấu hình Supabase, API trả trạng thái chưa kết nối có kiểm soát. Yêu cầu xác thực khác nguồn bị chặn.
- Rà soát nguồn: khóa AI chỉ lấy từ biến máy chủ; hạn mức trừ nguyên tử trước yêu cầu provider; admin được kiểm tra máy chủ; giọng cá nhân có chữ ký ràng buộc thành viên.

## Cần kiểm tra khi kết nối dịch vụ

1. Chạy `supabase/setup.sql`, `verify.sql` và Security Advisors trong dự án thật. Thử hai tài khoản để kiểm tra RLS, kho riêng và trừ hạn mức đồng thời.
2. Cấu hình URL/email templates theo README. Thử đăng ký, xác nhận, lời mời, đăng nhập, đặt lại mật khẩu và đăng xuất. Cấp quản trị viên đầu tiên bằng UUID thật.
3. Đặt biến DeepSeek và ElevenLabs trên Vercel; thử phân tích ảnh, kịch bản tiếng Việt, giọng có sẵn, giọng cá nhân và trường hợp dịch vụ lỗi/hết hạn mức.
4. Thử chuỗi quay → nêu ý → duyệt kịch bản → tạo giọng → xuất với clip thật 15–90 giây trên điện thoại mục tiêu. Kiểm tra bộ nhớ, xoay máy và video nguồn khác nhau.
5. Nhập MP4 vào CapCut và đăng thử Facebook bằng thiết bị thật trước khi mở rộng nhóm.

DeepSeek trong ứng dụng chỉ đọc ảnh lấy mẫu; không nghe tiếng gốc hay xem chuyển động liên tục. Dự án/video gốc hiện lưu trên thiết bị. Đây là các giới hạn sản phẩm có thật, không phải kết quả kiểm tra đã hoàn tất.
