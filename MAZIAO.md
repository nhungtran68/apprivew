# Tích hợp Maziao — cập nhật 18/10/2026

## Sửa đồng bộ giọng nhân bản từ tài khoản chủ

Đồng bộ quản trị dùng đúng `GET /api/voices/my-voices`, đọc đủ phân trang theo `data.total`. Không thử các loại `custom`/`user` trên thư viện công khai khi endpoint lỗi. Lỗi lấy danh sách, dữ liệu sai hoặc trang thiếu phải báo lỗi trước khi ghi cache.

Giọng nhập từ tài khoản chủ giữ model `vieten_speech` hoặc `lingual_speech_v2` và loại `admin_clone`; thao tác cấp quyền gửi đúng loại. Bản nghe thử ưu tiên `previewUrl`, dùng `refFile` khi chưa có preview riêng theo cách phát của Maziao. Cả hai chỉ nhận HTTPS từ `r2-storage.maziao.com`. Chỉ giọng được chủ website bật chia sẻ mới xuất hiện với thành viên; bộ lọc giọng riêng của thành viên khác vẫn áp dụng trước khi lưu cache.

Sau khi đọc xong toàn bộ danh sách và ghi thành công, các mục `admin_clone` cũ không còn trong snapshot được chuyển thành `unavailable`. Giữ lại dữ liệu giọng và quyết định chia sẻ; không xóa grant, tệp hoặc giọng ở nhà cung cấp. Giọng của lượt đồng bộ mới hơn được giữ nguyên. Không dùng grant cũ để đưa một mục đã bị đánh dấu không còn dùng được trở lại danh sách.

Áp dụng `supabase/voice-sync-guard.sql` sau schema đang có. RPC chỉ dành cho admin kiểm tra clone có thuộc thành viên khác không, so cùng ID gốc qua cả hai model. Trigger bảo vệ thao tác cấp quyền trực tiếp; admin vẫn có thể tắt chia sẻ. Chạy `tests/voice-sync-guard.sql` để kiểm chứng 25 tình huống trong giao dịch tự rollback.

Vào **Tạo giọng nói AI → Giọng dùng chung cho tất cả thành viên → Đồng bộ giọng từ API**. Các giọng nhân bản được xếp trước; admin tự bật từng giọng muốn cấp. Đồng bộ không tự bật chia sẻ và không tạo tác vụ nhân bản/TTS.

## Cấu hình

1. Lấy Personal Access Token từ tài khoản Maziao đã có quyền API.
2. Trong Vercel project `apprivew`, thêm `MAZIAO_API_KEY` vào Production + Preview.
3. Triển khai lại. App tự chọn Maziao khi có khóa. Mặc định model `vieten_speech`; có thể đặt `MAZIAO_MODEL=lingual_speech_v2`.
4. Đăng nhập app, mở Giọng của tôi, làm mới rồi chọn giọng tiếng Việt.

Không nhập token vào chat, không thêm tiền tố `Bearer ` vào Value và không dùng tên biến bắt đầu bằng `NEXT_PUBLIC_`. Server tự gắn header xác thực. `STUDIO_VOICE_PROVIDER=eleven` là cấu hình chủ động để dùng ElevenLabs; lỗi Maziao không tự gọi dịch vụ khác.

## Hành vi

- Lời đọc: một tác vụ `multiParts` cho toàn kịch bản, kiểm tra mỗi 6 giây, nhận MP3 hoặc WAV và đo thời lượng thực. Kiểm tra định dạng từ dữ liệu, giữ đúng MIME/đuôi tệp khi lưu và ghép. Chỉ tạo lại đoạn vượt cảnh, tối đa hai lần. Không cắt lời.
- `vieten_speech`: tổng lời thoại tối thiểu 100 ký tự cho một lần gửi. App báo trước, không tự thêm lời và không gửi lại đoạn rút gọn dưới giới hạn. Chưa áp giới hạn này sang model khác hoặc từng đoạn riêng.
- Nhân bản: một tệp, bản thu tối thiểu 3 giây; trình duyệt lấy tối đa 8 giây đầu và xuất WAV mono 24 kHz/16-bit. Server kiểm tra 3–8 giây, tối đa 1 MB. Người dùng chọn nam/nữ và xác nhận quyền sử dụng giọng.
- Quyền giọng: ID gồm nhà cung cấp và model; giọng cá nhân được ký cho đúng thành viên. Giọng thư viện dùng chung được xác minh lại trong thư viện `type=system`. Giọng nhân bản do chủ website cấp được kiểm tra lại trong `/voices/my-voices` trước mỗi lần tạo lời đọc, kèm kiểm tra model và điều kiện tiếng Việt. Lỗi lấy danh sách không được dùng cache để bỏ qua; giọng đã xóa hoặc thu hồi quyền bị chặn trước khi tính lượt. Không hiển thị toàn bộ giọng riêng của tài khoản Maziao dùng chung.
- Thẻ cấp giọng nhân bản hiển thị trình nghe mẫu thay cho câu trạng thái cũ. Trình nghe và ô chia sẻ tách riêng; bấm nghe không thay đổi quyền. Lỗi 401/403 có hướng dẫn theo bước đọc giọng, đọc cấu hình hoặc tạo lời đọc, không phản chiếu dữ liệu lỗi riêng từ nhà cung cấp.
- Khóa và mẫu thu không nằm trong mã trình duyệt hoặc GitHub. Mẫu giọng tạm Supabase được dọn sau xử lý. Tệp lời đọc chỉ được dọn sau khi đã tải và lưu thành công trên thiết bị. Maziao giữ giọng nhân bản theo chính sách của họ.
- Chi phí: `studio_voice_usage` ghi mã tác vụ hợp lệ, `totalCost` credit thực từ Maziao, cùng model, số ký tự và số đoạn. Kết quả cộng mọi lần tạo lại; thiếu giá giữ là chưa biết. Không coi credit là ký tự hay tiền khi chưa đối chiếu gói mua.
- Khi lời đọc đã tạo và app đã nhận đường dẫn tệp, mất mạng lúc tải có thể xử lý bằng **Tải lại lời đọc**. App giữ tham chiếu trong dự án và cấp lại URL tải theo đúng tài khoản; không gửi TTS mới. Ghi bộ nhớ thiết bị thất bại có **Lưu lại lời đọc** và vẫn giữ tệp riêng.
- Khi mạng lỗi ngay sau gửi hoặc chờ quá 240 giây, app yêu cầu kiểm tra tác vụ ở Maziao trước khi tạo lại để tránh bị tính hai lần.

## Kiểm chứng

- Hợp đồng đối chiếu tài liệu API chính thức và mã client công khai của Maziao, không đoán endpoint.
- 32 kiểm thử Maziao và 10 kiểm thử MP3 ngoại tuyến đã đạt: cách ly giọng thành viên, quyền chia sẻ cũ, model/ID, tác vụ và timeout, không gửi lại POST khi lỗi, WAV/MP3, thời lượng, tạo lại đúng đoạn, dọn tệp và chặn URL ngoài nhà cung cấp. Giọng cá nhân đã xóa không làm mất thư viện; lỗi quyền hoặc kết nối vẫn được báo.
- Bộ kiểm tra hiện có vẫn đạt; TypeScript và production build đạt.
- Thử thật: đã kết nối khóa, đọc được 20 giọng tiếng Việt. Câu 67 ký tự bị từ chối; câu 100 ký tự tạo được MP3 24 kHz mono, dài 5,568 giây. Kết quả ban đầu bị app từ chối do giả định WAV; đã khôi phục chính tác vụ cũ để sửa, không tạo thêm TTS.
- Đã ghép MP3 thật thành MP4 mẫu 15 giây: H.264/yuv420p, 640×360, 30 fps, AAC 48 kHz stereo. Chưa thử nhân bản bằng bản thu riêng của người dùng hoặc đăng lên CapCut/Facebook trên điện thoại thật.
- Sau sửa trên Production, MP3 được lưu/tải đúng MIME và đuôi `.mp3`, byte khớp hoàn toàn. Yêu cầu 99 ký tự bị chặn mà hạn mức không đổi. Tệp và tài khoản QA đã dọn; công cụ khôi phục tạm không có trong mã cuối.

Nguồn: https://app.maziao.com/api-docs và https://app.maziao.com/api-documentation.md .
