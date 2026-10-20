type SignupAuthError = { code?: string; status?: number };

export function describeSignupError(error: SignupAuthError): { code: string; message: string; status: number } {
  switch (error.code) {
    case "over_email_send_rate_limit":
      return { code: "SIGNUP_EMAIL_LIMIT", message: "Hệ thống đang giới hạn số email xác nhận. Vui lòng đợi rồi thử lại; nếu vẫn gặp lỗi, hãy liên hệ quản trị viên.", status: 429 };
    case "over_request_rate_limit":
      return { code: "SIGNUP_REQUEST_LIMIT", message: "Bạn đã gửi quá nhiều yêu cầu đăng ký. Vui lòng đợi ít phút rồi thử lại.", status: 429 };
    case "email_address_invalid":
      return { code: "INVALID_EMAIL", message: "Email không hợp lệ hoặc không thể nhận thư. Hãy kiểm tra lại địa chỉ email.", status: 422 };
    case "email_address_not_authorized":
      return { code: "SIGNUP_EMAIL_UNAVAILABLE", message: "Hệ thống chưa gửi được thư xác nhận tới địa chỉ này. Vui lòng liên hệ quản trị viên.", status: 503 };
    case "email_provider_disabled":
    case "signup_disabled":
      return { code: "SIGNUP_DISABLED", message: "Đăng ký thành viên đang tạm đóng. Vui lòng liên hệ quản trị viên.", status: 503 };
    case "weak_password":
      return { code: "WEAK_PASSWORD", message: "Mật khẩu chưa đạt yêu cầu bảo mật. Hãy chọn mật khẩu khó đoán hơn.", status: 422 };
    default:
      if (error.status === 429) return { code: "SIGNUP_REQUEST_LIMIT", message: "Hệ thống đang giới hạn yêu cầu đăng ký. Vui lòng đợi rồi thử lại.", status: 429 };
      return { code: "REGISTER_FAILED", message: "Chưa tạo được tài khoản. Kiểm tra email, mật khẩu hoặc liên hệ quản trị viên.", status: error.status && error.status >= 500 ? 502 : 422 };
  }
}
