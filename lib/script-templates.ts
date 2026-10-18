import "server-only";
import { StudioError, cleanText, validFormat, type StudioFormat } from "./studio-contract";
import { getMember } from "./studio-server";
import { createStudioSupabaseServer } from "./studio-supabase";

export type ScriptTemplateScope = "shared" | "personal";
export type ScriptTemplateView = {
  id: string;
  title: string;
  format: StudioFormat;
  scope: ScriptTemplateScope;
  description: string;
  prompt?: string;
};

type ScriptTemplateRow = ScriptTemplateView & {
  owner_id: string;
  prompt_ciphertext: string;
  sort_order: number;
  created_at: string;
};

const templateFields = "id,owner_id,scope,format,title,description,prompt_ciphertext,sort_order,created_at";
const textEncoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function templateId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new StudioError("INVALID_TEMPLATE", "Chọn mẫu kịch bản hợp lệ.");
  return value;
}

async function promptKey(): Promise<CryptoKey> {
  const secret = process.env.STUDIO_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new StudioError("SCRIPT_KEY_NOT_CONFIGURED", "Quản trị viên cần cấu hình khóa bảo vệ prompt kịch bản.", 503, "contact_admin");
  const source = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: textEncoder.encode("apprivew:script-templates:v1"), info: textEncoder.encode("prompt:aes-256-gcm") },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrompt(id: string, prompt: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(id) },
    await promptKey(),
    textEncoder.encode(prompt),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptPrompt(id: string, value: string): Promise<string> {
  try {
    const [version, ivText, ciphertextText, extra] = value.split(".");
    if (version !== "v1" || !ivText || !ciphertextText || extra) throw new Error("Invalid version");
    const iv = Buffer.from(ivText, "base64url"), ciphertext = Buffer.from(ciphertextText, "base64url");
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new Error("Invalid encrypted prompt");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: textEncoder.encode(id) },
      await promptKey(),
      ciphertext,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new StudioError("SCRIPT_PROMPT_UNAVAILABLE", "Chưa đọc được hướng dẫn của mẫu kịch bản. Quản trị viên cần kiểm tra khóa bảo vệ dữ liệu.", 503, "contact_admin");
  }
}

function asTemplate(row: ScriptTemplateRow, prompt?: string): ScriptTemplateView {
  return { id: row.id, title: row.title, format: validFormat(row.format), scope: row.scope, description: row.description, ...(prompt === undefined ? {} : { prompt }) };
}

function inputFields(body: Record<string, unknown>) {
  const title = cleanText(body.title, 121), description = cleanText(body.description, 241), prompt = cleanText(body.prompt, 6001);
  if (!title || title.length > 120) throw new StudioError("INVALID_TEMPLATE_TITLE", "Tên tiêu đề cần từ 1 đến 120 ký tự.");
  if (description.length > 240) throw new StudioError("INVALID_TEMPLATE_DESCRIPTION", "Mô tả tối đa 240 ký tự.");
  if (!prompt || prompt.length > 6000) throw new StudioError("INVALID_TEMPLATE_PROMPT", "Prompt hướng dẫn cần từ 1 đến 6.000 ký tự.");
  return { title, description, prompt, format: validFormat(body.format) };
}

function databaseError(): never {
  throw new StudioError("SCRIPT_STORAGE_UNAVAILABLE", "Chưa đọc hoặc lưu được mẫu kịch bản. Quản trị viên cần kiểm tra cơ sở dữ liệu.", 503, "contact_admin");
}

export async function listScriptTemplates(userId: string): Promise<ScriptTemplateView[]> {
  const member = await getMember(userId), client = await createStudioSupabaseServer();
  // Fetch the shared catalog and the caller's templates independently, so a
  // large shared catalog cannot crowd personal templates out of the result.
  const [shared, owned] = await Promise.all([
    client.from("studio_script_templates").select(templateFields).eq("scope", "shared")
      .order("sort_order", { ascending: true }).order("created_at", { ascending: true }).limit(250),
    client.from("studio_script_templates").select(templateFields).eq("owner_id", userId)
      .order("sort_order", { ascending: true }).order("created_at", { ascending: true }).limit(250),
  ]);
  if (shared.error || owned.error) return databaseError();
  const uniqueRows = new Map<string, ScriptTemplateRow>();
  for (const row of [...(shared.data || []), ...(owned.data || [])] as ScriptTemplateRow[]) uniqueRows.set(row.id, row);
  const rows = [...uniqueRows.values()];
  return Promise.all(rows.map(async (row) => asTemplate(row,
    row.owner_id === userId && (member.role === "admin" || row.scope === "personal")
      ? await decryptPrompt(row.id, row.prompt_ciphertext)
      : undefined,
  )));
}

export async function createScriptTemplate(userId: string, body: Record<string, unknown>): Promise<ScriptTemplateView> {
  const member = await getMember(userId), fields = inputFields(body), id = crypto.randomUUID();
  const scope: ScriptTemplateScope = member.role === "admin" ? "shared" : "personal";
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_script_templates").insert({
    id, owner_id: userId, scope, format: fields.format, title: fields.title,
    description: fields.description, prompt_ciphertext: await encryptPrompt(id, fields.prompt),
  }).select(templateFields).single();
  if (error || !data) return databaseError();
  return asTemplate(data as unknown as ScriptTemplateRow, fields.prompt);
}

async function ownedTemplate(userId: string, id: string): Promise<ScriptTemplateRow> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_script_templates").select(templateFields).eq("id", templateId(id)).maybeSingle();
  if (error) return databaseError();
  if (!data) throw new StudioError("TEMPLATE_NOT_FOUND", "Không tìm thấy tiêu đề kịch bản này.", 404);
  const row = data as unknown as ScriptTemplateRow, member = await getMember(userId);
  if (row.owner_id !== userId || (row.scope === "shared" && member.role !== "admin"))
    throw new StudioError("TEMPLATE_FORBIDDEN", "Bạn chỉ có thể sửa hoặc xóa tiêu đề do mình tạo.", 403);
  return row;
}

export async function updateScriptTemplate(userId: string, id: string, body: Record<string, unknown>): Promise<ScriptTemplateView> {
  const existing = await ownedTemplate(userId, id), fields = inputFields(body), client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_script_templates").update({
    title: fields.title, format: fields.format, description: fields.description,
    prompt_ciphertext: await encryptPrompt(existing.id, fields.prompt), updated_at: new Date().toISOString(),
  }).eq("id", existing.id).eq("owner_id", userId).select(templateFields).maybeSingle();
  if (error) return databaseError();
  if (!data) throw new StudioError("TEMPLATE_NOT_FOUND", "Tiêu đề kịch bản đã được thay đổi. Hãy tải lại trang.", 404);
  return asTemplate(data as unknown as ScriptTemplateRow, fields.prompt);
}

export async function deleteScriptTemplate(userId: string, id: string): Promise<void> {
  const existing = await ownedTemplate(userId, id), client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_script_templates")
    .delete().eq("id", existing.id).eq("owner_id", userId).select("id").maybeSingle();
  if (error) return databaseError();
  if (!data) throw new StudioError("TEMPLATE_NOT_FOUND", "Tiêu đề kịch bản đã được thay đổi. Hãy tải lại trang.", 404);
}

export async function scriptTemplateInstruction(userId: string, id: string): Promise<{ format: StudioFormat; title: string; prompt: string }> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_script_templates").select(templateFields).eq("id", templateId(id)).maybeSingle();
  if (error) return databaseError();
  if (!data) throw new StudioError("TEMPLATE_NOT_FOUND", "Tiêu đề kịch bản không còn khả dụng.", 404);
  const row = data as unknown as ScriptTemplateRow;
  if (row.scope !== "shared" && row.owner_id !== userId) throw new StudioError("TEMPLATE_FORBIDDEN", "Bạn không được dùng tiêu đề kịch bản của tài khoản khác.", 403);
  return { format: validFormat(row.format), title: row.title, prompt: await decryptPrompt(row.id, row.prompt_ciphertext) };
}
