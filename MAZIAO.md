# Tích hợp Maziao — 17/10/2026

## Cấu hình

1. Lấy Personal Access Token từ tài khoản Maziao đã có quyền API.
2. Trong Vercel project `apprivew`, thêm `MAZIAO_API_KEY` vào Production + Preview.
3. Triển khai lại. App tự chọn Maziao khi có khóa. Mặc định model `vieten_speech`; có thể đặt `MAZIAO_MODEL=lingual_speech_v2`.
4. Đăng nhập app, mở Giọng của tôi, làm mới rồi chọn giọng tiếng Việt.

Không nhập token vào chat, không thêm tiền tố `Bearer ` vào Value và không dùng tên biến bắt đầu bằng `NEXT_PUBLIC_`. Server tự gắn header xác thực. `STUDIO_VOICE_PROVIDER=eleven` là cấu hình chủ động để dùng ElevenLabs; lỗi Maziao không tự gọi dịch vụ khác.

## Hành vi

- Lời đọc: một tác vụ `multiParts` cho toàn kịch bản, kiểm tra mỗi 6 giây, tải WAV và đo thời lượng thực. Chỉ tạo lại đoạn vượt cảnh, tối đa hai lần. Không cắt lời.
- Nhân bản: một tệp, bản thu tối thiểu 3 giây; trình duyệt lấy tối đa 8 giây đầu và xuất WAV mono 24 kHz/16-bit. Server kiểm tra 3–8 giây, tối đa 1 MB. Người dùng chọn nam/nữ và xác nhận quyền sử dụng giọng.
- Quyền giọng: ID gồm nhà cung cấp và model; giọng cá nhân được ký cho đúng thành viên. Không hiển thị toàn bộ giọng riêng của tài khoản Maziao dùng chung.
- Khóa và mẫu thu không nằm trong mã trình duyệt hoặc GitHub. Tệp tạm Supabase được dọn sau xử lý. Maziao giữ giọng nhân bản theo chính sách của họ.
- Chi phí: `studio_voice_usage` ghi `totalCost` credit thực từ Maziao, cùng model, số ký tự và số đoạn. Không coi credit là ký tự hay tiền khi chưa đối chiếu gói mua.
- Khi mạng lỗi ngay sau gửi hoặc chờ quá 240 giây, app yêu cầu kiểm tra tác vụ ở Maziao trước khi tạo lại để tránh bị tính hai lần.

## Kiểm chứng

- Hợp đồng đối chiếu tài liệu API chính thức và mã client công khai của Maziao, không đoán endpoint.
- 16 kiểm thử Maziao ngoại tuyến đã đạt: cách ly giọng thành viên, quyền chia sẻ cũ, model/ID, tác vụ và timeout, không gửi lại POST khi lỗi, WAV, thời lượng, tạo lại đúng đoạn, dọn tệp và chặn URL ngoài nhà cung cấp. Giọng cá nhân đã xóa không làm mất thư viện; lỗi quyền hoặc kết nối vẫn được báo.
- Bộ kiểm tra hiện có vẫn đạt; TypeScript và production build đạt.
- Những kiểm tra dùng API mô phỏng không chứng minh token, gói, số dư hoặc chất lượng giọng thực tế. Chạy thử thật sau khi `MAZIAO_API_KEY` có trong bản triển khai mới.

Nguồn: https://app.maziao.com/api-docs và https://app.maziao.com/api-documentation.md .
