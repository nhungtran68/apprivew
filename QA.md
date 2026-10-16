# Kiểm chứng Supabase và AI

Cập nhật ngày **16/10/2026**. Dự án Supabase tại Singapore đã được tạo và áp dụng schema. Website mục tiêu: [Apprivew](https://apprivew.vercel.app). Không có khóa bí mật trong mã nguồn.

## Đã chạy và đạt

**Tổng cộng 63 nhóm kiểm tra đều đạt:** 23 backend + 10 giao diện/dự án + 4 tải/dọn âm thanh + 15 tích hợp Supabase + 11 tích hợp Next.js.

| Bộ kiểm tra | Số nhóm | Phạm vi |
| --- | ---: | --- |
| Backend ngoại tuyến | 23 | Đủ ba chế độ `scenery`, `talking`, `face`; giới hạn ảnh và âm thanh; quyền dùng giọng có chữ ký; hạn mức; thời lượng; lỗi nhà cung cấp |
| Giao diện và dự án | 10 | Các hành vi giao diện và lưu dự án được kiểm tra ngoại tuyến |
| Tải/dọn âm thanh ngoại tuyến | 4 | Tải lỗi vẫn dọn toàn bộ tệp riêng; chặn đường dẫn ngoài; giữ âm thanh đã trả phí khi dọn tạm gặp lỗi |
| Supabase cục bộ | 15 | Auth, PostgREST và Storage thật trong Docker |
| Next.js cục bộ | 11 | Các luồng tài khoản chạy qua Next.js thật |

Các bộ ngoại tuyến dùng nhà cung cấp AI mô phỏng. Kết quả này không xác nhận chất lượng hoặc hoạt động của AI thật.

- **Tích hợp Supabase:** thử ba tài khoản, cách ly dữ liệu, quyền quản trị, kho riêng, URL ký tạm và thu hồi quyền khi token vẫn còn hạn. Với hạn mức 5 và 12 yêu cầu RPC đồng thời, đúng 5 yêu cầu thành công và 7 bị từ chối; không trừ nhầm tài khoản khác.
- **Tích hợp Next.js:** đăng ký, cookie đăng nhập, trạng thái chờ duyệt, lưu hồ sơ/tên, quản trị hạn mức, CSRF, khôi phục một lần bằng token Auth thật, đổi mật khẩu và đăng xuất. Dùng `http://localhost:4320` vì Next.js chuẩn hóa địa chỉ loopback sang `localhost`. Token khôi phục được tạo cục bộ, không gửi email; bài kiểm tra không xác nhận SMTP đã giao thư.
- Tài khoản và tệp thử cục bộ được dọn trong khối `finally`.
- **78 assertion SQL** đã chạy trên cả Postgres cục bộ và dự án Supabase tại Singapore: quyền sở hữu, cấm tự nâng quyền, metadata giả, quản trị viên, trạng thái khóa và ranh giới hạn mức. Giao dịch hoàn tác toàn bộ bốn tài khoản thử; kiểm tra sau rollback xác nhận không còn dữ liệu thử. Xem `supabase/verify-rls.sql`.
- **Security Advisors** trên Supabase thật không có cảnh báo. **Performance Advisors** chỉ có thông báo `INFO`: chỉ mục mới `studio_members_created_at_idx` chưa được sử dụng; đây không phải lỗi.
- Bản dựng Next.js và kiểm tra TypeScript đã chạy lại thành công sau các thay đổi của đợt này. CI trên GitHub tiếp tục kiểm tra mỗi lần cập nhật.
- **Xuất MP4 trên trình duyệt:** đã xuất và tải tệp thật với H.264/yuv420p, 30 fps, AAC 48 kHz stereo. Mẫu kiểm tra có kích thước 160 × 90, dài 3 giây. Đã trích ảnh từ MP4 và WebM thật, kể cả WebM có `duration = Infinity`; tệp lỗi bị từ chối và object URL được giải phóng.

## Chưa xác nhận / cần dịch vụ thật

- **Đã gọi DeepSeek thật trên Production:** một lượt đọc 9 ảnh trích từ clip tổng hợp 15 giây, trả HTTP 200 trong khoảng 7,1 giây và mô tả đúng ba màu/hình. Các lượt thử đủ ba chế độ và số token sẽ được cập nhật sau kiểm tra tiếp theo.
- Hai biến khóa đã có trên Vercel Production và bản mới đã nhận cấu hình. **ElevenLabs chưa kết nối thành công:** yêu cầu đọc danh sách giọng bị từ chối; chưa tạo âm thanh thật. Chưa có chi phí TTS được đo.
- Kết quả hiện tại không phải đánh giá chất lượng giọng, nhân bản giọng hoặc toàn bộ video thật. Công cụ `scripts/estimate-cost.mjs` và phần dự toán trong `COSTS.md` vẫn là ước tính.
- Cần cấu hình Site URL, Redirect URLs và mẫu email của Supabase cho domain chính thức; xác nhận email quản trị và cấp quyền cho đúng UUID. Chưa xác nhận email SMTP đã đến hộp thư.
- Chưa thử clip dài 15–90 giây trên các điện thoại mục tiêu, nhập vào CapCut hoặc đăng lên Facebook.

## Tái chạy

```text
pnpm test
pnpm run typecheck
pnpm run build
node scripts/estimate-cost.mjs --duration 30 --videos 1000
```

Hai bài tích hợp dưới đây chạy riêng khi chủ động chọn, **không nằm trong `pnpm test`**. Chúng từ chối kết nối tới mọi Supabase ngoài `localhost:55321`.

Tệp JSON cấu hình chứa các trường `apiUrl`, `publishableKey`, `serviceRoleKey` phải nằm trong thư mục `work` và không được commit. Dùng một bộ Supabase cục bộ riêng, áp dụng `supabase/setup.sql`, rồi chạy:

```text
node tests/supabase.integration.mjs --config /absolute/path/work/local-supabase.json
node tests/studio-auth.integration.mjs --config /absolute/path/work/local-supabase.json
```

Bài thứ hai cần Next.js đang chạy tại `http://localhost:4320`, với Supabase cục bộ đã được cấu hình. Không đưa service-role key hoặc secret key cục bộ vào mã trình duyệt hay môi trường Vercel chính thức.

DeepSeek chỉ đọc ảnh lấy mẫu, không nghe tiếng gốc hoặc xem chuyển động liên tục. Video gốc và thư viện dự án hiện được lưu trên thiết bị.
