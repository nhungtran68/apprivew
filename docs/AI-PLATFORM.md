# Nền tảng Lời Kể AI

## Phạm vi của giai đoạn này

Đây là bộ khung giao diện để mở rộng ứng dụng Lời Kể Studio thành nền tảng gồm nhiều công cụ AI. Trang tổng quan, điều hướng, tìm công cụ, khu vực tài khoản và sáu trang module dùng chung một cấu trúc. Các workspace mới hiển thị rõ trạng thái đang hoàn thiện và các tính năng dự kiến.

Sáu trang module chưa phải sáu bộ xử lý AI mới. Giai đoạn này không tạo API sinh nội dung, biểu mẫu tạo kết quả, tác vụ giả, hệ thống thanh toán hoặc cơ chế trừ credit mới. Hai lối đi đến chức năng đã có được giữ rõ ràng: Video Review mở `/studio`; Giọng nói AI mở `/studio?view=voices`.

Quy trình xử lý video hiện tại, dữ liệu thành viên, cấu hình nhà cung cấp, hạn mức và dữ liệu dự án trên thiết bị tiếp tục dùng nền tảng có sẵn.

## Công nghệ và cách chia thành phần

Các phiên bản dưới đây lấy từ [package.json](../package.json):

| Thành phần | Đang sử dụng | Vai trò |
| --- | --- | --- |
| Next.js | 16.3.4, App Router | Route, layout, metadata, Server Components và API hiện có |
| React | 19.2.6 | Giao diện và các phần tương tác trên trình duyệt |
| TypeScript | 5.9.3 | Kiểu dữ liệu dùng chung giữa điều hướng và workspace |
| Node.js | Từ 22.13.0 | Môi trường chạy và build |
| Quản lý gói | pnpm 11.25.0 | Cài đặt dependency theo cấu hình dự án |
| Supabase | SDK JavaScript và SSR hiện có | Đăng nhập, thành viên, hồ sơ, giọng cá nhân và kho tệp |
| CSS Modules | Trong `components/platform/` | Giới hạn phạm vi style của giao diện nền tảng |
| FFmpeg | Bộ xử lý video hiện có | Chỉ phục vụ quy trình xuất video trong Studio |

Nội dung tĩnh được giữ trong page hoặc Server Component. Các phần cần trạng thái trình duyệt được tách thành thành phần nhỏ: tìm kiếm, menu điện thoại và dữ liệu tài khoản. `PlatformShell` nhận nội dung trang qua `children`, cung cấp bộ điều hướng chung và `AccountProvider`.

Dashboard và trang module không nhập `Studio`, `video-export` hoặc FFmpeg để hiển thị thẻ công cụ. Bộ xử lý video vẫn được nạp từ luồng Studio khi cần. Việc mở trang tổng quan không bắt đầu một tác vụ AI.

Nguồn triển khai chính:

- [Registry module](../lib/studio-modules.ts): dữ liệu chung cho trang tổng quan, điều hướng, tìm kiếm và route.
- [PlatformShell](../components/platform/PlatformShell.tsx): layout giao diện, menu, thanh tìm kiếm và liên kết tài khoản.
- [AccountProvider](../components/platform/AccountProvider.tsx): lấy trạng thái thành viên từ API hiện có.
- [ToolSearch](../components/platform/ToolSearch.tsx): tìm module theo tên và mô tả, hỗ trợ từ khóa tiếng Việt có hoặc không dấu.
- [ModulePage](../components/platform/ModulePage.tsx): trang chuẩn bị dùng chung cho các module.
- [ModuleTone](../components/platform/ModuleTone.module.css): biến màu dùng chung cho nền, chữ, biểu tượng, nút và điều hướng của từng module.

Nhận diện màu gồm giọng nói tím, video xanh dương, kịch bản cam, review hồng, ảnh xanh ngọc và công cụ khác cyan. Trường `tone` trong registry chọn bộ biến tương ứng; khóa `slate` hiện mang màu cyan để giữ nguyên hợp đồng cấu hình. Muốn đổi màu một module, sửa bộ biến tại `ModuleTone.module.css` để Dashboard, menu và trang chức năng cập nhật đồng nhất. Tên, biểu tượng và trạng thái vẫn hiển thị bằng chữ; màu không thay thế nội dung hoặc quyền truy cập.
- [Studio](../components/Studio.tsx): quy trình tạo và lưu video hiện có.

## Bản đồ route

Nhóm route `(platform)` dùng chung giao diện nền tảng. Tên nhóm này không xuất hiện trong URL. Studio và trang quản trị giữ phạm vi riêng.

| URL | Mục đích | Phạm vi ở giai đoạn bộ khung |
| --- | --- | --- |
| `/` | Trang tổng quan | Hiển thị các công cụ và lối đi đến từng không gian |
| `/cong-cu/[slug]` | Trang của một module | Metadata riêng, trạng thái đang hoàn thiện, các khả năng dự kiến và điều hướng liên quan |
| `/ca-nhan` | Tài khoản cá nhân | Trình bày trạng thái tài khoản và hạn mức từ hệ thống hiện có |
| `/thu-vien` | Thư viện của tôi | Điểm truy cập tư liệu/dự án; dẫn đến thư viện Studio hiện có, chưa thay thế nơi lưu dự án |
| `/huong-dan` | Hướng dẫn bắt đầu | Giải thích các không gian và cách tiếp tục công việc hiện có |
| `/studio` | Lời Kể Studio hiện có | Video gốc, kịch bản, giọng đọc, dự án cục bộ và xuất video |
| `/quan-tri` | Quản trị thành viên | Giữ kiểm tra quyền quản trị và hạn mức ở máy chủ |

`/studio` chấp nhận query `view` từ danh sách cố định: `studio`, `projects`, `voices`, `profile`, `guide`. Giá trị không hợp lệ trở về `studio`; query không được sử dụng làm URL chuyển hướng tùy ý. Ví dụ `/studio?view=projects` mở thư viện dự án cũ, `/studio?view=profile` mở hồ sơ phong cách và `/studio?view=voices` mở thư viện giọng đọc. Xem [route Studio](../app/studio/page.tsx).

Nút **Về tổng quan** trong Studio chờ lưu dự án hiện tại trước khi rời trang. Khi lưu thất bại, ứng dụng giữ người dùng trong Studio và hướng dẫn thử lại hoặc tải bản sao. Không thay lối thoát này bằng một liên kết điều hướng trực tiếp khi người dùng có thể đang chỉnh dự án.

Các route đăng nhập, khôi phục mật khẩu, auth callback và `/api/*` tiếp tục dùng đường dẫn hiện có. [Proxy](../proxy.ts) bao phủ các route nền tảng để tiếp tục xử lý phiên đăng nhập.

## Sáu module dùng chung một registry

| ID | Slug | Tên hiển thị | Nhóm | Lối đi đến công cụ hiện có |
| --- | --- | --- | --- | --- |
| `voice` | `giong-noi-ai` | Tạo giọng nói AI | `audio` | `/studio?view=voices` |
| `video` | `video-ai` | Tạo video AI | `video` | Chưa có |
| `script` | `kich-ban-ai` | Tạo kịch bản AI | `content` | Chưa có |
| `review` | `video-review` | Tạo video review | `video` | `/studio` |
| `image` | `anh-ai` | Tạo ảnh AI | `image` | Chưa có |
| `other` | `cong-cu-khac` | Công cụ AI khác | `other` | Chưa có |

Kiểu `AiModule` chứa `id`, `slug`, `title`, `shortTitle`, `description`, `category`, `icon`, `tone`, `available`, `capabilities` và `legacy` tùy chọn. `capabilities` mô tả các tính năng dự kiến; `legacy` chỉ dùng khi đã có một route chức năng thật để tiếp tục công việc.

Các hàm dùng chung:

| Hàm | Trách nhiệm |
| --- | --- |
| `getVisibleModules()` | Trả về module có `available: true` |
| `getModuleBySlug(slug)` | Tìm module đang hiển thị; trả `undefined` nếu slug không tồn tại hoặc bị ẩn |
| `moduleHref(module)` | Tạo đường dẫn `/cong-cu/{slug}` nhất quán |

Route [cong-cu/[slug]](../app/(platform)/cong-cu/[slug]/page.tsx) lấy static params từ các module đang hiển thị, đặt `dynamicParams = false` để URL ngoài danh sách trả 404 trước khi stream nội dung. Page và metadata đều gọi `notFound()` khi không tìm thấy module hợp lệ. Sáu module của giai đoạn này đều có `available: true` để người dùng có thể mở các trang giới thiệu.

### `available` là cấu hình hiển thị

`available` cho biết module có xuất hiện trong giao diện và có trang giới thiệu để mở hay không. Thuộc tính này không xác nhận rằng một bộ xử lý AI đã hoàn thiện, không cấp quyền thành viên và không thay kiểm tra quyền khi gọi API.

Việc ẩn một thẻ hoặc route giới thiệu không khóa API của một chức năng thật. Các API vẫn phải kiểm tra phiên đăng nhập, trạng thái thành viên, quyền thao tác, hạn mức và tài nguyên thuộc tài khoản ở máy chủ. Trong hệ thống hiện tại, các trách nhiệm này nằm tại [studio-server.ts](../lib/studio-server.ts), các route API và lớp Supabase. Liên kết quản trị chỉ được hiển thị khi API trả `isAdmin: true`; bản thân [trang quản trị](../app/quan-tri/page.tsx) và API quản trị vẫn xác thực quyền độc lập.

### Thêm hoặc ẩn một module

1. Thêm một phần tử vào `aiModules` trong `lib/studio-modules.ts`. Chọn `id` và `slug` duy nhất, viết mô tả tiếng Việt ngắn, chọn `category`, `icon`, `tone` được hỗ trợ và khai báo các khả năng dự kiến.
2. Đặt `available: true` khi muốn đưa trang giới thiệu vào điều hướng. Dashboard, tìm kiếm, menu và static params đọc cùng registry, không cần thêm danh sách song song ở từng màn hình.
3. Chỉ thêm `legacy` khi đường dẫn đích hoạt động và có chức năng phù hợp. Một module chưa có bộ xử lý dùng trang chuẩn bị chung, không cần thêm nút tạo kết quả.
4. Để ẩn, đổi `available` thành `false`. Module biến mất khỏi các danh sách; URL trực tiếp tới trang giới thiệu cũng trả trạng thái không tìm thấy. Thay đổi mã nguồn cần được build và triển khai để có hiệu lực ở môi trường đang phục vụ người dùng.
5. Khi có yêu cầu nghiệp vụ cụ thể, tách workspace thành component riêng và bổ sung cách chọn component theo ID hoặc slug trong lớp dựng trang. Registry vẫn là nguồn thông tin cho điều hướng. Chỉ thêm bộ xử lý và kiểm tra quyền của module đó khi đã xác định đầu vào, đầu ra và điều kiện sử dụng.

Không cần xây một hệ thống plugin tổng quát để thêm workspace đầu tiên. Có thể bắt đầu bằng một ánh xạ nhỏ từ ID module đến component chuyên biệt ở phía máy chủ, với `ModulePage` làm giao diện dự phòng. Giữ việc nạp mã xử lý nặng bên trong workspace tương ứng.

## Tài khoản, dữ liệu và cấu hình được giữ lại

`AccountProvider` chỉ đọc `/api/config` bằng yêu cầu không lưu cache. Các trạng thái giao diện gồm đang tải, đã xác thực, chưa đăng nhập, tài khoản hạn chế, chưa cấu hình kết nối và lỗi tải dữ liệu. Yêu cầu cũ được hủy khi làm mới hoặc tháo component, tránh để kết quả cũ thay thế trạng thái mới. Tên, quyền quản trị và hạn mức lấy từ phản hồi máy chủ; không dựng số dư hoặc danh tính mẫu.

API cấu hình hiện tại trả hạn mức `used` và `limit` theo lượt xử lý AI. Đây là dữ liệu của cơ chế hạn mức đang có; giai đoạn giao diện này không tự đổi chúng thành giá tiền, gói đăng ký hoặc credit thương mại. Các provider key tiếp tục ở môi trường máy chủ và không được đưa vào registry hay mã giao diện.

Không thay đổi schema Supabase hoặc di chuyển dữ liệu để phục vụ bộ khung. Các bảng hiện có như `studio_members`, `studio_settings`, `studio_voices` và kho `studio-media` giữ trách nhiệm hiện tại. Giao diện tài khoản mới không tạo bản sao hệ thống thành viên.

Dự án Studio vẫn được lưu theo `userId` trong IndexedDB `loike-studio-v1`, object store `projects`. Việc chuyển màn hình sang `/studio` không đổi origin nên dữ liệu trình duyệt tiếp tục ở cùng không gian lưu. Không đổi tên database, không xóa store và không coi dữ liệu cục bộ là thư viện đã đồng bộ lên máy chủ. Video gốc, âm thanh, kịch bản và bản sao `.loike` tiếp tục theo quy trình Studio hiện có.

## Hướng mở rộng sau khi chốt nghiệp vụ

Các mục sau là ranh giới thiết kế cho công việc tiếp theo, chưa phải tính năng đã triển khai. Chỉ bổ sung phần cần thiết cho module được giao, đồng thời dùng lại kiểm tra tài khoản hiện có.

| Nhu cầu | Giao diện tối thiểu có thể bổ sung | Điều cần xác định trước |
| --- | --- | --- |
| Gói sử dụng | Một kiểu dữ liệu gói và hàm đọc gói của tài khoản | Danh sách gói, quyền lợi, thời hạn và cách cấp hoặc hủy gói |
| Credit/chi phí | Một kết quả ước tính chi phí và một bản ghi sử dụng | Đơn vị tính, lúc ghi nhận, xử lý lỗi, tạo lại, hoàn credit và quan hệ với lượt AI hiện có |
| Quyền theo module | Một hàm máy chủ trả quyết định cho phép hoặc từ chối theo người dùng, module và hành động | Vai trò, phạm vi dữ liệu, quyền tạo/xem/xóa và hạn mức |
| Nhà cung cấp AI | Adapter riêng cho chức năng, với đầu vào, đầu ra và lỗi có kiểu | Provider được chọn, model, định dạng, giới hạn, timeout và quy tắc tạo lại |
| Lịch sử tác vụ | Một kiểu tác vụ và hàm đọc lịch sử thuộc tài khoản | Trạng thái, quyền sở hữu, thời hạn lưu, nơi lưu đầu ra và cách mở lại kết quả |
| Workspace riêng | Component được chọn theo module, dùng layout chung | Quy trình, dữ liệu đầu vào và thao tác chính trên điện thoại |

Các giao diện trên phải tách trách nhiệm: registry phục vụ điều hướng; lớp tài khoản đọc trạng thái; máy chủ quyết định quyền và hạn mức; adapter thực hiện công việc với provider; lịch sử lưu kết quả có chủ sở hữu. Thông tin công khai để hiển thị có thể gửi xuống trình duyệt, còn khóa provider và quyết định cấp quyền vẫn ở máy chủ.

Chưa cần xây bộ máy thanh toán, ví credit, hàng đợi dùng chung hoặc hệ thống cài plugin cho mọi module. Chỉ đưa các thành phần đó vào kế hoạch khi yêu cầu vận hành thực tế đã được xác định.

## Kiểm tra khi tích hợp

Các lệnh có sẵn trong repository:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Ngoài kiểm tra mã, cần mở các route chính ở kích thước điện thoại và máy tính. Xác nhận tìm kiếm có và không dấu, điều hướng bàn phím, đóng menu điện thoại, trạng thái tài khoản, liên kết công cụ cũ và slug không hợp lệ. Khi thay đổi đường ra khỏi Studio, kiểm tra dự án được lưu trước khi điều hướng và vẫn giữ người dùng tại chỗ nếu lưu thất bại.

Kiểm tra API có chi phí hoặc thao tác dữ liệu thật nằm ngoài nhu cầu xác minh bộ khung này. Việc một trang giới thiệu mở được không được dùng làm bằng chứng rằng chức năng AI dự kiến của module đã hoạt động.
