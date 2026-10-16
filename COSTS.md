# Chi phí AI cho Lời Kể

Giá kiểm tra ngày **16/10/2026**, đơn vị **USD**, dùng API trực tiếp của DeepSeek. Các con số cho từng video là phép ước tính, chưa phải kết quả đo API thật. Phần1–5 tính DeepSeek; phần6–10 cộng giọng đọc và hạ tầng. Giá chưa gồm thuế hoặc phí thanh toán.

## 1. Model và mức giá

App hiện dùng `deepseek-flash`, tương ứng DeepSeek-V4.1-Flash, để đọc ảnh trích và viết lời thoại. `deepseek-v4-pro` chỉ nhận văn bản nên không dùng để xem cảnh. Cả hai hỗ trợ chế độ suy luận và JSON. [Bảng model và giá chính thức](https://api-docs.deepseek.com/quick_start/pricing/)

Giá cho **1 triệu token**:

| Model / loại token | Ngoài giờ cao điểm | Giờ cao điểm |
|---|---:|---:|
| Flash — đầu vào có cache | $0.003 | $0.006 |
| Flash — đầu vào chưa có cache | $0.15 | $0.30 |
| Flash — đầu ra | $0.60 | $1.20 |
| Pro — đầu vào có cache | $0.022 | $0.044 |
| Pro — đầu vào chưa có cache | $0.66 | $1.32 |
| Pro — đầu ra | $1.98 | $3.96 |

Giờ cao điểm theo giờ Việt Nam là **08:00–11:00 và 13:00–17:00, thứ Hai đến thứ Sáu**, trừ ngày lễ Trung Quốc. Các giờ còn lại, cuối tuần và ngày lễ Trung Quốc dùng giá ngoài cao điểm. [Nguồn giá và lịch áp dụng](https://api-docs.deepseek.com/quick_start/pricing/)

## 2. Ảnh được tính tiền thế nào?

DeepSeek đổi ảnh thành token rồi tính chung với đầu vào văn bản. `detail: "low"` thu ảnh về mức **512 × 512 pixel** trước xử lý. **512 ở đây là kích thước ảnh, không phải số token.** Tài liệu không cam kết một số token cố định cho mọi ảnh ở chế độ này. Trần hiện công bố là **1.024 token mỗi ảnh**; thông tin 384 token của model thử nghiệm trước đây không dùng cho model hiện tại. [Quy tắc xử lý và tính token ảnh](https://api-docs.deepseek.com/guides/vision/)

Calculator chính thức đưa ra ước tính theo kích thước: 512 × 512 khoảng 184 token; 640 × 360 khoảng 192; 360 × 640 khoảng 200. Đây là kết quả tính theo bộ tính hiện tại, không phải số đã đo từ API của app. DeepSeek yêu cầu lấy trường `usage` trong phản hồi API làm căn cứ thực tế. [Calculator và lưu ý sai số](https://api-docs.deepseek.com/quick_start/token_usage/)

Vì vậy, bảng dự toán dưới dùng hai trường hợp: **200 token/ảnh để hình dung mức dùng phổ biến**, và **1.024 token/ảnh để dự phòng riêng phần ảnh**. Trường hợp dự phòng không phải trần tổng chi phí của một video.

## 3. Ước tính một lần phân tích và một lần viết lời

Theo mã hiện tại, app lấy tối đa 16 ảnh: clip 15 giây có 9 ảnh; clip 30, 60 và 90 giây đều có 16 ảnh. AI xem những ảnh này cùng lời dặn, không nghe âm thanh gốc và không xem liên tục toàn bộ video.

Giả định chung của phép tính:

- Hai yêu cầu: phân tích cảnh rồi viết kịch bản; đều dùng Flash, tắt suy luận.
- Tổng đầu vào văn bản: 3.000 token; không tính lợi ích cache.
- Đầu ra phân tích: 800 token. Đầu ra kịch bản: `150 + 6 × số giây` token, gồm lời và cấu trúc JSON.
- Không có yêu cầu viết lại, gọi lỗi hoặc rút ngắn lời sau khi tạo giọng.

| Video | Ảnh | Ước 200 token/ảnh: ngoài / cao điểm | Dự phòng 1.024 token/ảnh: ngoài / cao điểm |
|---|---:|---:|---:|
| 15 giây | 9 | $0.00134 / $0.00269 | $0.00246 / $0.00491 |
| 30 giây | 16 | $0.00161 / $0.00322 | $0.00359 / $0.00717 |
| 60 giây | 16 | $0.00172 / $0.00343 | $0.00369 / $0.00739 |
| 90 giây | 16 | $0.00182 / $0.00365 | $0.00380 / $0.00760 |

Đây là **chi phí DeepSeek ước tính cho hai yêu cầu**, không phải giá một video hoàn chỉnh. Lời dặn dài, phân tích chi tiết, nhiều lần viết lại hoặc phản hồi gần giới hạn token đều làm chi phí tăng. Ví dụ, giữ giả định 3.000 token văn bản và 16 ảnh ở trần ảnh, nhưng cả hai phản hồi đều dùng đủ 4.096 token, chi phí sẽ khoảng **$0.00782 ngoài cao điểm / $0.01565 cao điểm**.

## 4. Những chế độ nên thử

| Chế độ đề xuất | Cách dùng | Điều cần đo |
|---|---|---|
| Nhanh — mặc định | Flash, tắt suy luận, ảnh `low`, xuất JSON | Đúng ý, đúng cảnh, ít sửa, thời gian chờ |
| Kể kỹ hơn | Phân tích như mặc định; chỉ bước viết lời bật suy luận `low` | Có giảm số lần sửa và cải thiện lời kể không? |
| Kiểm tra kỹ | Flash suy luận `low` hoặc `high` cho yêu cầu có nhiều ràng buộc | Lợi ích có xứng với thời gian chờ và token tăng thêm không? |

Đây là phương án thử nghiệm, chưa phải kết luận chất lượng. DeepSeek mặc định bật suy luận ở mức `high`; app nên đặt chế độ rõ ràng để tránh phát sinh ngoài dự kiến. Bật suy luận có thể tăng token đầu ra, và cần chừa đủ giới hạn cho phần JSON cuối cùng. [Cách bật/tắt suy luận](https://api-docs.deepseek.com/guides/thinking_mode/)

JSON giúp app đọc kết quả có cấu trúc nhưng vẫn cần kiểm tra nội dung rỗng, dữ liệu thiếu và phản hồi bị cắt do hết token. [Hướng dẫn JSON chính thức](https://api-docs.deepseek.com/guides/json_mode/)

## 5. Ghi chi phí thực tế khi thử

Mỗi yêu cầu nên lưu model, chế độ, giờ gọi, số ảnh, thời gian xử lý, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens` và phần `reasoning_tokens` nếu có. Không cộng token suy luận thêm lần nữa nếu chúng đã nằm trong tổng completion. Các trường này được mô tả trong [phản hồi Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).

Công thức đối soát theo từng yêu cầu:

```text
USD = (token cache hit × giá hit
     + token cache miss × giá miss
     + token completion × giá đầu ra) / 1.000.000
```

Chọn giá đúng khung giờ của từng yêu cầu, rồi cộng các yêu cầu thuộc cùng một video. Tạo giọng, tạo lại giọng và nhân bản giọng được ghi thành **chi phí ElevenLabs riêng**, theo tài khoản và gói thực tế. Ghép MP4 trong trình duyệt không gọi DeepSeek hay ElevenLabs thêm lần nữa.

## 6. ElevenLabs: giọng đọc

App đang dùng `eleven_flash_v2_5`, hỗ trợ tiếng Việt, với đầu ra PCM 24 kHz. Giá API Flash/Turbo hiện là **$0.04/1.000 ký tự**; `eleven_v4` là **$0.08/1.000 ký tự** nếu muốn thử chất giọng khác. API tính theo ký tự đã tạo, không theo thời lượng video. [Giá ElevenAPI](https://elevenlabs.io/pricing/api), [ngôn ngữ và model](https://elevenlabs.io/docs/overview/models)

Để lập dự toán, **giả định 15 ký tự lời Việt mỗi giây**: clip 15/30/60/90 giây có lần lượt 225/450/900/1.350 ký tự. Đây là giả định ngân sách, không phải tốc độ nói được nhà cung cấp bảo đảm; lời kể thực tế cần đo sau khi tạo âm thanh.

```text
ElevenLabs Flash USD = tổng ký tự của tất cả yêu cầu tạo giọng × 0.04 / 1.000
```

Một đoạn tạo lại sẽ tính thêm ký tự của đoạn đó. Tải hoặc ghép lại cùng tệp âm thanh không tự tạo thêm chi phí TTS. Không coi hạn mức “lượt AI” trong app là credit ElevenLabs hoặc USD.

## 7. Tổng AI ước tính cho từng video

Bảng này cộng **hai yêu cầu DeepSeek ở trường hợp 200 token/ảnh** trong phần 3 với Flash TTS. “Dự phòng TTS 1.5×” dành thêm 50% ngân sách giọng đọc cho việc tạo lại một số đoạn; **không tăng toàn bộ DeepSeek lên 1.5×**. Chưa tính các yêu cầu DeepSeek rút câu phát sinh sau khi đo giọng, nhân bản giọng hay hạ tầng.

| Video | Ký tự giả định | Flash TTS một lượt | Tổng AI một lượt: ngoài / cao điểm | Tổng AI, dự phòng TTS 1.5×: ngoài / cao điểm |
|---|---:|---:|---:|---:|
| 15 giây | 225 | $0.00900 | $0.01034 / $0.01169 | $0.01484 / $0.01619 |
| 30 giây | 450 | $0.01800 | $0.01961 / $0.02122 | $0.02861 / $0.03022 |
| 60 giây | 900 | $0.03600 | $0.03772 / $0.03943 | $0.05572 / $0.05743 |
| 90 giây | 1.350 | $0.05400 | $0.05582 / $0.05765 | $0.08282 / $0.08465 |

Đây là phép tính sử dụng, không phải giá bán mỗi video hoặc cam kết trần chi phí. Giá DeepSeek thay theo giờ gọi; giá TTS theo ký tự, nên phần giọng đọc có thể chiếm phần lớn chi phí AI của luồng này.

## 8. Dự toán tháng cho video 30 giây

Giữ các giả định trên, mỗi video có 450 ký tự và 16 ảnh. “Ký tự TTS có dự phòng” là 675 ký tự trung bình/video khi áp dụng ngân sách 1.5×. Tổng ở bảng là **giá trị sử dụng AI theo đơn giá API**, trước cách phân bổ gói thuê bao ở phần 9.

| Video / tháng | Ký tự TTS gốc / có dự phòng | DeepSeek: ngoài / cao điểm | TTS một lượt / 1.5× | Tổng AI một lượt: ngoài / cao điểm | Tổng AI với TTS 1.5×: ngoài / cao điểm |
|---|---:|---:|---:|---:|---:|
| 100 | 45.000 / 67.500 | $0.16 / $0.32 | $1.80 / $2.70 | $1.96 / $2.12 | $2.86 / $3.02 |
| 500 | 225.000 / 337.500 | $0.80 / $1.61 | $9.00 / $13.50 | $9.80 / $10.61 | $14.30 / $15.11 |
| 1.000 | 450.000 / 675.000 | $1.61 / $3.22 | $18.00 / $27.00 | $19.61 / $21.22 | $28.61 / $30.22 |

## 9. Thuê bao ElevenLabs và tránh cộng tiền hai lần

Bảng API hiện liệt kê gói tháng và lượng Flash/Turbo tương ứng: Starter **$6 / 150.000 ký tự**, Creator **$22 / 550.000 ký tự**, Pro **$99 / 2.475.000 ký tự**. Đây là dung lượng khi phân bổ gói cho TTS; dùng sản phẩm khác sẽ làm phần còn lại cho TTS giảm. Không dùng ưu đãi tháng đầu để tính chi phí dài hạn. [Gói và lượng API bao gồm](https://elevenlabs.io/pricing/api)

**Không cộng cả phí thuê bao và toàn bộ giá trị TTS sử dụng đã nằm trong gói.** Ví dụ, 1.000 video 30 giây không tạo lại dùng khoảng 450.000 ký tự: nếu toàn bộ hạn mức Creator còn dành cho app, số này nằm trong 550.000 ký tự. Hóa đơn ElevenLabs dự kiến vẫn là $22; cộng DeepSeek khoảng $1.61–$3.22 thì ngân sách AI tháng khoảng **$23.61–$25.22**, trước thuế và hạ tầng. Không tính thành $22 + $18 + DeepSeek.

Với dự phòng TTS 1.5×, 1.000 video dùng khoảng 675.000 ký tự, vượt dung lượng Creator giả định 125.000 ký tự, có giá trị thêm khoảng $5 theo đơn giá Flash. Cần kiểm tra tùy chọn trả theo sử dụng/top-up, điều kiện vượt gói và hạn mức thực tế của tài khoản trước khi xem đây là hóa đơn dự kiến.

Tài khoản đang có có thể thuộc Creative hoặc gói cũ. Trang Creative vẫn mô tả một quỹ credit dùng chung và hệ số theo model, trong khi trang ElevenAPI hiện công bố USD. Vì vậy, **xem gói, số dư và quyền API thực tế trong dashboard**; không mặc định mọi tài khoản đều quy đổi “1 ký tự = 0.5 credit”. [Cách tính Creative](https://elevenlabs.io/pricing)

Nhân bản giọng hiện dùng IVC: cần Starter trở lên, bản thu sạch khoảng 1–2 phút và sự đồng ý của chủ giọng. Gói Starter có 10 vị trí giọng riêng, Creator 30, Pro 160; số thành viên có giọng riêng có thể khiến giới hạn vị trí quan trọng hơn số ký tự TTS. Chưa có căn cứ trong bảng giá đã kiểm tra để gán một mức USD cố định cho mỗi lần tạo IVC; “10 lượt AI” hiện tại chỉ là quy ước hạn mức của app. [IVC và quyền dùng](https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-is-my-voices), [vị trí giọng](https://elevenlabs.io/docs/help-center/account/general/how-many-voice-slots-do-i-get-per-tier-and-how-can-i-increase-it)

## 10. Hạ tầng, tách khỏi tiền AI

Supabase Free là **$0/tháng**, có 500 MB database, 1 GB tệp, 5 GB egress; dự án Free có thể tạm dừng sau một tuần không hoạt động. Pro từ **$25/tháng** cho cấu hình dự án đầu tiên được bao gồm; tăng compute, thêm dự án hoặc vượt lượng dùng có thể tăng tiền. [Giá Supabase](https://supabase.com/pricing)

Vercel Hobby là **$0/tháng**, dành cho mục đích cá nhân phi thương mại. Pro từ **$20/tháng**, có $20 usage credit; phát sinh theo tài nguyên và chỗ ngồi bổ sung cần đối soát riêng. [Giá Vercel](https://vercel.com/pricing), [điều kiện Hobby](https://vercel.com/docs/plans/hobby)

Ví dụ dự toán vận hành thương mại với một chỗ ngồi Vercel Pro, một Supabase Pro cơ bản và ElevenLabs Creator là **$67/tháng phí gói ban đầu** ($20 + $25 + $22), cộng DeepSeek, phần sử dụng vượt gói, SMTP, domain và thuế. Với 1.000 video 30 giây một lượt theo giả định trên, chưa vượt hạn mức TTS Creator, tổng tham chiếu khoảng **$68.61–$70.22/tháng** trước các phần phát sinh ấy. Đây là phép tính cấu hình minh họa, chưa phải đề xuất nâng gói hoặc hóa đơn của tài khoản.

Video gốc và ghép MP4 ở thiết bị giúp giảm tải máy chủ, nhưng vẫn có phí lưu/tải lời đọc, mẫu giọng và tải bộ FFmpeg lần đầu. Muốn chốt giá thành cần đối soát `usage` DeepSeek, ký tự ElevenLabs, số lần tạo lại, lưu lượng và gói thực của cả ba dịch vụ sau bài thử thật.
