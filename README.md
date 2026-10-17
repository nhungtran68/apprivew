# Lời Kể · apprivew

Web app tiếng Việt: quay video → nêu ý muốn chia sẻ → duyệt lời → tạo giọng → tải MP4.

## Công nghệ

Next.js App Router chạy trên Vercel; Supabase Auth/Postgres/Storage cho thành viên và tệp riêng; DeepSeek Flash đọc ảnh mẫu và viết kịch bản; ElevenLabs tạo giọng; FFmpeg WASM ghép MP4 ngay trong trình duyệt. Không dùng Gemini.

## Đưa lên Vercel từ GitHub

1. Import repo nhungtran68/apprivew vào Vercel, chọn Next.js, Root Directory để trống (gốc repo). Có thể bắt đầu tại https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnhungtran68%2Fapprivew .
2. Giữ lệnh build mặc định pnpm run build và Output Directory mặc định. Bộ FFmpeg được chuẩn bị tự động khi build; không cần tải WASM lên GitHub.
3. Tạo dự án Supabase. Chạy supabase/setup.sql một lần trong SQL Editor của dự án mới; đọc supabase/README.md và kiểm tra bằng supabase/verify.sql + Security Advisors. Bản apprivew đã áp dụng schema và kiểm tra quyền trên Supabase Singapore; với dự án mới khác, bạn cần chạy lại phần thiết lập.
4. Thêm biến môi trường bên dưới vào Vercel, rồi deploy lại. Chưa có biến vẫn dựng được giao diện, nhưng đăng nhập/AI sẽ báo chưa kết nối.
5. Trong Supabase Auth → URL Configuration, đặt Site URL là domain Vercel chính thức; thêm URL đó cùng đường dẫn /auth/callback và /auth/confirm vào Redirect URLs. Cấu hình SMTP cho email thành viên nếu cần gửi xác nhận, mời hoặc đặt lại mật khẩu.
6. Đăng ký tài khoản của bạn; lấy UUID trong Supabase Auth và cấp admin theo hướng dẫn bên dưới.

## Email đăng ký, lời mời và đặt lại mật khẩu

Trong Supabase Auth → Email Templates, dùng liên kết TokenHash dưới đây để xác nhận hoạt động cả khi người nhận mở email trên trình duyệt khác. Thay liên kết trong các mẫu tương ứng:

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
- Invite user: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
- Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

Site URL phải là domain chính thức của app. Nếu giữ luồng PKCE mặc định, cho phép thêm URL `https://DOMAIN_APP/auth/callback?next=/dat-mat-khau` trong Redirect URLs; thư mời nên dùng mẫu TokenHash ở trên. Tài khoản mới vẫn chờ quản trị viên duyệt và cấp hạn mức trước khi dùng AI.

## Biến môi trường

Chỉ hai biến NEXT_PUBLIC_SUPABASE_URL và NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY được đưa ra trình duyệt. Các biến khác chỉ nằm phía máy chủ. Xem .env.example.

| Biến | Mục đích |
| --- | --- |
| NEXT_PUBLIC_SUPABASE_URL | URL dự án Supabase |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Publishable key của Supabase |
| DEEPSEEK_API_KEY | Khóa DeepSeek dùng chung |
| DEEPSEEK_MODEL | Mặc định deepseek-flash, cần có khả năng đọc ảnh |
| ELEVENLABS_API_KEY | Khóa ElevenLabs dùng chung |
| ELEVENLABS_MODEL | Mặc định eleven_flash_v2_5, hỗ trợ tiếng Việt |
| STUDIO_ENCRYPTION_KEY | Chuỗi ngẫu nhiên ít nhất32 ký tự, bảo vệ quyền dùng giọng cá nhân; giữ ổn định |
| STUDIO_SHARED_VOICE_IDS | Tùy chọn: danh sách voice ID được chia sẻ, phân cách bằng dấu phẩy |

Không đưa file .env.local hay khóa bí mật vào GitHub. Không dùng service_role key trong trình duyệt.

## Tài khoản và hạn mức

Thành viên dùng email/mật khẩu; đăng ký mới mặc định chưa có quyền dùng AI. Chủ dự án thực hiện một lần trong Supabase SQL Editor, thay UUID bằng tài khoản thật:

    update public.studio_members
    set role='admin', enabled=true, ai_units_limit=1000
    where user_id='UUID_TAI_KHOAN_CUA_BAN';

Mở /quan-tri để duyệt thành viên và cấp hạn mức. Đơn vị là lượt xử lý: mỗi yêu cầu DeepSeek1lượt; mỗi lần tạo tiếng ceil(số ký tự/100)lượt; nhân bản giọng10lượt. Lần tạo lại cũng tính; không tự hoàn lượt khi đã gửi yêu cầu tới dịch vụ. Đây là hạn mức nội bộ của app, không phải số tiền hoặc số video cố định.

Khóa DeepSeek và ElevenLabs do quản trị viên nối một lần. Thành viên không thấy khóa và không phải có tài khoản nhà cung cấp AI. Mỗi thành viên chỉ dùng giọng được phép: giọng mẫu, giọng chia sẻ được quản trị viên chỉ định, và giọng đã tạo cho chính họ.

## Phân tích video với DeepSeek

Bản này trích4–16 ảnh JPEG có thời gian từ clip, tối đa640px/ảnh, tổng yêu cầu dưới3MB để hợp giới hạn Vercel. DeepSeek nhìn ảnh mẫu, không xem liên tục và không nghe tiếng gốc. Những thao tác nhanh giữa hai ảnh có thể bị bỏ sót. Người dùng cần kiểm tra cảnh và xác nhận ý định. Có thể gõ ý tưởng; nút nói dùng nhận dạng giọng nói của trình duyệt nếu có hỗ trợ, với sự cho phép của người dùng.

API DeepSeek hiện được cấu hình theo tài liệu chính thức: https://api-docs.deepseek.com/guides/vision/ và https://api-docs.deepseek.com/guides/json_mode/ .

## Lưu dữ liệu và xuất video

Video gốc và dự án tự lưu trên trình duyệt/thiết bị hiện tại bằng IndexedDB, có thể tải bản sao .loike để chuyển thiết bị. Bản đầu chưa đồng bộ thư viện dự án lên cloud. Supabase lưu hồ sơ, quyền, hạn mức, giọng được phép và tệp âm thanh riêng. Tệp lời đọc được tải về trình duyệt rồi xóa khỏi kho tạm; mẫu nhân bản giọng gửi tới ElevenLabs.

Clip2–90giây, tối đa60MB. Xuất MP4 H.264/yuv420p, AAC48kHz,30fps; giữ tỷ lệ hình nguồn, không đồng bộ khẩu hình. Nguồn HDR cần chuyển SDR trước. Bộ ghép tải lần đầu khoảng31MB; thiết bị cần còn đủ bộ nhớ và giữ trang mở khi xử lý. CapCut/Facebook cần kiểm tra bằng thiết bị thật trước khi mở rộng nhóm.

## Chạy local

Cần Node.js22+ và pnpm11.25.

    pnpm install --frozen-lockfile
    pnpm run dev

Sao chép .env.example thành .env.local rồi điền giá trị. Để dựng:

    pnpm run typecheck
    pnpm test
    pnpm run build
    pnpm start

Không có tài khoản giả hay AI giả trong app. Bài kiểm tra ngoại tuyến dùng dữ liệu mô phỏng rõ ràng trong thư mục tests.

## Tình trạng kiểm chứng

Đọc `QA.md` để biết các kiểm tra đã chạy và giới hạn. Schema và quyền đã được kiểm tra trên dự án Supabase thật tại Singapore; **63 nhóm kiểm tra đều đạt**: 23 backend, 10 giao diện/dự án, 4 tải/dọn âm thanh, 15 tích hợp Supabase và 11 tích hợp Next.js.

Đã gọi DeepSeek thật qua app cho cả ba chế độ `scenery`, `talking`, `face`: 6 yêu cầu phân tích/kịch bản đều HTTP 200, JSON hợp lệ và kết thúc `stop`. Mẫu thử tổng hợp dài 15 giây, có 9 ảnh, không có người hoặc âm thanh. Chi phí tính từ usage của 6 yêu cầu là **$0.003624636** theo giá ngoài cao điểm, không phải hóa đơn; một lượt phân tích thành công trước khi có log không nằm trong tổng này. Không suy rộng mẫu thử sang video thật 30–90 giây.

Ngày **17/10/2026**, ElevenLabs đã đọc được 21 giọng mẫu và tạo lời đọc tiếng Việt thật bằng Flash: 119 ký tự, 6,548 giây, HTTP 200; WAV đã ghép thành MP4 mẫu 15 giây bằng bộ xuất hiện tại, H.264/yuv420p, 30 fps, AAC 48 kHz stereo. Đây là bài kiểm tra kỹ thuật bằng clip tổng hợp; chưa kiểm tra video thực trên điện thoại, CapCut/Facebook hoặc nhân bản giọng. Tài khoản daitaigroup@gmail.com đã có email xác nhận, được cấp admin và 1.000 lượt AI ban đầu. Việc giao thư SMTP cho thành viên vẫn cần xác nhận riêng.

Quản trị viên đầu tiên đã được kích hoạt sau khi đối chiếu đúng email chủ dự án: dữ liệu Supabase xác nhận email đã xác nhận, quyền `admin`, được bật và hạn mức 1.000 lượt. Chưa xác nhận chủ tài khoản đăng nhập giao diện quản trị; việc giao thư SMTP và kiểm tra CapCut/Facebook trên thiết bị thật vẫn cần xác nhận riêng.

Xem `COSTS.md` để tách kết quả DeepSeek đã đo khỏi dự toán, hoặc chạy `pnpm run cost --duration 30 --videos 1000` để lập ngân sách. Hai bài tích hợp Supabase/Next.js chạy riêng theo hướng dẫn trong `QA.md`, không nằm trong `pnpm test`.

## Giấy phép

FFmpeg WASM chứa codec GPL. Thông tin phiên bản/giấy phép đi kèm được chuẩn bị trong public/ffmpeg khi build. Upstream https://github.com/ffmpegwasm/ffmpeg.wasm .
