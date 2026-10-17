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
  const requests = [], grants = new Map(), charged = [], deleted = [], media = new Map(), waits = [], shortened = [], usage = [];
  let handle = async () => { throw new Error("Unexpected provider request"); };
  let failStorageAt;
  let now = 1700000000000;
  class TestDate extends Date { static now() { return now; } }
  const modules = new Map(), synthetics = new Map();
  const context = vm.createContext({
    console: { ...console, info: value => usage.push(JSON.parse(value)) }, crypto, process: { env: { MAZIAO_API_KEY: key } }, Date: TestDate,
    TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, FormData, File,
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, btoa, atob,
    setTimeout(callback, ms = 0) { waits.push(ms); now += ms; queueMicrotask(callback); return 0; },
    clearTimeout() {},
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method || "GET", ...init };
      requests.push(request);
      return handle(request);
    },
  });
  const grant = (userId, voiceId, source = "personal", name = voiceId) => grants.set(`${userId}:${voiceId}`, {
    user_id: userId, voice_id: voiceId, source, name, authorization_tag: "server-verified",
  });
  const server = {
    MAZIAO_MODELS: ["vieten_speech", "lingual_speech_v2"],
    maziaoModel: () => "vieten_speech",
    authorizedVoiceRows: async userId => [...grants.values()].filter(row => row.user_id === userId),
    saveAuthorizedVoice: async (userId, voiceId, name, source) => grant(userId, voiceId, source, name),
    saveSharedVoiceList: async (userId, voices) => { for (const voice of voices) grant(userId, voice.voiceId, "shared", voice.name); },
    consumeAiUnits: async (_user, units) => charged.push(units),
    providerKey: async () => ({ key, personal: false }),
  };
  const mocks = new Map([
    [path.join(root, "lib/studio-server.ts"), server],
    [path.join(root, "lib/studio-deepseek.ts"), {
      shortenSegment: async (_key, segment) => { shortened.push(segment.text); return segment.text.length > 10 ? segment.text.slice(0, 10) : segment.text; },
    }],
    [path.join(root, "lib/studio-supabase.ts"), {
      removeOwnedMedia: async (userId, paths) => {
        for (const name of paths) {
          assert.ok(name.startsWith(`${userId}/`));
          deleted.push(name); media.delete(name);
        }
      },
      storeNarration: async (userId, bytes, index) => {
        if (index === failStorageAt) throw new Error("Simulated storage failure");
        const audioPath = `${userId}/narration/${index}.wav`;
        media.set(audioPath, bytes);
        return { audioPath, audioUrl: `https://audio.example.invalid/${index}.wav` };
      },
    }],
  ]);
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
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
  return { key, requests, grants, grant, charged, deleted, media, waits, shortened, usage, wav, entry, setHandler(handler) { handle = handler; }, failStorageAt(index) { failStorageAt = index; } };
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
const config = () => Response.json({ data: { ttsModels: [{ id: "vieten_speech", support_cloning: true, supported_languages: ["vi", "en"] }] } });
const voice = (id, extra = {}) => ({ id, name: id, userId: null, language: "vi", modelId: "vieten_speech", refFile: `https://r2-storage.maziao.com/voices/${id}.wav`, refText: "Trong vườn hoa nở rực rỡ.", previewUrl: `https://r2-storage.maziao.com/samples/${id}.wav`, ...extra });
const sampleSegments = () => [{ start: 0, end: 3, text: "Xin chào." }, { start: 4, end: 7, text: "Một câu chuyện nhỏ." }];
const isApi = request => request.url.startsWith("https://app.maziao.com/api/");
async function provider(h) { return h.entry("lib/studio-maziao.ts"); }

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
        voice("publicVoice"), voice("publicVoice"), voice("foreignClone", { userId: "provider-account", name: "Bob secret" }),
        voice("staleShared", { userId: "provider-account", previewUrl: "https://private.invalid/secret.wav" }),
        voice("missingOwnership", { userId: undefined }), voice("wrongLanguage", { language: "en" }),
        voice("missingTranscript", { refText: "" }), voice("missingSample", { refFile: "" }),
        voice("unprovenCloneFlag", { refFile: undefined, refText: undefined, supportCloning: true }),
      ] } });
    }
    assert.equal(request.url, "https://app.maziao.com/api/voices/ownClone");
    return Response.json({ data: voice("ownClone", { userId: "provider-account" }) });
  });
  const voices = await maziao.listMaziaoVoices(h.key, alice);
  assert.deepEqual(Array.from(voices, item => item.voiceId), [scoped("ownClone"), scoped("publicVoice")]);
  assert.equal(voices[0].group, "personal"); assert.equal(voices[1].group, "vietnamese");
  const visible = JSON.stringify(voices);
  for (const secret of ["foreignClone", "Bob secret", "staleShared", "missingOwnership", "wrongLanguage", "missingTranscript", "missingSample", "unprovenCloneFlag", "private.invalid", "provider-account", "refFile", "refText"]) assert.ok(!visible.includes(secret));
  assert.ok(h.grants.has(`${alice}:${scoped("publicVoice")}`));
  assert.ok(!h.requests.some(request => request.url.includes("my-voices")));
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

await check("speech submits the entire timeline once, polls at six seconds, and stores actual WAV durations", async () => {
  const h = await harness(), maziao = await provider(h), original = sampleSegments();
  h.setHandler(speechHandler(h, { status: "processing-first", onSubmit: body => {
    assert.equal(body.mode, "multiParts"); assert.equal(body.modelId, "vieten_speech");
    assert.deepEqual(body.parts, original.map(item => ({ text: item.text, voiceId: "publicVoice", speed: 1, pitch: 1 })));
    assert.equal(body.config.export_srt, false);
  } }));
  const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: original, duration: 7 });
  assert.equal(result.provider, "maziao"); assert.equal(result.voiceId, scoped("publicVoice"));
  assert.equal(result.usage.credits, 34.5); assert.equal(result.usage.jobs, 1);
  assert.deepEqual(Array.from(result.segments, item => item.duration), [1, 2]);
  assert.deepEqual(Array.from(result.segments, item => item.revised), [false, false]);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/status")).length, 2);
  assert.deepEqual(h.waits, [6000]); assert.equal(h.media.size, 2); assert.equal(h.shortened.length, 0);
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].credits, 34.5); assert.equal(h.usage[0].characters, 28);
  assert.ok(!JSON.stringify(h.usage).includes(h.key)); assert.ok(!JSON.stringify(h.usage).includes(original[0].text));
  for (const request of h.requests) {
    if (isApi(request)) assert.equal(request.headers.Authorization, `Bearer ${h.key}`);
    else { assert.equal(request.headers, undefined); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error"); }
  }
});

await check("foreign, insecure and credential-bearing audio URLs never receive requests or secrets", async () => {
  for (const url of ["http://r2-storage.maziao.com/x.wav", "https://127.0.0.1/x.wav", "https://r2-storage.maziao.com.attacker.invalid/x.wav", "https://user:password@r2-storage.maziao.com/x.wav", "https://r2-storage.maziao.com:8443/x.wav", "https://r2-storage.maziao.com/x.wav#fragment"]) {
    const h = await harness(), maziao = await provider(h);
    h.setHandler(speechHandler(h, { durations: [1], urls: [url] }));
    await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: [sampleSegments()[0]], duration: 3 }), { code: "MAZIAO_INVALID_RESPONSE" });
    assert.ok(h.requests.every(isApi)); assert.equal(h.media.size, 0);
  }
});

await check("a submit transport failure never blindly creates a second paid job", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(request => { if (request.url.endsWith("/configs")) return config(); throw new Error(`Network failure ${h.key}`); });
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: sampleSegments(), duration: 7 }), error => error.code === "MAZIAO_UNAVAILABLE" && !error.message.includes(h.key));
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
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: sampleSegments(), duration: 7 }), { code: "MAZIAO_TIMEOUT" });
  assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  assert.equal(h.waits.reduce((total, value) => total + value, 0), 240000);
  assert.equal(h.media.size, 0);
});

await check("failed provider tasks stop without downloads, hidden retries or secret-bearing messages", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(speechHandler(h, { status: "failed" }));
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: sampleSegments(), duration: 7 }), error => error.code === "MAZIAO_TASK_FAILED" && !error.message.includes(h.key));
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
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 7 }), { code: "TIMING_NEEDS_EDIT", action: "script" });
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
    const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments, duration: 7 });
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
    const result = await maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: [sampleSegments()[0]], duration: 3 });
    assert.equal(result.usage.credits, null); assert.equal(result.usage.jobs, 1); assert.equal(h.usage[0].credits, null);
    assert.equal(h.requests.filter(request => request.url.endsWith("/tts/submit")).length, 1);
  }
});

await check("partial storage failure removes the narration already stored for the member", async () => {
  const h = await harness(), maziao = await provider(h);
  h.setHandler(speechHandler(h)); h.failStorageAt(1);
  await assert.rejects(maziao.generateMaziaoSpeech({ key: h.key, userId: alice, voiceId: scoped("publicVoice"), segments: sampleSegments(), duration: 7 }), /Simulated storage failure/);
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
  assert.equal(h.grants.get(`${alice}:${scoped("createdClone")}`).source, "personal"); assert.deepEqual(h.charged, [10]);
  const requestCount = h.requests.length;
  for (const duration of [1, 9]) await assert.rejects(maziao.cloneMaziaoVoice(h.key, alice, "Alice", [new File([wavBytes(duration)], "sample.wav")], "female"), { code: "MAZIAO_SAMPLE_DURATION" });
  await assert.rejects(maziao.cloneMaziaoVoice(h.key, alice, "Alice", [file, file], "female"), { code: "MAZIAO_SAMPLE_REQUIRED" });
  assert.equal(h.requests.length, requestCount); assert.deepEqual(h.charged, [10]);
});

console.log(`${passed} isolated Maziao integration tests passed.`);
