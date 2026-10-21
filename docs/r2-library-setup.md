# Thiết lập kho video R2 cho Thư viện iBeeTool

Thư viện lưu video hoàn chỉnh trong **7 ngày**. Hãy dùng một bucket R2 **riêng, chỉ dành cho video của Thư viện**. Quy tắc tự xóa bên dưới áp dụng cho toàn bộ bucket này; tuyệt đối không dùng bucket đang chứa dữ liệu khác.

## 1. Tạo bucket riêng tư

Trong Cloudflare Dashboard → **R2 object storage** → **Create bucket**, tạo bucket, ví dụ `ibeetool-library-videos`. Giữ bucket ở chế độ riêng tư; không bật `r2.dev` hoặc public custom domain. Dùng lớp lưu trữ **Standard** (lớp Infrequent Access có thời gian tính phí tối thiểu 30 ngày, không phù hợp vòng đời 7 ngày).

## 2. Tạo khóa S3 đúng loại

R2 → **Overview** → **Account Details** → **API Tokens** → **Manage** → **Create Account API token**. Chọn **Object Read & Write** và **Apply to specific buckets only** → chọn đúng bucket vừa tạo. Sao chép ngay **Account ID**, **Access Key ID**, **Secret Access Key**. Đây là khóa S3/R2; không dùng Cloudflare Global API Key hoặc token quản lý DNS.

## 3. Thêm biến vào Vercel

Vercel → project **apprivew** → **Settings** → **Environment Variables**. Thêm bốn biến sau cho **Production** và **Preview**, rồi redeploy. Không thêm tiền tố `NEXT_PUBLIC_` và không dán khóa vào GitHub hoặc chat.

| Tên biến | Giá trị | Loại |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | Account ID (32 ký tự hệ 16) trong Cloudflare | Secret |
| `R2_ACCESS_KEY_ID` | Access Key ID của token R2 | Secret |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key của token R2 | Secret |
| `R2_BUCKET` | Tên bucket, ví dụ `ibeetool-library-videos` | Config hoặc Secret |

Ứng dụng đã dùng `SUPABASE_SERVICE_ROLE_KEY` và `CRON_SECRET`; giữ nguyên các biến này. Nếu Preview chưa có `CRON_SECRET`, lịch xóa chỉ chạy ở Production nên không cần thêm để kiểm thử giao diện.

Trước khi triển khai mã mới, cần áp dụng thêm migration
[`20261021102500_library_video_reservation.sql`](../supabase/migrations/20261021102500_library_video_reservation.sql)
trên dự án Supabase `apprivew`. Bảng `library_assets` đã được tạo bằng migration trước; migration mới bổ sung việc giữ chỗ dung lượng an toàn khi nhiều tab tải video đồng thời. Nếu chưa áp dụng, app sẽ báo cơ sở dữ liệu Thư viện chưa được cập nhật và không cấp liên kết tải video lên.

## 4. Cho phép trình duyệt tải video lên R2

R2 → bucket vừa tạo → **Settings** → **CORS policy**, đặt chính sách:

```json
[
  {
    "AllowedOrigins": [
      "https://ibeetool.com",
      "https://www.ibeetool.com",
      "https://apprivew.vercel.app"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Nếu dùng URL Preview khác, thêm **đúng origin của URL đó**; không dùng `*` cho ứng dụng có tài khoản riêng. Khóa R2 chỉ ở máy chủ Vercel; trình duyệt nhận một liên kết tải lên ngắn hạn cho đúng tệp của mình.

## 5. Bật tự xóa sau 7 ngày

R2 → bucket → **Settings** → **Object lifecycle rules** → tạo rule **Expire/Delete objects after 7 days**, áp dụng cho toàn bucket. Lịch dọn của ứng dụng cũng chạy hằng ngày để gỡ mục Thư viện hết hạn và xóa file âm thanh Supabase sau 30 ngày. R2 có thể hoàn tất việc xóa vật lý trong vòng 24 giờ sau mốc hết hạn; giao diện sẽ không phát/tải sau đúng 7 ngày.

## 6. Kiểm tra

Sau khi cấu hình và redeploy, đăng nhập iBeeTool, ghép một video ngắn, chờ thông báo **Đã lưu vào Thư viện**, vào **Thư viện → Video** để xem và tải lại trên thiết bị khác. Nếu tải lên lỗi nhưng MP4 trên trang tạo video vẫn tải được, kiểm tra bốn biến, quyền token đúng bucket, và CORS cho origin đang dùng. Không tạo lại video chỉ để thử tải lên: dùng nút **Thử lưu vào Thư viện** khi trang vẫn giữ video.

Tài liệu chính thức: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/), [object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [giá R2](https://developers.cloudflare.com/r2/pricing/).
