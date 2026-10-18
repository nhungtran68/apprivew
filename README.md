# Lời Kể · apprivew

Web app tiếng Việt: quay video → xác định thông điệp → chọn hướng kịch bản → tạo giọng → tải MP4.

## Cá nhân hóa và chọn kịch bản

Mỗi thành viên có mục **Hiểu về tôi**: tên kênh, chủ đề, người xem, giọng điệu, cách xưng hô, thông tin nền, lời nhắn cuối và lời dặn riêng cho AI. Hồ sơ lưu theo tài khoản trong Supabase, tách quyền bằng RLS; không tự suy diễn tính cách hoặc học từ nội dung thành viên khác. Video mới dùng hồ sơ đã lưu; từng video có thể đổi người xem, giọng kể và thông tin cần nói đúng.

Chọn một trong bốn dạng: **review, kể chuyện, chia sẻ mẹo, giới thiệu sản phẩm**. AI phân tích ảnh làm tư liệu và đề xuất ba góc có thông điệp, câu mở và lý do phù hợp. Người dùng chọn góc rồi mới tạo một kịch bản có mở đầu, ý chính và kết thúc theo thời lượng. Phân tích cảnh không được dùng làm lời thoại mặc định. Khi thiếu giá, trải nghiệm, công dụng hoặc kết quả, AI cần hỏi hoặc chọn góc ít giả định thay vì bịa.

Ba góc ý tưởng nằm trong cùng lần phân tích; chỉ góc đã chọn được viết thành kịch bản. Đổi góc rồi viết lại là một yêu cầu DeepSeek mới, tạo lại lời đọc tính riêng.

## Giọng tiếng Việt và thư viện phổ biến

### Maziao

Thêm `MAZIAO_API_KEY` (Personal Access Token) vào Vercel Production + Preview rồi triển khai lại. App tự chọn Maziao khi có khóa này. `MAZIAO_MODEL` mặc định `vieten_speech`, có thể đổi sang `lingual_speech_v2`; cả hai được xác minh lại qua `/api/configs` về hỗ trợ tiếng Việt và nhân bản. Có thể đặt `STUDIO_VOICE_PROVIDER=eleven` để chủ động dùng ElevenLabs. App không tự chuyển nhà cung cấp khi lỗi, tránh phát sinh phí ngoài dự kiến.

Giọng cá nhân được cấp quyền riêng theo thành viên bằng HMAC và RLS. ID được gắn `maziao:<model>:<id>` để không nhầm với ElevenLabs. Danh sách chỉ lấy giọng công khai tiếng Việt và giọng có quyền đã ký của thành viên đang đăng nhập; không trả thư viện giọng riêng của toàn bộ tài khoản Maziao.

Trình duyệt chuẩn hóa mẫu nhân bản thành WAV mono 24 kHz/16-bit, lấy tối đa 8 giây đầu, yêu cầu bản gốc có ít nhất 3 giây. Server kiểm tra lại WAV, thời lượng và giới hạn 1 MB. Người dùng xác nhận quyền dùng giọng và chọn nam/nữ. Mẫu tạm trong Supabase được dọn sau yêu cầu; giọng đã nhân bản được Maziao giữ để tạo lời đọc.

Lời đọc dùng `multiParts`: gửi các đoạn trong một tác vụ, kiểm tra trạng thái mỗi 6 giây rồi nhận MP3 hoặc WAV. Server xác minh định dạng từ byte thực, đo thời lượng, giữ đúng MIME và đuôi tệp trong kho riêng; không giả định mọi kết quả là WAV. Không tự gửi lại tác vụ khi lỗi mạng hoặc hết thời gian chờ. Chỉ rút gọn và tạo lại các đoạn vượt cảnh, tối đa hai lần, không cắt mất lời để ép khớp. Luồng Maziao chờ tối đa 240 giây; quản trị viên kiểm tra tác vụ trước khi tạo lại nếu quá lâu.

Model `vieten_speech` yêu cầu tổng lời thoại tối thiểu 100 ký tự cho một lần gửi theo kết quả thử thật. App báo trước và chặn yêu cầu quá ngắn trước khi trừ hạn mức hoặc gửi TTS; không tự thêm lời để đủ ký tự. Lần tạo lại ngắn hơn giới hạn cũng dừng để sửa kịch bản. Chưa suy rộng giới hạn này sang từng đoạn riêng hoặc model khác.

Log `studio_voice_usage` ghi model, mã tác vụ đã kiểm tra, số ký tự, số đoạn và `totalCost` credit thực do Maziao trả, không ghi token, lời thoại, mẫu giọng hoặc URL cá nhân. Kết quả thành công cộng credit của các lần tạo lại; chi phí thiếu được giữ là chưa biết. Không mặc định 1 ký tự luôn bằng 1 credit; không quy đổi tiền khi chưa đối chiếu gói đã mua. Hạn mức AI nội bộ độc lập với credit Maziao.

Tài liệu: [Maziao API](https://app.maziao.com/api-docs), [hợp đồng API](https://app.maziao.com/api-documentation.md).

### ElevenLabs

App truy vấn Voice Library ElevenLabs bằng `language=vi`, ưu tiên tối đa 10 giọng có mô tả phù hợp kể chuyện, hội thoại, quảng cáo hoặc mạng xã hội. Thêm tối đa 5 giọng phổ biến toàn thư viện theo `cloned_by_count`. Số người đã thêm, ngôn ngữ và bản nghe mẫu lấy từ provider, không tự tạo tên hay số liệu. Danh sách được làm mới với cache tối đa 5 phút; có thể thay đổi khi chủ giọng rút chia sẻ.

Giọng thư viện qua API và nhân bản giọng nhanh cần **gói ElevenLabs trả phí (Starter trở lên) của quản trị viên**. Thành viên app không cần mua riêng. App kiểm tra gói trước khi nhập/dùng giọng thư viện hoặc gửi yêu cầu nhân bản, báo lỗi cụ thể và không trừ lượt AI nội bộ khi bị chặn ở bước kiểm tra gói. Chỉ giọng công khai được server xác minh trong danh sách tuyển chọn mới được nhập; quyền cá nhân vẫn được ký riêng theo thành viên. Nghe mẫu dùng tệp có sẵn; bấm tạo lời đọc mới phát sinh TTS.

Nguồn: [Voice Library](https://elevenlabs.io/docs/eleven-creative/voices/voice-library), [API thư viện](https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared).

## Công nghệ

Next.js App Router chạy trên Vercel; Supabase Auth/Postgres/Storage cho thành viên và tệp riêng; DeepSeek Flash đọc ảnh mẫu và viết kịch bản; Maziao hoặc ElevenLabs tạo giọng; FFmpeg WASM ghép MP4 ngay trong trình duyệt. Không dùng Gemini.

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
| MAZIAO_API_KEY | Personal Access Token Maziao, chỉ ở server |
| MAZIAO_MODEL | vieten_speech (mặc định) hoặc lingual_speech_v2 |
| STUDIO_VOICE_PROVIDER | maziao hoặc eleven; mặc định Maziao khi có MAZIAO_API_KEY |
| STUDIO_ENCRYPTION_KEY | Chuỗi ngẫu nhiên ít nhất32 ký tự, bảo vệ quyền dùng giọng cá nhân; giữ ổn định |
| STUDIO_SHARED_VOICE_IDS | Tùy chọn: danh sách voice ID được chia sẻ, phân cách bằng dấu phẩy |

Không đưa file .env.local hay khóa bí mật vào GitHub. Không dùng service_role key trong trình duyệt.

## Tài khoản và hạn mức

Thành viên dùng email/mật khẩu; đăng ký mới mặc định chưa có quyền dùng AI. Chủ dự án thực hiện một lần trong Supabase SQL Editor, thay UUID bằng tài khoản thật:

    update public.studio_members
    set role='admin', enabled=true, ai_units_limit=1000
    where user_id='UUID_TAI_KHOAN_CUA_BAN';

Mở /quan-tri để duyệt thành viên và cấp hạn mức. Đơn vị là lượt xử lý: mỗi yêu cầu DeepSeek1lượt; mỗi lần tạo tiếng ceil(số ký tự/100)lượt; nhân bản giọng10lượt. Lần tạo lại cũng tính; không tự hoàn lượt khi đã gửi yêu cầu tới dịch vụ. Đây là hạn mức nội bộ của app, không phải số tiền hoặc số video cố định.

Khóa DeepSeek, Maziao và ElevenLabs do quản trị viên nối một lần. Thành viên không thấy khóa và không phải có tài khoản nhà cung cấp AI. Mỗi thành viên chỉ dùng giọng được phép: giọng mẫu, giọng chia sẻ được quản trị viên chỉ định, và giọng đã tạo cho chính họ.

## Phân tích video với DeepSeek

Bản này trích4–16 ảnh JPEG có thời gian từ clip, tối đa640px/ảnh, tổng yêu cầu dưới3MB để hợp giới hạn Vercel. DeepSeek nhìn ảnh mẫu, không xem liên tục và không nghe tiếng gốc. Những thao tác nhanh giữa hai ảnh có thể bị bỏ sót. Người dùng cần kiểm tra cảnh và xác nhận ý định. Có thể gõ ý tưởng; nút nói dùng nhận dạng giọng nói của trình duyệt nếu có hỗ trợ, với sự cho phép của người dùng.

API DeepSeek hiện được cấu hình theo tài liệu chính thức: https://api-docs.deepseek.com/guides/vision/ và https://api-docs.deepseek.com/guides/json_mode/ .

## Khi nhân bản giọng báo thiếu quyền

Quản trị viên mở ElevenLabs → Developers → API Keys, sửa đúng khóa đang dùng ở Vercel và bật **Voices → Write**, rồi Save. Lỗi này thuộc quyền tạo giọng; quyền đọc giọng và tạo lời đọc được kiểm tra riêng. Nếu giữ nguyên Secret key thì không cần đổi cấu hình Vercel. Sau khi lưu quyền, quay lại app chọn bản thu và thử lại một lần.

## Lưu dữ liệu và xuất video

Video gốc và dự án tự lưu trên trình duyệt/thiết bị hiện tại bằng IndexedDB, có thể tải bản sao .loike để chuyển thiết bị. Bản đầu chưa đồng bộ thư viện dự án lên cloud. Supabase lưu hồ sơ, quyền, hạn mức, giọng được phép và tệp âm thanh riêng. Tệp lời đọc được tải về trình duyệt rồi xóa khỏi kho tạm; mẫu nhân bản giọng gửi tới nhà cung cấp giọng đang được quản trị viên chọn.

MP4 vừa ghép được giữ khi chuyển bước, đổi tiêu đề hoặc xem lại hồ sơ; chỉ thay đổi đầu vào âm thanh/video mới làm mất hiệu lực bản xuất. Nút tải dùng liên kết bền vững; trình duyệt hỗ trợ có thêm **Lưu vào thư mục…**, điện thoại hỗ trợ có **Chia sẻ tệp video**, cùng liên kết mở video để lưu dự phòng. Cần lưu MP4 trước khi đóng/tải lại trang hoặc chuyển sang dự án khác; bản MP4 hoàn chỉnh chưa lưu trong IndexedDB.

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

Đọc `QA.md` để biết các kiểm tra đã chạy và giới hạn. Bản ngày **18/10/2026** có **116 kiểm tra ngoại tuyến đạt**, cùng TypeScript và production build. Maziao thật đã trả 20 giọng Việt; MP3 100 ký tự đã được khôi phục, xác minh, lưu/tải qua Supabase riêng và ghép thành MP4 mẫu 15 giây mà không tạo lại TTS trả phí. Các bài tích hợp Supabase/Next.js của đợt trước được ghi riêng trong `QA.md`, không tính vào 116 bài ngoại tuyến.

Đã gọi DeepSeek thật qua app cho cả ba chế độ `scenery`, `talking`, `face`: 6 yêu cầu phân tích/kịch bản đều HTTP 200, JSON hợp lệ và kết thúc `stop`. Mẫu thử tổng hợp dài 15 giây, có 9 ảnh, không có người hoặc âm thanh. Chi phí tính từ usage của 6 yêu cầu là **$0.003624636** theo giá ngoài cao điểm, không phải hóa đơn; một lượt phân tích thành công trước khi có log không nằm trong tổng này. Không suy rộng mẫu thử sang video thật 30–90 giây.

Ngày **17/10/2026**, ElevenLabs đã đọc được 21 giọng mẫu và tạo lời đọc tiếng Việt thật bằng Flash: 119 ký tự, 6,548 giây, HTTP 200; WAV đã ghép thành MP4 mẫu 15 giây bằng bộ xuất hiện tại, H.264/yuv420p, 30 fps, AAC 48 kHz stereo. Đây là bài kiểm tra kỹ thuật bằng clip tổng hợp; chưa kiểm tra video thực trên điện thoại, CapCut/Facebook hoặc nhân bản giọng. Tài khoản daitaigroup@gmail.com đã có email xác nhận, được cấp admin và 1.000 lượt AI ban đầu. Việc giao thư SMTP cho thành viên vẫn cần xác nhận riêng.

Quản trị viên đầu tiên đã được kích hoạt sau khi đối chiếu đúng email chủ dự án: dữ liệu Supabase xác nhận email đã xác nhận, quyền `admin`, được bật và hạn mức 1.000 lượt. Chưa xác nhận chủ tài khoản đăng nhập giao diện quản trị; việc giao thư SMTP và kiểm tra CapCut/Facebook trên thiết bị thật vẫn cần xác nhận riêng.

Xem `COSTS.md` để tách kết quả DeepSeek đã đo khỏi dự toán, hoặc chạy `pnpm run cost --duration 30 --videos 1000` để lập ngân sách. Hai bài tích hợp Supabase/Next.js chạy riêng theo hướng dẫn trong `QA.md`, không nằm trong `pnpm test`.

## Giấy phép

FFmpeg WASM chứa codec GPL. Thông tin phiên bản/giấy phép đi kèm được chuẩn bị trong public/ffmpeg khi build. Upstream https://github.com/ffmpegwasm/ffmpeg.wasm .
