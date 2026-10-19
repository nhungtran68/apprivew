import { StudioError } from "@/lib/studio-contract";
import { PAYOS_PRODUCTION_WEBHOOK, payos, recordWebhookConfirmation } from "@/lib/studio-payments";
import { apiError, json, requestUser, requireAdmin } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    await requireAdmin(userId);
    const webhookUrl = PAYOS_PRODUCTION_WEBHOOK;
    try {
      const result = await payos().webhooks.confirm(webhookUrl);
      if (result.webhookUrl !== webhookUrl)
        throw new StudioError("PAYMENT_WEBHOOK_MISMATCH", "payOS xác nhận đường dẫn webhook khác dự kiến.", 502);
      await recordWebhookConfirmation(webhookUrl);
      return json({ ok: true, webhookUrl });
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw new StudioError("PAYMENT_WEBHOOK_CONFIRM_FAILED", "Chưa xác nhận được webhook payOS. Kiểm tra khóa và kênh thanh toán.", 502);
    }
  } catch (error) { return apiError(error); }
}
