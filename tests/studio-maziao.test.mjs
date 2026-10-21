import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Offline provider tests exercise authorization, job lifecycle and real WAV
// parsing without accounts, uploaded user recordings or paid API requests.
const root = process.cwd();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
let sequence = 0;

async function harness() {
  const key = `offline-maziao-secret-${++sequence}`;
  const requests = [], grants = new Map(), charged = [], deleted = [], media = new Map(), storedMimes = new Map(), mp3Reads = [], waits = [], shortened = [], usage = [], timing = [], indexedAudio = [];
  let handle = async () => { throw new Error("Unexpected provider request"); };
  let accountVoices = [];
  let accountHandler;
  let memberRole = "admin";
  let catalog = [];
  let failStorageAt;
  let now = 1700000000000;
  class TestDate extends Date { static now() { return now; } }
  const modules = new Map(), synthetics = new Map();
  const context = vm.createContext({
    console: { ...console, info: value => { const entry = JSON.parse(value); (entry.event === "studio_voice_timing" ? timing : usage).push(entry); } }, crypto, process: { env: { MAZIAO_API_KEY: key } }, Date: TestDate,
    TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, FormData, File,
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, btoa, atob,
    setTimeout(callback, ms = 0) { waits.push(ms); now += ms; queueMicrotask(callback); return 0; },
    clearTimeout() {},
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method || "GET", ...init };
      requests.push(request);
      // Match the documented endpoint exactly. A substring match also accepted
      // the incorrect /api/my-voices path and hid the production sync failure.
      if (new URL(request.url).pathname === "/api/voices/my-voices") {
        if (accountHandler) return accountHandler(request);
        const query = new URL(request.url).searchParams;
        const offset = Number(query.get("offset") || 0), limit = Number(query.get("limit") || 100);
        return Response.json({ data: { items: accountVoices.slice(offset, offset + limit), total: accountVoices.length } });
      }
      return handle(request);
    },
  });
  const grant = (userId, voiceId, source = "personal", name = voiceId, previewUrl) => {
    const previous = grants.get(`${userId}:${voiceId}`);
    grants.set(`${userId}:${voiceId}`, {
      ...previous, user_id: userId, voice_id: voiceId, source, name, authorization_tag: "server-verified",
      preview_url: previewUrl ?? previous?.preview_url ?? null,
      preview_checked_at: previewUrl ? new Date(now).toISOString() : previous?.preview_checked_at ?? null,
    });
  };
  const server = {
    MAZIAO_MODELS: ["vieten_speech", "lingual_speech_v2"],
    maziaoModel: () => "vieten_speech",
    authorizedVoiceRows: async userId => [...grants.values()].filter(row => row.user_id === userId),
    saveAuthorizedVoice: async (userId, voiceId, name, source, previewUrl) => grant(userId, voiceId, source, name, previewUrl),
    savePersonalVoicePreview: async (userId, voiceId, authorizationTag, previewUrl) => {
      const row = grants.get(`${userId}:${voiceId}`);
      assert.equal(row?.authorization_tag, authorizationTag);
      assert.equal(row?.source, "personal");
      row.preview_url = previewUrl ?? null;
      row.preview_checked_at = new Date(now).toISOString();
    },
    saveSharedVoiceList: async (userId, voices) => { for (const voice of voices) grant(userId, voice.voiceId, "shared", voice.name); },
    consumeAiUnits: async (_user, units) => charged.push(units),
    consumeVoiceClone: async (_user, units) => charged.push(units),
    getMember: async () => ({ role: memberRole, enabled: true }),
    sharedVoiceCatalog: async () => catalog,
    providerKey: async () => ({ key, personal: false }),
    requestUser: async () => alice,
    limitedJson: async request => request.json(),
    json: (data, status = 200) => Response.json(data, { status }),
    apiError: error => Response.json({ code: error.code, error: error.message }, { status: error.status || 500 }),
  };
  const mocks = new Map([
    [path.join(root, "lib/library-audio.ts"), {
      registerLibraryAudio: async input => { indexedAudio.push(input); },
    }],
    [path.join(root, "lib/studio-server.ts"), server],
    [path.join(root, "lib/studio-credit-operation.ts"), { creditRequestId: () => crypto.randomUUID() }],
    [path.join(root, "lib/studio-credits.ts"), {
      creditsForSpeech: characters => Math.ceil(characters / 100),
      deriveCreditRequestId: async () => crypto.randomUUID(),
      markCreditProviderTask: async () => {},
      reserveCredits: async (_user, _requestId, _kind, credits) => { charged.push(credits); return { created: true, status: "reserved" }; },
      settleCredits: async () => {}, refundCredits: async () => {},
    }],
    [path.join(root, "lib/studio-eleven.ts"), {
      authorizeVoice: async () => { throw new Error("Maziao selection must not use ElevenLabs authorization"); },
      generateSpeech: async () => { throw new Error("Maziao selection must not use ElevenLabs generation"); },
      generateElevenVoiceOver: async () => { throw new Error("Maziao selection must not use ElevenLabs narration"); },
    }],
    [path.join(root, "lib/studio-deepseek.ts"), {
      shortenSegment: async (_key, segment, _duration, charge) => { await charge?.(); shortened.push(segment.text); return segment.text.length > 10 ? segment.text.slice(0, 10) : segment.text; },
    }],
    [path.join(root, "lib/studio-mp3.ts"), {
      // Pipeline tests isolate metadata parsing at this boundary. The separate
      // MP3 parser suite tests real frame validation and music-metadata itself.
      inspectMp3: async bytes => {
        mp3Reads.push(bytes);
        const fixture = syntheticMpegFrames();
        if (bytes.length !== fixture.length || bytes.some((byte, index) => byte !== fixture[index])) throw Object.assign(new Error("Invalid test MP3 payload"), { code: "INVALID_AUDIO", status: 422 });
        return { duration: 8 * 576 / 24000, sampleRate: 24000, channels: 1 };
      },
    }],
    [path.join(root, "lib/studio-supabase.ts"), {
      STUDIO_MEDIA_BUCKET: "studio-media",
      createStudioSupabaseServer: async () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) })
      }),
      removeOwnedMedia: async (userId, paths) => {
        for (const name of paths) {
          assert.ok(name.startsWith(`${userId}/`));
          deleted.push(name); media.delete(name); storedMimes.delete(name);
        }
      },
      storeNarration: async (userId, bytes, index, mime = "audio/wav") => {
        if (index === failStorageAt) throw new Error("Simulated storage failure");
        const extension = mime === "audio/mpeg" ? "mp3" : "wav";
        const audioPath = `${userId}/narration/${index}.${extension}`;
        media.set(audioPath, bytes); storedMimes.set(audioPath, mime);
        return { audioPath, audioUrl: `https://audio.example.invalid/${index}.${extension}` };
      },
    }],
  ]);
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file, importModuleDynamically: async (specifier, parent) => {
      const dependency = await linker(specifier, parent);
      if (dependency.status === "unlinked") await dependency.link(linker);
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    } });
    modules.set(file, module);
    return module;
  }
  async function linker(specifier, parent) {
    const file = specifier === "server-only" ? specifier : specifier.startsWith("@/")
      ? `${path.join(root, specifier.slice(2))}.ts`
      : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
    if (file === "server-only" || mocks.has(file)) {
      if (synthetics.has(file)) return synthetics.get(file);
      const values = mocks.get(file) || {};
      const module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
      synthetics.set(file, module);
      return module;
    }
    return load(file);
  }
  async function entry(relative) {
    const module = await load(path.join(root, relative));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  const wav = await entry("lib/studio-wav.ts");
  return { key, requests, grants, grant, charged, deleted, media, storedMimes, mp3Reads, waits, shortened, usage, timing, indexedAudio, wav, entry, setHandler(handler) { handle = handler; }, setAccountVoices(rows) { accountVoices = rows; }, setAccountHandler(handler) { accountHandler = handler; }, setMemberRole(role) { memberRole = role; }, setCatalog(rows) { catalog = rows; }, failStorageAt(index) { failStorageAt = index; } };
}

function syntheticMpegFrames() {
  const bytes = new Uint8Array(8 * 384);
  for (let offset = 0; offset < bytes.length; offset += 384) bytes.set([0xff, 0xf3, 0xc4, 0xc0], offset);
  return bytes;
}

function wavBytes(duration = 1, { sampleRate = 24000, channels = 1, bits = 16, junk = false } = {}) {
  const block = channels * bits / 8, dataLength = Math.round(duration * sampleRate) * block;
  const dataOffset = junk ? 58 : 44, bytes = new Uint8Array(dataOffset + dataLength), view = new DataView(bytes.buffer);
  const tag = (offset, text) => [...text].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * block, true); view.setUint16(32, block, true); view.setUint16(34, bits, true);
  if (junk) { tag(36, "JUNK"); view.setUint32(40, 5, true); }
  tag(dataOffset - 8, "data"); view.setUint32(dataOffset - 4, dataLength, true);
  return bytes;
}

let passed = 0;
async function check(name, run) { await run(); console.log(`PASS ${name}`); passed++; }
const scoped = (id, model = "vieten_speech") => `maziao:${model}:${id}`;
const config = () => Response.json({ data: { ttsModels: ["vieten_speech", "lingual_speech_v2"].map(id => ({ id, support_cloning: true, supported_languages: ["vi", "en"] })) } });
// The live system catalog omits ownership fields; its fixed server-selected
// system query supplies public membership evidence, never a detail response alone.
const voice = (id, extra = {}) => ({ id, name: id, language: "vi", modelId: "vieten_speech", refFile: `https://r2-storage.maziao.com/voices/${id}.wav`, refText: "Trong vườn hoa nở rực rỡ.", previewUrl: `https://r2-storage.maziao.com/samples/${id}.wav`, ...extra });
const sampleSegments = () => [{ start: 0, end: 3, text: "Xin chào." }, { start: 4, end: 7, text: "Một câu chuyện nhỏ." }];
const shortSpeechVoice = () => scoped("publicVoice", "lingual_speech_v2");
const exactMinimumText = "Xin chào, đây là lời đọc tiếng Việt thử nghiệm của ứng dụng Lời Kể. Chúc bạn có một ngày vui vẻ nhé!";
const isApi = request => request.url.startsWith("https://app.maziao.com/api/");
async function provider(h) {
  const api = await h.entry("lib/studio-maziao.ts");
  return new Proxy(api, { get(target, property) {
    if (property === "generateMaziaoSpeech" || property === "generateMaziaoVoiceOver") return input => target[property]({ ...input, requestId: input.requestId || crypto.randomUUID() });
    if (property === "cloneMaziaoVoice") return (...args) => target.cloneMaziaoVoice(...args, crypto.randomUUID());
    return target[property];
  } });
}

function speechHandler(h, { durations = [1, 2], urls, status = "completed", onSubmit, totalCost = 34.5, omitCost = false } = {}) {
  let polls = 0, submits = 0;
  return request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.endsWith("/tts/submit")) {
      submits++; onSubmit?.(JSON.parse(request.body), submits);
      return Response.json({ data: { taskId: `task_${submits}`, ...omitCost ? {} : { totalCost }, remainingCredits: 1000 } });
    }
    if (request.url.endsWith("/tts/status")) {
      polls++;
      const taskId = JSON.parse(request.body).ids[0];
      if (status === "processing-first" && polls === 1) return Response.json({ data: [{ id: taskId, status: "processing", totalTasks: durations.length, completedTasks: 0 }] });
      if (status === "failed") return Response.json({ data: [{ id: taskId, status: "failed", msg: h.key }] });
      return Response.json({ data: [{ id: taskId, status: "completed", totalTasks: durations.length, completedTasks: durations.length, resultUrls: urls || durations.map((_, index) => `https://r2-storage.maziao.com/tts-outputs/${taskId}_${index}.wav`) }] });
    }
    if (request.url.startsWith("https://r2-storage.maziao.com/")) {
      const index = Number(request.url.match(/_(\d+)\.wav$/)?.[1] || 0);
      return new Response(wavBytes(durations[index], { junk: true }), { headers: { "content-type": "audio/wav" } });
    }
    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  };
}

await check("WAV duration uses actual format and data chunks, including padded JUNK chunks", async () => {
  const h = await harness();
  const pcm = h.wav.inspectWav(wavBytes(1.25));
  assert.equal(pcm.duration, 1.25); assert.equal(pcm.sampleRate, 24000); assert.equal(pcm.channels, 1);
  const stereo = h.wav.inspectWav(wavBytes(2, { channels: 2, sampleRate: 48000, junk: true }));
  assert.equal(stereo.duration, 2); assert.equal(stereo.sampleRate, 48000); assert.equal(stereo.channels, 2);
});

await check("invalid WAV data cannot create a false short duration", async () => {
  const h = await harness();
  for (const mutate of [
    bytes => bytes.subarray(0, 40),
    bytes => { bytes[0] = 0; return bytes; },
    bytes => { new DataView(bytes.buffer).setUint32(28, 1, true); return bytes; },
    bytes => { new DataView(bytes.buffer).setUint32(40, 0xffffffff, true); return bytes; },
  ]) assert.throws(() => h.wav.inspectWav(mutate(wavBytes())), { code: "INVALID_AUDIO" });
});

await check("voice lists expose only verified public voices and the current member's signed clones", async () => {
  const h = await harness(), maziao = await provider(h);
  h.grant(alice, scoped("ownClone")); h.grant(bob, scoped("foreignClone")); h.grant(alice, scoped("staleShared"), "shared");
  h.setHandler(request => {
    assert.equal(request.headers.Authorization, `Bearer ${h.key}`);
    assert.equal(request.redirect, "error");
    if (request.url.endsWith("/configs")) return config();
    if (request.url.includes("/voices?")) {
      const query = new URL(request.url).searchParams;
      assert.equal(query.get("type"), "system"); assert.equal(query.get("language"), "vi"); assert.equal(query.has("modelId"), false); assert.equal(query.get("sort_field"), "total_used");
      return Response.json({ data: { items: [
        voice("publicVoice", { userId: null }), voice("publicVoice"), voice("foreignClone", { userId: "provider-account", name: "Bob secret" }),
        voice("staleShared", { userId: "provider-account", previewUrl: "https://private.invalid/secret.wav" }),
        voice("publicNoOwnership"), voice("wrongLanguage", { language: "en" }),
        voice("missingTranscript", { refText: "" }), voice("missingSample", { refFile: "" }),
        voice("unprovenCloneFlag", { refFile: undefined, refText: undefined, supportCloning: true }),
      ] } });
    }
    assert.equal(request.url, "https://app.maziao.com/api/voices/ownClone");
    return Response.json({ data: voice("ownClone", { userId: "provider-account" }) });
  });
  const voices = await maziao.listMaziaoVoices(h.key, alice);
  assert.deepEqual(Array.from(voices, item => item.voiceId), [scoped("ownClone"), scoped("publicVoice"), scoped("publicNoOwnership")]);
  assert.equal(voices[0].group, "personal"); assert.equal(voices[1].group, "vietnamese");
  const visible = JSON.stringify(voices);
  for (const secret of ["foreignClone", "Bob secret", "staleShared", "wrongLanguage", "missingTranscript", "missingSample", "unprovenCloneFlag", "private.invalid", "provider-account", "refFile", "refText"]) assert.ok(!visible.includes(secret));
  assert.ok(h.grants.has(`${alice}:${scoped("publicVoice")}`));
  assert.ok(h.grants.has(`${alice}:${scoped("publicNoOwnership")}`));
  assert.ok(h.requests.some(request => request.url.includes("my-voices")));
});

await check("admin account clones are imported into the app with a listenable preview", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setAccountVoices([voice("existingAdminClone", { userId: "provider-account", name: "Giọng quản trị", previewUrl: "https://r2-storage.maziao.com/samples/admin-clone.wav" })]);
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.includes("/voices?")) return Response.json({ data: { items: [] } });
    if (request.url.endsWith("/voices/existingAdminClone")) return Response.json({ data: voice("existingAdminClone", { userId: "provider-account", name: "Giọng quản trị", previewUrl: "https://r2-storage.maziao.com/samples/admin-clone.wav" }) });
    throw new Error("Unexpected provider request: " + request.url);
  });
  const voices = await maziao.listMaziaoVoices(h.key, alice);
  const imported = voices.find(item => item.voiceId === scoped("existingAdminClone"));
  assert.ok(imported); assert.equal(imported.category, "cloned"); assert.equal(imported.name, "Giọng quản trị");
  assert.equal(imported.previewUrl, "https://r2-storage.maziao.com/samples/admin-clone.wav");
  assert.ok(h.grants.has(`${alice}:${scoped("existingAdminClone")}`));
});

await check("admin clone previews prefer the ready preview and safely fall back to the existing reference audio", async () => {
  const h = await harness(), maziao = await provider(h);
  const preview = "https://r2-storage.maziao.com/users/offline/preview.wav";
  const reference = "https://r2-storage.maziao.com/users/offline/reference.wav";
  assert.equal(maziao.normalizeAdminVoice(voice("withPreview", { previewUrl: preview, refFile: reference }), "vieten_speech").previewUrl, preview);
  for (const missing of [undefined, null, ""]) {
    assert.equal(maziao.normalizeAdminVoice(voice("referenceOnly", { previewUrl: missing, refFile: reference }), "vieten_speech").previewUrl, reference);
  }
  const snake = { id: "snakePreview", name: "Giọng mẫu", model_id: "lingual_speech_v2", language: "vi", ref_file: reference, ref_text: "Lời mẫu." };
  assert.equal(maziao.normalizeAdminVoice(snake, "vieten_speech").previewUrl, reference);
  for (const unsafe of ["https://private.invalid/sample.wav", "http://r2-storage.maziao.com/sample.wav", "https://r2-storage.maziao.com.evil.invalid/sample.wav", "https://user:pass@r2-storage.maziao.com/sample.wav", "https://r2-storage.maziao.com:444/sample.wav", "https://r2-storage.maziao.com/sample.wav#private"]) {
    const normalized = maziao.normalizeAdminVoice(voice("unsafePreview", { previewUrl: unsafe, refFile: unsafe }), "vieten_speech");
    assert.equal(normalized.previewUrl, null);
  }
  assert.equal(h.requests.length, 0); assert.equal(h.charged.length, 0);
});

const approvedClone = (id, model = "vieten_speech", enabled = true) => ({ voice_id: scoped(id, model), name: "Giọng đã được cấp", enabled, kind: "admin_clone", sort_order: 0 });

function speechRequest(pathname, voiceId) {
  const body = pathname === "/api/voice-over"
    ? { voiceId, text: exactMinimumText, speed: 1, volume: 1, pitch: 1 }
    : { voiceId, segments: [{ start: 0, end: 20, text: exactMinimumText }], duration: 20 };
  return new Request("https://app.example" + pathname, { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify(body) });
}

await check("a member's approved admin clone is verified through the fresh account list for both models", async () => {
  for (const model of ["vieten_speech", "lingual_speech_v2"]) {
    const h = await harness();
    h.setMemberRole("member"); h.setCatalog([approvedClone("approvedClone", model)]);
    h.setAccountVoices([voice("approvedClone", { userId: "provider-admin", modelId: model }), voice("unrelatedPrivateClone", { name: "Other member private voice", userId: "provider-admin", modelId: model })]);
    h.grant(bob, scoped("unrelatedPrivateClone", model));
    // Maziao may permit listing owned clones while its single-voice route
    // rejects API tokens. A shared clone must not rely on that route.
    h.setHandler(() => Response.json({ errors: ["offline-detail-route-forbidden"] }, { status: 403 }));
    const maziao = await provider(h);
    const resolved = await maziao.authorizeMaziaoVoice(alice, scoped("approvedClone", model));
    assert.equal(resolved, scoped("approvedClone", model));
    assert.equal(h.requests.length, 1);
    assert.equal(new URL(h.requests[0].url).pathname, "/api/voices/my-voices");
    assert.equal(h.requests[0].headers.Authorization, `Bearer ${h.key}`);
    assert.equal(h.charged.length, 0); assert.equal(h.grants.size, 1);
    assert.equal([...h.grants.values()].some(row => row.user_id === alice), false, "fresh ownership checks must not copy other account clones into the member's private grants");
    const requestCount = h.requests.length;
    await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("unrelatedPrivateClone", model)), { code: "VOICE_NOT_AUTHORIZED" });
    assert.equal(h.requests.length, requestCount, "another member's private clone must be denied before provider access");
    h.setAccountVoices([]);
    await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("approvedClone", model)), { code: "VOICE_NOT_AUTHORIZED" });
    assert.equal(h.requests.length, requestCount + 1, "each authorization must refresh ownership rather than reuse a successful lookup");
    assert.equal(h.charged.length, 0);
  }
});

await check("both speech routes let members use an approved owned clone without a single-voice lookup", async () => {
  for (const model of ["vieten_speech", "lingual_speech_v2"]) {
    for (const pathname of ["/api/voice-over", "/api/speech"]) {
      const h = await harness();
      h.setMemberRole("member"); h.setCatalog([approvedClone("approvedClone", model)]);
      h.setAccountVoices([voice("approvedClone", { userId: "provider-admin", modelId: model })]);
      const speech = speechHandler(h, { durations: [1] });
      h.setHandler(request => new URL(request.url).pathname === "/api/voices/approvedClone"
        ? Response.json({ errors: ["offline-detail-route-forbidden"] }, { status: 403 }) : speech(request));
      const route = await h.entry(`app${pathname}/route.ts`);
      const response = await route.POST(speechRequest(pathname, scoped("approvedClone", model)));
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const result = await response.json();
      assert.equal(result.voiceId, scoped("approvedClone", model)); assert.equal(result.provider, "maziao");
      assert.equal(h.requests.filter(request => new URL(request.url).pathname === "/api/voices/my-voices").length, 1);
      assert.equal(h.requests.some(request => new URL(request.url).pathname === "/api/voices/approvedClone"), false);
      assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
      assert.deepEqual(h.charged, [1]); assert.equal(h.media.size, 1);
    }
  }
});

await check("a removed account clone cannot reuse its approved catalog row or a historical shared grant", async () => {
  for (const pathname of ["/api/voice-over", "/api/speech"]) {
    const h = await harness();
    h.setMemberRole("member"); h.setCatalog([approvedClone("removedClone")]);
    h.setAccountVoices([voice("differentOwnedClone", { userId: "provider-admin" })]);
    h.grant(alice, scoped("removedClone"), "shared");
    h.setHandler(() => { throw new Error("An absent owned clone must never reach detail, configs or paid speech"); });
    const route = await h.entry(`app${pathname}/route.ts`), response = await route.POST(speechRequest(pathname, scoped("removedClone")));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, "VOICE_NOT_AUTHORIZED");
    assert.equal(h.requests.length, 1); assert.equal(new URL(h.requests[0].url).pathname, "/api/voices/my-voices");
    assert.equal(h.charged.length, 0); assert.equal(h.media.size, 0);
  }
});

await check("revoking a shared admin clone blocks both routes before provider reads or quota consumption", async () => {
  for (const pathname of ["/api/voice-over", "/api/speech"]) {
    const h = await harness();
    h.setMemberRole("member"); h.setCatalog([approvedClone("revokedClone", "vieten_speech", false)]);
    h.grant(alice, scoped("revokedClone"), "shared");
    h.setAccountVoices([voice("revokedClone", { userId: "provider-admin" })]);
    h.setHandler(() => { throw new Error("A revoked clone must never reach the provider"); });
    const route = await h.entry(`app${pathname}/route.ts`), response = await route.POST(speechRequest(pathname, scoped("revokedClone")));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, "VOICE_NOT_AUTHORIZED");
    assert.equal(h.requests.length, 0); assert.equal(h.charged.length, 0); assert.equal(h.media.size, 0);
  }
});

await check("fresh owned clones must still match the approved model and cloning requirements", async () => {
  for (const [changes, code] of [[{ modelId: "lingual_speech_v2" }, "MAZIAO_VOICE_MODEL"], [{ refText: "" }, "VOICE_NOT_AUTHORIZED"], [{ language: "en" }, "VOICE_NOT_AUTHORIZED"]]) {
    const h = await harness(); h.setMemberRole("member"); h.setCatalog([approvedClone("changedClone")]);
    h.setAccountVoices([voice("changedClone", { userId: "provider-admin", ...changes })]);
    h.setHandler(() => { throw new Error("An incompatible clone must not reach any further provider operation"); });
    const route = await h.entry("app/api/voice-over/route.ts"), response = await route.POST(speechRequest("/api/voice-over", scoped("changedClone")));
    assert.equal(response.status, code === "MAZIAO_VOICE_MODEL" ? 422 : 403); assert.equal((await response.json()).code, code);
    assert.equal(h.requests.length, 1); assert.equal(h.charged.length, 0); assert.equal(h.media.size, 0);
  }
});

await check("owned-account authentication failures remain visible and never fall back to the cached approved clone", async () => {
  for (const status of [401, 403]) {
    const h = await harness(); h.setMemberRole("member"); h.setCatalog([approvedClone("approvedButUnverified")]);
    h.setAccountHandler(() => Response.json({ errors: [`${h.key} PRIVATE_PROVIDER_MESSAGE https://private.invalid/sample.wav`] }, { status }));
    h.setHandler(() => { throw new Error("Provider auth failures must not fall back to detail, cache or speech"); });
    const route = await h.entry("app/api/voice-over/route.ts"), response = await route.POST(speechRequest("/api/voice-over", scoped("approvedButUnverified")));
    assert.equal(response.status, 422);
    const result = await response.json(); assert.equal(result.code, "MAZIAO_AUTH");
    for (const secret of [h.key, "PRIVATE_PROVIDER_MESSAGE", "private.invalid"]) assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(h.requests.length, 1); assert.equal(h.charged.length, 0); assert.equal(h.media.size, 0);
  }
});

function assertAccountReadsOnly(h) {
  assert.ok(h.requests.length > 0);
  for (const request of h.requests) {
    assert.equal(new URL(request.url).pathname, "/api/voices/my-voices");
    assert.equal(request.method, "GET");
    assert.equal(request.headers.Authorization, `Bearer ${h.key}`);
    assert.equal(request.redirect, "error");
    assert.ok(!new URL(request.url).searchParams.has("type"), "account sync must not guess a public custom/user catalog filter");
  }
  assert.equal(h.charged.length, 0); assert.equal(h.grants.size, 0);
}

await check("account sync finds all six clones using the documented voices/my-voices endpoint and nested response", async () => {
  const h = await harness(), maziao = await provider(h);
  const account = Array.from({ length: 6 }, (_, index) => voice(`accountClone${index + 1}`, { userId: "offline-provider-account", modelId: index % 2 ? "lingual_speech_v2" : "vieten_speech" }));
  h.setAccountVoices(account);
  const result = await maziao.adminAccountVoices(h.key);
  assert.deepEqual(Array.from(result, row => row.id), account.map(row => row.id));
  assert.deepEqual(Array.from(result, row => row.modelId), account.map(row => row.modelId));
  assert.equal(h.requests.length, 1); assertAccountReadsOnly(h);
});

await check("account sync follows nested total across full pages without silently truncating the clone list", async () => {
  const h = await harness(), maziao = await provider(h);
  const account = Array.from({ length: 105 }, (_, index) => voice(`paginatedClone${index}`));
  h.setAccountVoices(account);
  const result = await maziao.adminAccountVoices(h.key);
  assert.deepEqual(Array.from(result, row => row.id), account.map(row => row.id));
  assert.deepEqual(h.requests.map(request => Number(new URL(request.url).searchParams.get("offset"))), [0, 100]);
  assertAccountReadsOnly(h);
});

await check("a short account page still follows the provider total until all six clones are read", async () => {
  const h = await harness(), maziao = await provider(h), account = Array.from({ length: 6 }, (_, index) => voice(`shortPageClone${index}`));
  h.setAccountHandler(request => {
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    return Response.json({ data: { items: account.slice(offset, offset + 2), total: account.length } });
  });
  const result = await maziao.adminAccountVoices(h.key);
  assert.deepEqual(Array.from(result, row => row.id), account.map(row => row.id));
  assert.deepEqual(h.requests.map(request => Number(new URL(request.url).searchParams.get("offset"))), [0, 2, 4]);
  assertAccountReadsOnly(h);
});

await check("a legitimate empty account is distinct from an unsupported endpoint and never falls back to public catalogs", async () => {
  const empty = await harness(), maziao = await provider(empty);
  empty.setAccountHandler(() => Response.json({ data: { items: [], total: 0 } }));
  assert.equal((await maziao.adminAccountVoices(empty.key)).length, 0);
  assert.equal(empty.requests.length, 1); assertAccountReadsOnly(empty);

  const unsupported = await harness(), unsupportedMaziao = await provider(unsupported);
  unsupported.setAccountHandler(() => Response.json({ errors: ["offline-private-provider-error-body"] }, { status: 404 }));
  await assert.rejects(unsupportedMaziao.adminAccountVoices(unsupported.key), { code: "MAZIAO_NOT_FOUND" });
  assert.equal(unsupported.requests.length, 1); assertAccountReadsOnly(unsupported);
});

await check("malformed account data fails closed without exposing provider content or guessing alternate catalogs", async () => {
  const h = await harness(), maziao = await provider(h), marker = "offline-sensitive-provider-content";
  h.setAccountHandler(() => Response.json({ data: { items: { private: marker }, total: 6 }, private: marker }));
  await assert.rejects(maziao.adminAccountVoices(h.key), error => {
    assert.equal(error.code, "MAZIAO_INVALID_RESPONSE");
    const serialized = JSON.stringify({ code: error.code, message: error.message });
    assert.ok(!serialized.includes(marker)); assert.ok(!serialized.includes(h.key)); return true;
  });
  assert.equal(h.requests.length, 1); assertAccountReadsOnly(h);
});

await check("an empty page before the advertised total rejects the incomplete account snapshot", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setAccountHandler(request => Response.json({ data: { items: Number(new URL(request.url).searchParams.get("offset")) === 0 ? [voice("firstClone"), voice("secondClone")] : [], total: 6 } }));
  await assert.rejects(maziao.adminAccountVoices(h.key), { code: "VOICE_SYNC_PAGINATION" });
  assert.equal(h.requests.length, 2); assertAccountReadsOnly(h);
});

await check("an account page cannot claim completion while its total still promises missing clones", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setAccountHandler(() => Response.json({ data: { items: [voice("partialClone")], total: 6, hasMore: false } }));
  await assert.rejects(maziao.adminAccountVoices(h.key), { code: "VOICE_SYNC_PAGINATION" });
  assert.equal(h.requests.length, 1); assertAccountReadsOnly(h);
});

await check("a repeated account page stops sync instead of looping or declaring a partial list complete", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setAccountHandler(() => Response.json({ data: { items: [voice("sameClone1"), voice("sameClone2")], total: 6 } }));
  await assert.rejects(maziao.adminAccountVoices(h.key), { code: "VOICE_SYNC_PAGINATION" });
  assert.equal(h.requests.length, 2); assertAccountReadsOnly(h);
});

await check("a provider failure after a partial account page is not converted into a successful empty or fallback sync", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setAccountHandler(request => Number(new URL(request.url).searchParams.get("offset")) === 0
    ? Response.json({ data: { items: [voice("partialClone")], total: 6 } })
    : Response.json({ errors: ["offline-private-account-details"] }, { status: 503 }));
  await assert.rejects(maziao.adminAccountVoices(h.key), error => {
    assert.equal(error.code, "MAZIAO_REJECTED"); assert.ok(!error.message.includes("offline-private-account-details")); return true;
  });
  assert.equal(h.requests.length, 2); assertAccountReadsOnly(h);
});

await check("verified public reference voices can use a compatible engine independent of their original model", async () => {
  const h = await harness(), maziao = await provider(h);
  const originalVoice = voice("crossModelVoice", { modelId: "lingual_speech_v2", type: "legacy-reference" });
  const snakeVoice = { id: "snakeVoice", name: "Snake voice", user_id: null, language: "vi", model_id: "lingual_speech_v2", ref_file: "https://r2-storage.maziao.com/voices/snake.wav", ref_text: "Lời mẫu bằng tiếng Việt." };
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    assert.ok(request.url.includes("/voices?"));
    const query = new URL(request.url).searchParams;
    assert.equal(query.get("type"), "system"); assert.equal(query.has("modelId"), false);
    return Response.json({ data: { items: [originalVoice, snakeVoice], total: 2 } });
  });
  const listed = await maziao.listMaziaoVoices(h.key, alice);
  assert.deepEqual(Array.from(listed, item => item.voiceId), [scoped("crossModelVoice"), scoped("snakeVoice")]);
  assert.equal(h.grants.get(`${alice}:${scoped("crossModelVoice")}`).source, "shared");
  h.setHandler(request => {
    if (request.url.includes("/voices?")) {
      const query = new URL(request.url).searchParams;
      assert.equal(query.get("type"), "system"); assert.equal(query.get("language"), "vi");
      assert.equal(query.get("search"), originalVoice.name); assert.equal(query.has("modelId"), false);
      return Response.json({ data: { items: [originalVoice], total: 1 } });
    }
    assert.ok(request.url.endsWith("/voices/crossModelVoice"));
    return Response.json({ data: originalVoice });
  });
  assert.equal(await maziao.authorizeMaziaoVoice(alice, scoped("crossModelVoice")), scoped("crossModelVoice"));
  h.setHandler(() => Response.json({ data: { ...originalVoice, userId: "private-provider-owner" } }));
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("crossModelVoice")), { code: "VOICE_NOT_AUTHORIZED" });
  h.setHandler(() => Response.json({ data: { ...originalVoice, refText: "" } }));
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("crossModelVoice")), { code: "VOICE_NOT_AUTHORIZED" });
  assert.equal(h.charged.length, 0);
});

await check("an ownerless detail response cannot authorize a voice absent from the fresh system catalog", async () => {
  const h = await harness(), maziao = await provider(h);
  h.grant(alice, scoped("staleOwnerless"), "shared");
  h.setHandler(request => {
    if (request.url.endsWith("/voices/staleOwnerless")) return Response.json({ data: voice("staleOwnerless") });
    assert.ok(request.url.includes("/voices?"));
    const query = new URL(request.url).searchParams;
    assert.equal(query.get("type"), "system"); assert.equal(query.get("language"), "vi");
    assert.equal(query.get("search"), "staleOwnerless");
    return Response.json({ data: { items: [voice("differentId", { name: "staleOwnerless" })], total: 1 } });
  });
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("staleOwnerless")), { code: "VOICE_NOT_AUTHORIZED" });
  assert.equal(h.requests.length, 2); assert.equal(h.charged.length, 0);
});

await check("stale shared grants are blocked by the speech route before any paid TTS job", async () => {
  for (const explicitOwner of [false, true]) {
    const h = await harness();
    await provider(h);
    h.grant(alice, scoped("staleSharedVoice"), "shared");
    h.setHandler(request => {
      if (request.url.endsWith("/voices/staleSharedVoice")) return Response.json({ data: voice("staleSharedVoice", explicitOwner ? { userId: "foreign-private-owner" } : {}) });
      if (request.url.includes("/voices?")) {
        assert.equal(new URL(request.url).searchParams.get("type"), "system");
        return Response.json({ data: { items: [], total: 0 } });
      }
      throw new Error("Unauthorized shared voice must not submit, poll or download speech");
    });
    const route = await h.entry("app/api/speech/route.ts");
    const response = await route.POST(new Request("https://app.example/api/speech", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/json" }, body: JSON.stringify({ voiceId: scoped("staleSharedVoice"), segments: sampleSegments(), duration: 7 }) }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, "VOICE_NOT_AUTHORIZED");
    assert.equal(h.charged.length, 0); assert.equal(h.media.size, 0);
    assert.ok(h.requests.every(request => request.method === "GET" && request.url.includes("/voices")));
  }
});

await check("historical shared grants cannot authorize private provider voices", async () => {
  const h = await harness(), maziao = await provider(h);
  h.grant(alice, scoped("privateVoice"), "shared");
  h.setHandler(() => Response.json({ data: voice("privateVoice", { userId: "provider-account" }) }));
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("privateVoice")), { code: "VOICE_NOT_AUTHORIZED" });
  assert.equal(h.requests.length, 1); assert.equal(h.charged.length, 0);
});

await check("a deleted personal clone does not hide the remaining personal and public voices", async () => {
  const h = await harness(), maziao = await provider(h);
  h.grant(alice, scoped("deletedClone")); h.grant(alice, scoped("liveClone"));
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.includes("/voices?")) return Response.json({ data: { items: [voice("publicVoice")] } });
    if (request.url.endsWith("/voices/deletedClone")) return Response.json({ errors: ["Voice deleted outside the app"] }, { status: 404 });
    assert.ok(request.url.endsWith("/voices/liveClone"));
    return Response.json({ data: voice("liveClone", { userId: "provider-account" }) });
  });
  const result = await maziao.listMaziaoVoices(h.key, alice);
  assert.deepEqual(Array.from(result, item => item.voiceId), [scoped("liveClone"), scoped("publicVoice")]);
  assert.ok(h.grants.has(`${alice}:${scoped("publicVoice")}`));
  assert.equal(h.charged.length, 0);
});

await check("personal clone lookup never swallows authentication, network or malformed-response errors", async () => {
  for (const [mode, code] of [["auth", "MAZIAO_AUTH"], ["network", "MAZIAO_UNAVAILABLE"], ["malformed", "MAZIAO_INVALID_RESPONSE"]]) {
    const h = await harness(), maziao = await provider(h);
    h.grant(alice, scoped("ownClone"));
    h.setHandler(request => {
      if (request.url.endsWith("/configs")) return config();
      if (request.url.includes("/voices?")) return Response.json({ data: { items: [voice("publicVoice")] } });
      assert.ok(request.url.endsWith("/voices/ownClone"));
      if (mode === "network") throw new Error(`Network error ${h.key}`);
      return mode === "auth" ? Response.json({ errors: [h.key] }, { status: 401 }) : Response.json({ data: null });
    });
    await assert.rejects(maziao.listMaziaoVoices(h.key, alice), error => error.code === code && !error.message.includes(h.key));
    assert.equal(h.charged.length, 0);
    assert.ok(!h.grants.has(`${alice}:${scoped("publicVoice")}`));
  }
});

await check("provider and model namespaces prevent collisions and arbitrary voice access", async () => {
  const h = await harness(), maziao = await provider(h);
  h.grant(bob, scoped("foreignVoice")); h.grant(alice, "sameRawId", "personal");
  h.setHandler(() => { throw new Error("Unauthorized voice must not reach provider"); });
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, "sameRawId"), { code: "INVALID_VOICE" });
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("sameRawId")), { code: "VOICE_NOT_AUTHORIZED" });
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("foreignVoice")), { code: "VOICE_NOT_AUTHORIZED" });
  for (const id of ["maziao:vieten_speech:x:extra", "maziao:jeck_speech:x", "maziao:vieten_speech:../x", "eleven:vieten_speech:x"]) assert.throws(() => maziao.parseMaziaoVoiceId(id), { code: "INVALID_VOICE" });
  assert.equal(h.requests.length, 0); assert.equal(h.charged.length, 0);
  h.grant(alice, scoped("sameRawId", "lingual_speech_v2"));
  h.setHandler(() => Response.json({ data: voice("sameRawId") }));
  await assert.rejects(maziao.authorizeMaziaoVoice(alice, scoped("sameRawId", "lingual_speech_v2")), { code: "MAZIAO_VOICE_MODEL" });
});

await check("provider errors never reflect API secrets, private text or raw provider messages", async () => {
  for (const [status, code] of [[401, "MAZIAO_AUTH"], [403, "MAZIAO_AUTH"], [402, "MAZIAO_BALANCE"], [429, "MAZIAO_LIMIT"], [422, "MAZIAO_REJECTED"], [500, "MAZIAO_REJECTED"]]) {
    const h = await harness(), maziao = await provider(h);
    h.setHandler(() => Response.json({ errors: [`${h.key}: PRIVATE_TEXT https://private.invalid/sample.wav`] }, { status }));
    await assert.rejects(maziao.listMaziaoVoices(h.key, alice), error => error.code === code && !/PRIVATE_TEXT|private\.invalid/.test(error.message) && !error.message.includes(h.key));
    assert.equal(h.charged.length, 0);
  }
  const h = await harness(), maziao = await provider(h);
  h.setHandler(() => Response.json({ data: null, errors: [h.key] }));
  await assert.rejects(maziao.listMaziaoVoices(h.key, alice), error => error.code === "MAZIAO_REJECTED" && !error.message.includes(h.key));
});

await check("speech submits the entire timeline once, polls at three seconds, and stores actual WAV durations", async () => {
  const h = await harness(), maziao = await provider(h), original = sampleSegments();
  h.setHandler(speechHandler(h, { status: "processing-first", onSubmit: body => {
    assert.equal(body.mode, "multiParts"); assert.equal(body.modelId, "lingual_speech_v2");
    assert.deepEqual(body.parts, original.map(item => ({ text: item.text, voiceId: "publicVoice", speed: 1, pitch: 1 })));
    assert.equal(body.config.export_srt, false);
  } }));
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: original, duration: 7 });
  assert.equal(result.provider, "maziao"); assert.equal(result.voiceId, shortSpeechVoice());
  assert.equal(result.usage.credits, 34.5); assert.equal(result.usage.jobs, 1);
  assert.deepEqual(Array.from(result.segments, item => item.duration), [1, 2]);
  assert.deepEqual(Array.from(result.segments, item => item.revised), [false, false]);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/status")).length, 2);
  assert.deepEqual(h.waits, [3000]); assert.equal(h.media.size, 2); assert.equal(h.shortened.length, 0);
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].credits, 34.5); assert.equal(h.usage[0].characters, 28);
  assert.equal(h.timing.find(entry => entry.phase === "completed")?.providerWaitMs, 3000);
  for (const secret of [h.key, original[0].text, "https://"]) assert.ok(!JSON.stringify(h.timing).includes(secret));
  assert.ok(!JSON.stringify(h.usage).includes(h.key)); assert.ok(!JSON.stringify(h.usage).includes(original[0].text));
  for (const request of h.requests) {
    if (isApi(request)) assert.equal(request.headers.Authorization, `Bearer ${h.key}`);
    else { assert.equal(request.headers, undefined); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error"); }
  }
});

await check("standalone narration uses paragraph mode, one voice, and the provider's single resultUrl", async () => {
  const h = await harness(), maziao = await provider(h), text = "Đây là lời thoại liên tục để kiểm tra một giọng đọc duy nhất.";
  const mediaUrl = "https://r2-storage.maziao.com/tts-outputs/standalone.wav";
  const bytes = wavBytes(1.5);
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.endsWith("/tts/submit")) {
      const body = JSON.parse(request.body);
      assert.equal(body.mode, "paragraph");
      assert.equal(body.voiceId, "publicVoice");
      assert.equal(body.modelId, "lingual_speech_v2");
      assert.deepEqual(body.parts, [{ text }]);
      assert.deepEqual(body.config, { speed: 1.1, volume: 1.2, pitch: 0.9, export_srt: false });
      return Response.json({ data: { taskId: "standalone", totalCost: 12.5 } });
    }
    if (request.url.endsWith("/tts/status")) return Response.json({ data: [{ id: "standalone", status: "completed", resultUrl: mediaUrl }] });
    if (request.url === mediaUrl) return new Response(bytes, { headers: { "content-type": "audio/wav" } });
    throw new Error(`Unexpected request ${request.url}`);
  });
  const result = await maziao.generateMaziaoVoiceOver({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), text, speed: 1.1, volume: 1.2, pitch: 0.9 });
  assert.equal(result.audioMime, "audio/wav");
  assert.equal(result.duration, 1.5);
  assert.equal(result.voiceId, shortSpeechVoice());
  assert.equal(result.usage.credits, 12.5);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.deepEqual(Array.from(h.media.get(result.audioPath)), Array.from(bytes));
  assert.equal(h.indexedAudio.length, 1);
  assert.equal(h.indexedAudio[0].audioPath, result.audioPath);
  assert.equal(h.indexedAudio[0].sizeBytes, bytes.length);
  assert.deepEqual(h.timing.map(entry => entry.phase), ["submitted", "completed"]);
  assert.equal(h.timing[0].modelCheckMs, 0);
  assert.equal(h.timing[1].storageMs, 0);
  assert.ok(!JSON.stringify(h.timing).includes(text));
});

await check("positive model validation is briefly reused and a rotated key gets its own check", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(speechHandler(h, { durations: [1] }));
  const input = { userId: alice, voiceId: shortSpeechVoice(), text: exactMinimumText, speed: 1, volume: 1, pitch: 1 };
  await maziao.generateMaziaoVoiceOver({ ...input, key: h.key });
  await maziao.generateMaziaoVoiceOver({ ...input, key: h.key });
  assert.equal(h.requests.filter(request => request.url.endsWith("/configs")).length, 1);
  await maziao.generateMaziaoVoiceOver({ ...input, key: `${h.key}-rotated` });
  assert.equal(h.requests.filter(request => request.url.endsWith("/configs")).length, 2);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 3);
});

await check("vieten rejects totals below 100 characters before network, quota or script changes", async () => {
  const h = await harness(), maziao = await provider(h);
  assert.equal(exactMinimumText.length, 100);
  const segments = [{ start: 0, end: 20, text: exactMinimumText.slice(0, 99) }];
  const original = JSON.stringify(segments);
  h.setHandler(() => { throw new Error("Short script must fail before any provider read or submission"); });
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 20 }), { code: "MAZIAO_TEXT_TOO_SHORT", action: "script" });
  assert.equal(h.requests.length, 0); assert.equal(h.charged.length, 0); assert.equal(h.usage.length, 0);
  assert.equal(JSON.stringify(segments), original); assert.equal(h.shortened.length, 0);
});

await check("vieten submits an exact 100-character script unchanged and logs its validated task ID", async () => {
  const h = await harness(), maziao = await provider(h);
  const segments = [{ start: 0, end: 20, text: exactMinimumText }];
  h.setHandler(speechHandler(h, { durations: [2], onSubmit: body => {
    assert.equal(body.modelId, "vieten_speech");
    assert.equal(body.parts.length, 1); assert.equal(body.parts[0].text, exactMinimumText);
  } }));
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 20 });
  assert.equal(result.segments[0].text, exactMinimumText); assert.equal(result.segments[0].revised, false);
  assert.equal(result.usage.jobs, 1); assert.deepEqual(h.charged, [1]);
  assert.equal(h.usage[0].taskId, "task_1"); assert.equal(h.usage[0].characters, 100);
  assert.ok(!JSON.stringify(h.usage).includes(exactMinimumText));
});

await check("vieten preflight counts the batch total without assuming a minimum for each part", async () => {
  const h = await harness(), maziao = await provider(h);
  const segments = [{ start: 0, end: 10, text: exactMinimumText.slice(0, 40) }, { start: 10, end: 20, text: exactMinimumText.slice(40) }];
  h.setHandler(speechHandler(h, { durations: [1, 2], onSubmit: body => {
    assert.deepEqual(body.parts.map(part => part.text), segments.map(segment => segment.text));
  } }));
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 20 });
  assert.equal(result.segments.length, 2); assert.deepEqual(h.charged, [1]);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
});

await check("vieten stops a short offending batch before rewriting or charging a replacement job", async () => {
  const h = await harness(), maziao = await provider(h);
  const segments = [{ start: 0, end: 20, text: exactMinimumText }, { start: 21, end: 24, text: "Xin chào." }];
  h.setHandler(speechHandler(h, { durations: [2, 6] }));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 24 }), { code: "TIMING_NEEDS_EDIT", action: "script" });
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.deepEqual(h.charged, [2]); assert.equal(h.shortened.length, 0);
  assert.equal(h.usage.length, 1); assert.equal(h.media.size, 0); assert.equal(segments[1].text, "Xin chào.");
});

await check("vieten never pads a shortened retry below its minimum or submits a second paid job", async () => {
  const h = await harness(), maziao = await provider(h);
  const segments = [{ start: 0, end: 3, text: exactMinimumText }];
  h.setHandler(speechHandler(h, { durations: [6] }));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 3 }), { code: "TIMING_NEEDS_EDIT", action: "script" });
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  // One accepted Maziao job and one separate ten-credit rewrite; no replacement TTS job.
  assert.deepEqual(h.charged, [1, 10]); assert.deepEqual(h.shortened, [exactMinimumText]);
  assert.equal(h.usage.length, 1); assert.equal(h.media.size, 0); assert.equal(segments[0].text, exactMinimumText);
});

await check("accepted job IDs and actual credits remain logged when audio validation fails", async () => {
  const h = await harness(), maziao = await provider(h);
  const valid = speechHandler(h, { durations: [1], totalCost: 35.25 });
  h.setHandler(request => isApi(request) ? valid(request) : new Response(new Uint8Array([1, 2, 3, 4])));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: [{ start: 0, end: 20, text: exactMinimumText }], duration: 20 }), { code: "INVALID_AUDIO", status: 422, action: "contact_admin", message: /quản trị viên kiểm tra tác vụ trước khi tạo lại/ });
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].taskId, "task_1"); assert.equal(h.usage[0].credits, 35.25);
  for (const secret of [h.key, exactMinimumText, "https://", "remainingCredits"]) assert.ok(!JSON.stringify(h.usage).includes(secret));
  assert.equal(h.media.size, 0);
});

await check("MP3 payloads use actual audio MIME and extension despite a WAV URL and content-type", async () => {
  const h = await harness(), maziao = await provider(h), mp3 = syntheticMpegFrames();
  const valid = speechHandler(h, { durations: [1] });
  h.setHandler(request => isApi(request) ? valid(request) : new Response(mp3, { headers: { "content-type": "audio/wav" } }));
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: [{ start: 0, end: 20, text: exactMinimumText }], duration: 20 });
  assert.equal(result.segments[0].audioMime, "audio/mpeg");
  assert.equal(result.segments[0].audioPath, `${alice}/narration/0.mp3`);
  assert.equal(h.storedMimes.get(result.segments[0].audioPath), "audio/mpeg");
  assert.deepEqual(h.media.get(result.segments[0].audioPath), mp3);
  assert.equal(h.mp3Reads.length, 1); assert.deepEqual(h.mp3Reads[0], mp3);
  assert.equal(result.sampleRate, 24000); assert.equal(result.channels, 1);
  assert.equal(result.segments[0].duration, 8 * 576 / 24000);
  assert.equal(result.usage.jobs, 1); assert.equal(h.shortened.length, 0);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  const download = h.requests.find(request => !isApi(request));
  assert.ok(download.url.endsWith(".wav")); assert.equal(download.headers, undefined); assert.equal(download.credentials, "omit");
});

await check("a mixed WAV and MP3 batch stores each segment's verified MIME and original bytes", async () => {
  const h = await harness(), maziao = await provider(h), mp3 = syntheticMpegFrames(), wav = wavBytes(1);
  const valid = speechHandler(h);
  h.setHandler(request => {
    if (isApi(request)) return valid(request);
    return new Response(request.url.endsWith("_0.wav") ? wav : mp3, { headers: { "content-type": "application/octet-stream" } });
  });
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 });
  assert.deepEqual(Array.from(result.segments, segment => segment.audioMime), ["audio/wav", "audio/mpeg"]);
  assert.deepEqual(Array.from(result.segments, segment => segment.audioPath), [`${alice}/narration/0.wav`, `${alice}/narration/1.mp3`]);
  assert.deepEqual(h.media.get(result.segments[0].audioPath), wav); assert.deepEqual(h.media.get(result.segments[1].audioPath), mp3);
  assert.deepEqual([...h.storedMimes.values()], ["audio/wav", "audio/mpeg"]);
  assert.equal(h.mp3Reads.length, 1); assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
});

await check("malformed MP3 or non-audio data never stores narration or silently resubmits a paid job", async () => {
  for (const bytes of [syntheticMpegFrames().subarray(0, 10), new TextEncoder().encode("<html>Provider error</html>")]) {
    const h = await harness(), maziao = await provider(h);
    const valid = speechHandler(h, { durations: [1], totalCost: 35.25 });
    h.setHandler(request => isApi(request) ? valid(request) : new Response(bytes, { headers: { "content-type": "audio/mpeg" } }));
    await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: [sampleSegments()[0]], duration: 3 }), error => {
      assert.equal(error.code, "INVALID_AUDIO"); assert.equal(error.status, 422); assert.equal(error.action, "contact_admin");
      assert.match(error.message, /Hệ thống đã nhận tác vụ/); assert.match(error.message, /quản trị viên kiểm tra tác vụ trước khi tạo lại/);
      for (const privateValue of [h.key, "<html>", "Provider error", "https://", sampleSegments()[0].text]) assert.ok(!error.message.includes(privateValue));
      return true;
    });
    assert.equal(h.media.size, 0); assert.equal(h.storedMimes.size, 0); assert.equal(h.shortened.length, 0);
    assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
    assert.equal(h.usage.length, 1); assert.equal(h.usage[0].taskId, "task_1"); assert.equal(h.usage[0].credits, 35.25);
  }
});

await check("partial storage failure also removes a previously stored MP3 narration", async () => {
  const h = await harness(), maziao = await provider(h), valid = speechHandler(h);
  h.setHandler(request => isApi(request) ? valid(request) : new Response(request.url.endsWith("_0.wav") ? syntheticMpegFrames() : wavBytes(1)));
  h.failStorageAt(1);
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), /Simulated storage failure/);
  assert.equal(h.media.size, 0); assert.equal(h.storedMimes.size, 0); assert.deepEqual(h.deleted, [`${alice}/narration/0.mp3`]);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
});

await check("unvalidated provider task IDs are never logged, polled or used for recovery", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(request => request.url.endsWith("/configs") ? config() : Response.json({ data: { taskId: `https://private.invalid/${h.key}`, totalCost: 20 } }));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), { code: "MAZIAO_INVALID_RESPONSE" });
  assert.equal(h.usage.length, 0); assert.ok(!h.requests.some(request => request.url.endsWith("/tts/status")));
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
});

await check("foreign, insecure and credential-bearing audio URLs never receive requests or secrets", async () => {
  for (const url of ["http://r2-storage.maziao.com/x.wav", "https://127.0.0.1/x.wav", "https://r2-storage.maziao.com.attacker.invalid/x.wav", "https://user:password@r2-storage.maziao.com/x.wav", "https://r2-storage.maziao.com:8443/x.wav", "https://r2-storage.maziao.com/x.wav#fragment"]) {
    const h = await harness(), maziao = await provider(h);
    h.setHandler(speechHandler(h, { durations: [1], urls: [url] }));
    await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: [sampleSegments()[0]], duration: 3 }), { code: "MAZIAO_INVALID_RESPONSE" });
    assert.ok(h.requests.every(isApi)); assert.equal(h.media.size, 0);
  }
});

await check("a submit transport failure never blindly creates a second paid job", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(request => { if (request.url.endsWith("/configs")) return config(); throw new Error(`Network failure ${h.key}`); });
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), error => error.code === "MAZIAO_UNAVAILABLE" && !error.message.includes(h.key));
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.media.size, 0);
});

await check("a pending provider job reaches a bounded timeout without submitting again", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.endsWith("/tts/submit")) return Response.json({ data: { taskId: "slow_task", totalCost: 10 } });
    assert.ok(request.url.endsWith("/tts/status"));
    return Response.json({ data: [{ id: "slow_task", status: "processing", completedTasks: 0, totalTasks: 2 }] });
  });
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), { code: "MAZIAO_TIMEOUT" });
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.waits.reduce((total, value) => total + value, 0), 240000);
  assert.equal(h.media.size, 0);
});

await check("failed provider tasks stop without downloads, hidden retries or secret-bearing messages", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(speechHandler(h, { status: "failed" }));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), error => error.code === "MAZIAO_TASK_FAILED" && !error.message.includes(h.key));
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.ok(h.requests.every(isApi)); assert.equal(h.media.size, 0);
});

await check("overlong speech retries only the offending segment and never truncates or stores failures", async () => {
  const h = await harness(), maziao = await provider(h), segments = sampleSegments();
  let submissions = 0, activeDurations;
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    if (request.url.endsWith("/tts/submit")) {
      submissions++; const body = JSON.parse(request.body);
      assert.equal(body.parts.length, submissions === 1 ? 2 : 1);
      if (submissions > 1) assert.equal(body.parts[0].text, segments[1].text.slice(0, 10));
      activeDurations = submissions === 1 ? [1, 6] : [6];
      return Response.json({ data: { taskId: `task_${submissions}`, totalCost: 10 } });
    }
    if (request.url.endsWith("/tts/status")) return Response.json({ data: [{ id: `task_${submissions}`, status: "completed", resultUrls: activeDurations.map((_, index) => `https://r2-storage.maziao.com/tts-outputs/task_${submissions}_${index}.wav`) }] });
    const index = Number(request.url.match(/_(\d+)\.wav$/)[1]);
    return new Response(wavBytes(activeDurations[index]));
  });
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments, duration: 7 }), { code: "TIMING_NEEDS_EDIT", action: "script" });
  assert.equal(submissions, 3); assert.equal(h.shortened.length, 2); assert.equal(h.media.size, 0); assert.equal(h.deleted.length, 0);
  assert.equal(segments[1].text, "Một câu chuyện nhỏ.");
  assert.equal(h.usage.length, submissions); assert.equal(h.usage.reduce((sum, event) => sum + event.credits, 0), 10 * submissions);
});

await check("successful timing corrections include the cost of every accepted generation job", async () => {
  for (const costs of [[10, 10], [10, null]]) {
    const h = await harness(), maziao = await provider(h), segments = sampleSegments();
    let submissions = 0, durations;
    h.setHandler(request => {
      if (request.url.endsWith("/configs")) return config();
      if (request.url.endsWith("/tts/submit")) {
        submissions++; const body = JSON.parse(request.body);
        assert.equal(body.parts.length, submissions === 1 ? 2 : 1);
        durations = submissions === 1 ? [1, 6] : [2];
        return Response.json({ data: { taskId: `task_${submissions}`, totalCost: costs[submissions - 1] } });
      }
      if (request.url.endsWith("/tts/status")) return Response.json({ data: [{ id: `task_${submissions}`, status: "completed", resultUrls: durations.map((_, index) => `https://r2-storage.maziao.com/tts-outputs/task_${submissions}_${index}.wav`) }] });
      const index = Number(request.url.match(/_(\d+)\.wav$/)[1]);
      return new Response(wavBytes(durations[index]));
    });
    const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments, duration: 7 });
    assert.equal(submissions, 2); assert.equal(result.usage.jobs, submissions);
    assert.equal(result.usage.credits, costs.includes(null) ? null : 10 * submissions);
    assert.deepEqual(Array.from(result.segments, segment => segment.duration), [1, 2]);
    assert.deepEqual(Array.from(result.segments, segment => segment.revised), [false, true]);
    assert.equal(h.media.size, 2);
  }
});

await check("missing or invalid provider costs stay unknown rather than appearing as free audio", async () => {
  for (const totalCost of [undefined, null, "34.5", -1, 1000000001]) {
    const h = await harness(), maziao = await provider(h);
    h.setHandler(speechHandler(h, { durations: [1], totalCost, omitCost: totalCost === undefined }));
    const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: [sampleSegments()[0]], duration: 3 });
    assert.equal(result.usage.credits, null); assert.equal(result.usage.jobs, 1); assert.equal(h.usage[0].credits, null);
    assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  }
});

await check("partial storage failure removes the narration already stored for the member", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(speechHandler(h)); h.failStorageAt(1);
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: shortSpeechVoice(), segments: sampleSegments(), duration: 7 }), /Simulated storage failure/);
  assert.equal(h.media.size, 0); assert.deepEqual(h.deleted, [`${alice}/narration/0.wav`]);
});

await check("clone requests enforce the short WAV sample and save only a scoped member grant", async () => {
  const h = await harness(), maziao = await provider(h);
  const file = new File([wavBytes(6)], "sample.wav", { type: "audio/wav" });
  h.setHandler(request => {
    if (request.url.endsWith("/configs")) return config();
    assert.equal(request.url, "https://app.maziao.com/api/voices"); assert.equal(request.method, "POST");
    const form = request.body;
    assert.ok(form instanceof FormData); assert.equal(form.get("name"), "Alice"); assert.equal(form.get("gender"), "female");
    assert.equal(form.get("language"), "vi"); assert.equal(form.get("model"), "vieten_speech"); assert.equal(form.get("removeNoise"), "0");
    assert.equal(form.get("refFile").name, "voice-sample.wav"); assert.equal(form.get("refFile").size, file.size);
    return Response.json({ data: voice("createdClone", { userId: "shared-provider-account" }) });
  });
  const result = await maziao.cloneMaziaoVoice(h.key, alice, "Alice", [file], "female");
  assert.equal(result.voiceId, scoped("createdClone"));
  assert.equal(result.previewUrl, "https://r2-storage.maziao.com/samples/createdClone.wav");
  assert.equal(h.grants.get(`${alice}:${scoped("createdClone")}`).source, "personal"); assert.deepEqual(h.charged, [50]);
  assert.equal(h.grants.get(`${alice}:${scoped("createdClone")}`).preview_url, result.previewUrl);
  const requestCount = h.requests.length;
  for (const duration of [1, 9]) await assert.rejects(maziao.cloneMaziaoVoice(h.key, alice, "Alice", [new File([wavBytes(duration)], "sample.wav")], "female"), { code: "MAZIAO_SAMPLE_DURATION" });
  await assert.rejects(maziao.cloneMaziaoVoice(h.key, alice, "Alice", [file, file], "female"), { code: "MAZIAO_SAMPLE_REQUIRED" });
  assert.equal(h.requests.length, requestCount); assert.deepEqual(h.charged, [50]);
});

await check("old member clones gain owner-only sample links without a new clone charge", async () => {
  const h = await harness(), maziao = await provider(h), mine = scoped("oldAlice"), other = scoped("oldBob");
  h.setMemberRole("member"); h.grant(alice, mine); h.grant(bob, other);
  h.setHandler(request => {
    assert.equal(new URL(request.url).pathname, "/api/voices/oldAlice");
    return Response.json({ data: voice("oldAlice", { previewUrl: "https://unsafe.example/skip.wav" }) });
  });
  await maziao.backfillMaziaoPersonalPreviews(alice);
  assert.equal(h.grants.get(`${alice}:${mine}`).preview_url, "https://r2-storage.maziao.com/voices/oldAlice.wav");
  assert.equal(h.grants.get(`${bob}:${other}`).preview_url, null);
  assert.equal(h.requests.length, 1); assert.deepEqual(h.charged, []);
  await maziao.backfillMaziaoPersonalPreviews(alice);
  assert.equal(h.requests.length, 1, "saved sample must prevent repeat provider lookups");
});

await check("missing provider samples are checked once a day and never expose unsafe links", async () => {
  const h = await harness(), maziao = await provider(h), mine = scoped("noSample");
  h.setMemberRole("member"); h.grant(alice, mine);
  h.setHandler(() => Response.json({ data: voice("noSample", { previewUrl: "https://unsafe.example/p.wav", refFile: "https://unsafe.example/r.wav" }) }));
  await maziao.backfillMaziaoPersonalPreviews(alice);
  assert.equal(h.grants.get(`${alice}:${mine}`).preview_url, null);
  assert.ok(h.grants.get(`${alice}:${mine}`).preview_checked_at);
  await maziao.backfillMaziaoPersonalPreviews(alice);
  assert.equal(h.requests.length, 1);
});

console.log(`${passed} isolated Maziao integration tests passed.`);
