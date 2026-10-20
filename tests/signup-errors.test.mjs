import assert from "node:assert/strict";
import { describeSignupError } from "../lib/studio-signup-errors.ts";

assert.deepEqual(describeSignupError({ code: "over_email_send_rate_limit", status: 429 }), {
  code: "SIGNUP_EMAIL_LIMIT",
  message: "Hệ thống đang giới hạn số email xác nhận. Vui lòng đợi rồi thử lại; nếu vẫn gặp lỗi, hãy liên hệ quản trị viên.",
  status: 429,
});
assert.equal(describeSignupError({ code: "email_address_invalid", status: 400 }).code, "INVALID_EMAIL");
assert.equal(describeSignupError({ code: "email_address_not_authorized", status: 422 }).status, 503);
assert.equal(describeSignupError({ status: 429 }).status, 429);
assert.equal(describeSignupError({ code: "database_error", status: 500 }).status, 502);
assert.ok(!JSON.stringify(describeSignupError({ code: "database_error", status: 500, message: "private database details" })).includes("private database details"));
console.log("PASS signup errors show actionable safe messages");
