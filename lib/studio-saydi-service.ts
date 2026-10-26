import "server-only";

import { StudioError, type StudioSegment } from "./studio-contract";
import { creditsForSpeech, creditRates, deriveCreditRequestId, markCreditProviderTask, refundCredits, reserveCredits, settleCredits } from "./studio-credits";
import { inspectMp3 } from "./studio-mp3";
import { getSaydiVoice, listSaydiSamples, previewSaydiVoice, cloneSaydi, deleteSaydiVoice, synthesizeSaydi, SaydiApiError } from "./studio-saydi";
import { authorizedVoiceRows, getMember, saveAuthorizedVoice, sharedVoiceCatalog } from "./studio-server";
import { createStudioSupabaseServer, storeNarration } from "./studio-supabase";
import { registerLibraryAudio } from "./library-audio";

const cloneId = (value: string) => /^vc_[A-Za-z0-9_-]{1,100}$/.test(value);
const sampleId = (value: string) => typeof value === "string" && value.length > 0 && value.length <= 160
  && !/[\u0000-\u001f\u007f]/.test(value) && !cloneId(value);
const creditId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const definiteRejection = (error: unknown) => error instanceof SaydiApiError && error.status < 500;

type SaydiStudioVoice = {
  voiceId: string; name: string; category: "library" | "cloned";
  group: "vietnamese" | "default" | "personal"; language?: string;
  previewUrl?: string; isPersonalClone?: boolean; status?: "ready" | "processing";
};

async function cloneReservations(userId: string) {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_credit_operations")
    .select("request_id,provider_task_id,metadata,status")
    .eq("user_id", userId).eq("kind", "clone").eq("status", "reserved")
    .not("provider_task_id", "is", null).order("created_at", { ascending: false }).limit(5);
  if (error) throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa kiểm tra được các giọng đang xử lý.", 503);
  return (data || []).filter(row => row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    && row.metadata.provider === "saydi" && typeof row.provider_task_id === "string" && cloneId(row.provider_task_id)
    && typeof row.request_id === "string" && creditId(row.request_id)) as {
      request_id: string; provider_task_id: string; metadata: { name?: string }; status: string;
    }[];
}

async function reconcileClones(key: string, userId: string) {
  const pending = await cloneReservations(userId);
  for (const row of pending) {
    let voice: Awaited<ReturnType<typeof getSaydiVoice>>;
    try { voice = await getSaydiVoice(key, row.provider_task_id); }
    catch { continue; }
    if (voice.status === "failed") {
      await refundCredits(userId, row.request_id).catch(() => {});
    } else if (voice.status === "ready") {
      try {
        await saveAuthorizedVoice(userId, voice.id, row.metadata.name || "Giọng cá nhân", "personal");
        await settleCredits(userId, row.request_id, undefined, { provider: "saydi", voiceId: voice.id });
      } catch { /* Keep the reservation for the next safe reconciliation. */ }
    }
  }
}

export async function listSaydiStudioVoices(key: string, userId: string): Promise<SaydiStudioVoice[]> {
  await reconcileClones(key, userId);
  const [samples, grants] = await Promise.all([listSaydiSamples(key), authorizedVoiceRows(userId)]);
  const sampleVoices: SaydiStudioVoice[] = samples.filter(sample => sampleId(sample.voice_id)).map(sample => ({
    voiceId: sample.voice_id, name: sample.display_name, category: "library",
    group: sample.language === "vi" || sample.voice_id.startsWith("vi-") ? "vietnamese" : "default",
    language: sample.language,
    previewUrl: `/api/voices/preview?voiceId=${encodeURIComponent(sample.voice_id)}`,
  }));
  const personal = grants.filter(row => row.source === "personal" && cloneId(row.voice_id)).slice(0, 25);
  const settled = await Promise.all(personal.map(async row => {
    try {
      const voice = await getSaydiVoice(key, row.voice_id);
      if (voice.status === "failed") return null;
      return { voiceId: row.voice_id, name: row.name, category: "cloned", group: "personal",
        language: "vi", status: voice.status, isPersonalClone: true,
        ...(voice.status === "ready" ? { previewUrl: `/api/voices/preview?voiceId=${encodeURIComponent(row.voice_id)}` } : {}) } as SaydiStudioVoice;
    } catch { return null; }
  }));
  const pending = await cloneReservations(userId);
  const shown = new Set(settled.filter((voice): voice is SaydiStudioVoice => voice !== null).map(voice => voice.voiceId));
  const processing: SaydiStudioVoice[] = pending.filter(row => !shown.has(row.provider_task_id)).map(row => ({
    voiceId: row.provider_task_id, name: row.metadata.name || "Giọng đang xử lý",
    category: "cloned", group: "personal", language: "vi", isPersonalClone: true, status: "processing",
  }));
  return [...settled.filter((voice): voice is SaydiStudioVoice => voice !== null), ...processing, ...sampleVoices];
}

export async function authorizeSaydiVoice(key: string, userId: string, voiceId: string): Promise<string> {
  if (cloneId(voiceId)) {
    const owned = (await authorizedVoiceRows(userId)).some(row => row.voice_id === voiceId && row.source === "personal");
    if (!owned) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không thuộc tài khoản của bạn.", 403);
    const voice = await getSaydiVoice(key, voiceId);
    if (voice.status !== "ready") throw new StudioError("VOICE_NOT_READY", "Giọng đang xử lý hoặc chưa sẵn sàng. Hãy làm mới danh sách sau ít phút.", 409);
    return voiceId;
  }
  if (!sampleId(voiceId)) throw new StudioError("INVALID_VOICE", "Chọn mã giọng SaydiVoice trong danh sách.", 422);
  const samples = await listSaydiSamples(key);
  if (!samples.some(sample => sample.voice_id === voiceId)) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không còn trong thư viện SaydiVoice.", 403);
  return voiceId;
}

export async function saydiPreview(key: string, userId: string, voiceId: string) {
  await authorizeSaydiVoice(key, userId, voiceId);
  return previewSaydiVoice(key, voiceId, cloneId(voiceId));
}

export async function deleteSaydiClone(key: string, userId: string, voiceId: string): Promise<{ success: true }> {
  if (!cloneId(voiceId)) throw new StudioError("INVALID_VOICE", "Mã giọng cá nhân không hợp lệ.", 422);
  const member = await getMember(userId);
  if (member.role !== "member" || !member.enabled) throw new StudioError("MEMBER_VOICE_ONLY", "Chỉ thành viên có thể xóa giọng cá nhân tại đây.", 403);
  const [grants, catalog] = await Promise.all([authorizedVoiceRows(userId), sharedVoiceCatalog(userId)]);
  if (!grants.some(row => row.source === "personal" && row.voice_id === voiceId))
    throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không thuộc tài khoản của bạn.", 403);
  if (catalog.some(row => row.voice_id === voiceId && row.enabled))
    throw new StudioError("VOICE_SHARED", "Giọng này đang được chia sẻ; hãy liên hệ quản trị viên.", 403);
  await deleteSaydiVoice(key, voiceId);
  const client = await createStudioSupabaseServer();
  const { error } = await client.from("studio_voices").delete().eq("user_id", userId)
    .eq("voice_id", voiceId).eq("source", "personal");
  if (error) throw new StudioError("VOICE_DELETE_SYNC_FAILED", "Giọng đã xóa tại SaydiVoice nhưng chưa cập nhật tài khoản. Hãy bấm xóa lại.", 503);
  return { success: true };
}

export async function createSaydiClone(input: { key: string; userId: string; requestId: string; name: string; file: File }) {
  if (!input.file.size || input.file.size > 10 * 1024 * 1024) throw new StudioError("VOICE_SAMPLE_TOO_LARGE", "Mẫu giọng cần nhỏ hơn 10 MB.", 413);
  if (!/\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(input.file.name))
    throw new StudioError("INVALID_VOICE_SAMPLE", "Chọn WAV, MP3, M4A, OGG, FLAC hoặc WebM.", 422);
  const fingerprintBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob([
    input.name, "\n", input.file,
  ]).arrayBuffer()));
  const requestHash = Array.from(fingerprintBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const reserved = await reserveCredits(input.userId, input.requestId, "clone", creditRates.clone,
    { provider: "saydi", name: input.name, requestHash });
  if (!reserved.created) {
    const client = await createStudioSupabaseServer();
    const { data, error } = await client.from("studio_credit_operations")
      .select("status,metadata,provider_task_id").eq("user_id", input.userId)
      .eq("request_id", input.requestId).eq("kind", "clone").maybeSingle();
    if (error) throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa kiểm tra được lần nhân bản đã gửi.", 503);
    if (!data || data.metadata?.provider !== "saydi" || data.metadata?.requestHash !== requestHash)
      throw new StudioError("CREDIT_REQUEST_REUSED", "Mã yêu cầu này đã dùng cho một mẫu giọng khác.", 409);
    if (typeof data.provider_task_id === "string" && cloneId(data.provider_task_id)) {
      const voice = await getSaydiVoice(input.key, data.provider_task_id);
      if (voice.status === "failed") {
        if (data.status === "reserved") await refundCredits(input.userId, input.requestId).catch(() => {});
        throw new StudioError("VOICE_CLONE_FAILED", "SaydiVoice chưa tạo được giọng từ mẫu này.", 422);
      }
      if (data.status === "reserved" && voice.status === "ready") {
        await saveAuthorizedVoice(input.userId, voice.id, input.name, "personal");
        await settleCredits(input.userId, input.requestId, undefined, { provider: "saydi", voiceId: voice.id });
      }
      return { voiceId: voice.id, name: input.name, status: voice.status, requiresVerification: false };
    }
    if (data.status !== "reserved")
      throw new StudioError("CREDIT_REQUEST_REUSED", "Yêu cầu nhân bản này đã kết thúc. Hãy làm mới danh sách giọng.", 409);
    // The earlier POST has an unknown outcome. SaydiVoice's Idempotency-Key
    // returns the same clone, even if the first response was lost.
  }
  let submitted = false;
  try {
    const voice = await cloneSaydi(input.key, { file: input.file, name: input.name, consent: true, idempotencyKey: input.requestId });
    submitted = true;
    await markCreditProviderTask(input.userId, input.requestId, voice.id);
    if (voice.status === "failed") {
      await refundCredits(input.userId, input.requestId);
      throw new StudioError("VOICE_CLONE_FAILED", "SaydiVoice chưa tạo được giọng từ mẫu này.", 422);
    }
    await saveAuthorizedVoice(input.userId, voice.id, input.name, "personal");
    if (voice.status === "ready")
      await settleCredits(input.userId, input.requestId, undefined, { provider: "saydi", voiceId: voice.id });
    return { voiceId: voice.id, name: input.name, status: voice.status, requiresVerification: false };
  } catch (error) {
    if (!submitted && definiteRejection(error)) await refundCredits(input.userId, input.requestId).catch(() => {});
    throw error;
  }
}

type Spoken = { audioPath: string; audioMime: "audio/mpeg"; duration: number; voiceId: string;
  provider: "saydi"; usage: { chars: number; credits: number; jobs: 1 }; audioUrl?: string;
  sizeBytes: number; sampleRate: number; channels: number };

async function settledAudio(userId: string, requestId: string): Promise<Spoken | null> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_credit_operations")
    .select("status,provider_usage").eq("user_id", userId).eq("request_id", requestId).eq("kind", "tts").maybeSingle();
  if (error) throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa kiểm tra được yêu cầu cũ.", 503);
  const usage = data?.provider_usage && typeof data.provider_usage === "object" && !Array.isArray(data.provider_usage)
    ? data.provider_usage as Record<string, unknown> : {};
  if (data?.status !== "settled" || usage.provider !== "saydi" || typeof usage.audioPath !== "string"
    || !usage.audioPath.startsWith(`${userId}/narration/`) || usage.audioMime !== "audio/mpeg"
    || typeof usage.duration !== "number" || usage.duration <= 0 || typeof usage.voiceId !== "string") return null;
  const { data: exists, error: storageError } = await client.storage.from("studio-media").exists(usage.audioPath);
  if (storageError || !exists) throw new StudioError("AUDIO_UNAVAILABLE", "Chưa mở được tệp lời đọc đã tạo. Hãy thử lại sau.", 503);
  return { audioPath: usage.audioPath, audioMime: "audio/mpeg", duration: usage.duration,
    voiceId: usage.voiceId, provider: "saydi", usage: { chars: Number(usage.chars) || 0, credits: Number(usage.credits) || 0, jobs: 1 },
    sizeBytes: Number(usage.sizeBytes) || 0, sampleRate: Number(usage.sampleRate) || 0, channels: Number(usage.channels) || 0 };
}

async function synthesizeStored(input: { key: string; userId: string; requestId: string; voiceId: string; text: string;
  speed?: number; library?: boolean }): Promise<Spoken> {
  const credits = creditsForSpeech(input.text.length);
  const reservation = await reserveCredits(input.userId, input.requestId, "tts", credits,
    { provider: "saydi", voiceId: input.voiceId });
  if (!reservation.created) {
    const replay = await settledAudio(input.userId, input.requestId);
    if (replay) return replay;
    throw new StudioError("CREDIT_REQUEST_REUSED", "Yêu cầu đã gửi hoặc đang đối soát. Hãy chờ và kiểm tra kết quả trước khi tạo lại.", 409);
  }
  let audio: Awaited<ReturnType<typeof synthesizeSaydi>>;
  try { audio = await synthesizeSaydi(input.key, { text: input.text, voiceId: input.voiceId, speed: input.speed }); }
  catch (error) {
    if (definiteRejection(error)) await refundCredits(input.userId, input.requestId).catch(() => {});
    throw error;
  }
  let info: Awaited<ReturnType<typeof inspectMp3>>;
  try { info = await inspectMp3(audio.audio); }
  catch { throw new StudioError("SAYDI_INVALID_AUDIO", "SaydiVoice đã xử lý yêu cầu nhưng âm thanh trả về chưa hợp lệ. Hãy liên hệ quản trị viên trước khi tạo lại.", 502, "contact_admin"); }
  const media = await storeNarration(input.userId, audio.audio, 0, "audio/mpeg");
  const charged = Math.min(credits, creditsForSpeech(audio.chars));
  await settleCredits(input.userId, input.requestId, charged, {
    provider: "saydi", chars: audio.chars, credits: charged, voiceId: input.voiceId,
    audioPath: media.audioPath, audioMime: "audio/mpeg", duration: info.duration,
    sizeBytes: audio.audio.length, sampleRate: info.sampleRate, channels: info.channels,
  });
  if (input.library) await registerLibraryAudio({ userId: input.userId, requestId: input.requestId,
    audioPath: media.audioPath, audioMime: "audio/mpeg", sizeBytes: audio.audio.length,
    durationSeconds: info.duration }).catch(() => {});
  return { ...media, audioMime: "audio/mpeg", duration: info.duration, voiceId: input.voiceId,
    provider: "saydi", usage: { chars: audio.chars, credits: charged, jobs: 1 }, sizeBytes: audio.audio.length,
    sampleRate: info.sampleRate, channels: info.channels };
}

export async function generateSaydiVoiceOver(input: { key: string; userId: string; requestId: string;
  voiceId: string; text: string; speed?: number }) {
  await authorizeSaydiVoice(input.key, input.userId, input.voiceId);
  const spoken = await synthesizeStored({ ...input, library: true });
  const { sizeBytes: _sizeBytes, sampleRate: _sampleRate, channels: _channels, ...result } = spoken;
  return result;
}

export async function generateSaydiSpeech(input: { key: string; userId: string; requestId: string;
  voiceId: string; segments: StudioSegment[]; duration: number }) {
  await authorizeSaydiVoice(input.key, input.userId, input.voiceId);
  if (input.segments.some(segment => segment.text.length > 2000))
    throw new StudioError("SCRIPT_TOO_LONG", "Mỗi đoạn lời đọc SaydiVoice cần tối đa 2.000 ký tự.", 422);
  const output = [];
  let chars = 0, sampleRate = 0, channels = 0;
  for (const [index, segment] of input.segments.entries()) {
    const requestId = await deriveCreditRequestId(input.requestId, `saydi-${index}`);
    const spoken = await synthesizeStored({ key: input.key, userId: input.userId, requestId,
      voiceId: input.voiceId, text: segment.text });
    chars += spoken.usage.chars;
    if (!sampleRate) { sampleRate = spoken.sampleRate; channels = spoken.channels; }
    output.push({ ...segment, audioPath: spoken.audioPath, audioMime: spoken.audioMime,
      duration: spoken.duration, revised: false });
  }
  return { segments: output, duration: input.duration, voiceId: input.voiceId,
    sampleRate, channels, provider: "saydi", usage: { chars, jobs: output.length } };
}
