# Kiểm chứng Supabase và AI

Cập nhật ngày **17/10/2026**. Dự án Supabase tại Singapore đã được tạo và áp dụng schema. Website mục tiêu: [Apprivew](https://apprivew.vercel.app). Không có khóa bí mật trong mã nguồn.

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

- **Tài khoản thử của đợt DeepSeek trước trên Production:** đăng nhập và đăng xuất qua app thật thành công; tài khoản chỉ có quyền thành viên. Hạn mức tăng đúng 7 lượt cho 7 yêu cầu DeepSeek (gồm lượt trước khi bật log). Không gửi email thử. Sau đợt đó, đã xóa đúng tài khoản tạm cùng phiên, refresh token, hồ sơ và quyền giọng; truy vấn xác minh cả 8 nhóm dữ liệu liên quan đều bằng 0. Không có tệp âm thanh thử được tạo trên cloud. Xác nhận dọn dữ liệu này chỉ áp dụng cho đợt DeepSeek trước, không bao gồm tài khoản tạm của đợt thử ElevenLabs hiện tại. Đây không phải xác nhận luồng đăng ký và giao thư.
- **Quản trị viên đầu tiên:** đã đối chiếu đúng email chủ dự án và xác minh trong Supabase rằng email được xác nhận (`email_confirmed = true`), tài khoản có quyền `admin`, được bật sử dụng và có hạn mức 1.000 lượt. Đây là kiểm tra dữ liệu; chưa xác nhận chủ tài khoản đăng nhập giao diện quản trị hoặc email SMTP đã được giao.

## DeepSeek thật trên Production

Ngày 16/10/2026, đã thử đủ ba chế độ `scenery`, `talking`, `face` qua app đã triển khai. Mỗi chế độ chạy một lần phân tích và một lần viết kịch bản: **6 yêu cầu đều HTTP 200, JSON hợp lệ và `finish_reason: stop`**. Model là `deepseek-flash`, tắt suy luận.

Mẫu thử là video tổng hợp **15 giây, 9 ảnh**, gồm hình tròn đỏ, hình vuông xanh dương và hình tam giác xanh lá; không có người và không có âm thanh. Phân tích trả đúng các hình/màu; chế độ `face` ghi rõ không thấy người hoặc mặt người trong ảnh mẫu, không nghe âm thanh và không đọc môi. Cả ba kịch bản có một đoạn từ **0 đến 15 giây**, không vượt thời lượng.

- Thời gian HTTP quan sát: phân tích **6,76–7,03 giây**, viết kịch bản **3,59–4,17 giây**. Đây là thời gian toàn yêu cầu, khác thời gian gọi nhà cung cấp trong log.
- Sáu log `studio_ai_usage` cho phép tính chi phí DeepSeek **$0.003624636** theo token trả về và đơn giá ngoài cao điểm; đây không phải hóa đơn. Theo từng cặp phân tích + kịch bản: `scenery` **$0.001108950**, `talking` **$0.001253718**, `face` **$0.001261968**. Xem cách tính trong `COSTS.md`.
- Có **một lần phân tích `scenery` HTTP 200 trước khi bật log**, không có số token nên **không nằm trong tổng đo trên**.
- Không suy rộng bài thử tổng hợp 15 giây này thành kết luận chất lượng, độ trễ hoặc chi phí cho video thực tế 30–90 giây. Chưa so sánh chế độ bật suy luận.

## ElevenLabs thật và xuất video mẫu

Ngày **17/10/2026**, quyền đọc giọng và tạo lời đọc đã được kiểm tra bằng khóa Production qua app:

- Danh sách giọng trả **HTTP 200**, có **21 giọng mẫu**. Không truy cập được trang quản trị ElevenLabs do trình duyệt yêu cầu đăng nhập; kết luận về hai quyền này dựa trên yêu cầu API thật thành công.
- Một yêu cầu tạo giọng với **119 ký tự** lấy từ kịch bản DeepSeek đã tạo trước đó, giọng mẫu **Sarah**, model `eleven_flash_v2_5`, tiếng Việt. App trả **HTTP 200 trong 5,481 giây**; không rút câu hoặc tạo lại.
- WAV thật có **314.350 byte**, PCM 24 kHz, mono, 16 bit, dài **6,548 giây** và có tín hiệu khác 0. Tài khoản thử dùng đúng **2 lượt AI**, từ 0 lên 2; không trừ tài khoản quản trị.
- Dùng helper xuất video hiện tại với bộ FFmpeg WASM thật và bộ nối worker trong Node để ghép vào clip mẫu 15 giây: **MP4 H.264/yuv420p, 640×360, 30 fps; AAC 48 kHz stereo; video dài 15 giây**. Đối chiếu waveform cho hệ số tương quan khoảng **0,99997** với lời đọc đầu vào.
- Lời thử ngắn hơn video, phần còn lại là khoảng nghỉ. Đây là bài kiểm tra tạo giọng/định dạng/giữ âm thanh, không phải kiểm chứng lời nói bám từng cảnh hoặc kịch bản phủ kín thời lượng. Chưa nghe đánh giá chủ quan phát âm trên điện thoại.
- Tệp lời đọc riêng đã xóa bằng Storage API với đúng phiên thành viên thử. Đã đăng xuất, xóa tài khoản QA và xác minh 8 nhóm dữ liệu liên quan đều bằng 0.
- Tài khoản **daitaigroup@gmail.com** có email đã xác nhận, đã được cấp `admin`, bật sử dụng và hạn mức ban đầu **1.000 lượt AI**; kiểm tra database xác nhận dùng 0 lượt. Không đăng nhập bằng mật khẩu của chủ tài khoản và chưa kiểm tra thao tác của họ trên giao diện quản trị.

Tệp mẫu được giữ cục bộ ở thư mục outputs: `Apprivew-voice-test.wav` và `Apprivew-AI-test.mp4`. Chi phí theo ký tự của lần tạo giọng ước tính **$0.00476** theo bảng giá API, chưa đối soát hóa đơn hoặc dung lượng trong gói.

## Chưa xác nhận / cần dịch vụ thật

- **Nhân bản giọng chưa thử:** chưa có mẫu giọng và xác nhận của chủ giọng; chưa xác minh quyền Voices: Write hoặc quyền lợi gói. Thành công của TTS không xác nhận quyền tạo bản sao giọng.
- Đã kiểm tra các bước phân tích → kịch bản → lời đọc → MP4 trên dữ liệu tổng hợp qua các bài thử. Chưa chạy toàn bộ luồng trên một phiên trình duyệt/điện thoại với video thực tế của người dùng.
- Cần đối soát Site URL, Redirect URLs và mẫu email của Supabase cho domain chính thức. Quản trị viên đã được kích hoạt như trên; chưa xác nhận email SMTP đã đến hộp thư hoặc thao tác đăng nhập của chủ tài khoản.
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
