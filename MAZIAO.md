# Tích hợp Maziao — cập nhật 18/10/2026

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
- Quyền giọng: ID gồm nhà cung cấp và model; giọng cá nhân được ký cho đúng thành viên. Giọng chung được xác minh lại trong thư viện `type=system` trước khi dùng vì API có thể bỏ trường chủ sở hữu. Không hiển thị toàn bộ giọng riêng của tài khoản Maziao dùng chung.
- Khóa và mẫu thu không nằm trong mã trình duyệt hoặc GitHub. Tệp tạm Supabase được dọn sau xử lý. Maziao giữ giọng nhân bản theo chính sách của họ.
- Chi phí: `studio_voice_usage` ghi mã tác vụ hợp lệ, `totalCost` credit thực từ Maziao, cùng model, số ký tự và số đoạn. Kết quả cộng mọi lần tạo lại; thiếu giá giữ là chưa biết. Không coi credit là ký tự hay tiền khi chưa đối chiếu gói mua.
- Khi mạng lỗi ngay sau gửi hoặc chờ quá 240 giây, app yêu cầu kiểm tra tác vụ ở Maziao trước khi tạo lại để tránh bị tính hai lần.

## Kiểm chứng

- Hợp đồng đối chiếu tài liệu API chính thức và mã client công khai của Maziao, không đoán endpoint.
- 32 kiểm thử Maziao và 10 kiểm thử MP3 ngoại tuyến đã đạt: cách ly giọng thành viên, quyền chia sẻ cũ, model/ID, tác vụ và timeout, không gửi lại POST khi lỗi, WAV/MP3, thời lượng, tạo lại đúng đoạn, dọn tệp và chặn URL ngoài nhà cung cấp. Giọng cá nhân đã xóa không làm mất thư viện; lỗi quyền hoặc kết nối vẫn được báo.
- Bộ kiểm tra hiện có vẫn đạt; TypeScript và production build đạt.
- Thử thật: đã kết nối khóa, đọc được 20 giọng tiếng Việt. Câu 67 ký tự bị từ chối; câu 100 ký tự tạo được MP3 24 kHz mono, dài 5,568 giây. Kết quả ban đầu bị app từ chối do giả định WAV; đã khôi phục chính tác vụ cũ để sửa, không tạo thêm TTS.
- Đã ghép MP3 thật thành MP4 mẫu 15 giây: H.264/yuv420p, 640×360, 30 fps, AAC 48 kHz stereo. Chưa thử nhân bản bằng bản thu riêng của người dùng hoặc đăng lên CapCut/Facebook trên điện thoại thật.

Nguồn: https://app.maziao.com/api-docs và https://app.maziao.com/api-documentation.md .
