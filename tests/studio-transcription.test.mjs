import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { parseBuffer } from "music-metadata";

const root = process.cwd();
const filePath = path.join(root, "lib/studio-transcription.ts");
class StudioError extends Error {
  constructor(code, message, status = 400, action) { super(message); Object.assign(this, { code, status, action }); }
}

async function loadTranscription(fetchImpl = fetch) {
  const context = vm.createContext({ process, console, File, FormData, AbortSignal, fetch: fetchImpl,
    Uint8Array, ArrayBuffer, Number, String, Error, Response });
  const module = new vm.SourceTextModule(ts.transpileModule(await fs.readFile(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText, { context, identifier: filePath });
  await module.link(specifier => {
    const exports = specifier === "server-only" ? {} : specifier === "music-metadata" ? { parseBuffer } : { StudioError };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

function wav(seconds) {
  const samples = Math.floor(seconds * 8000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset, value) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, samples * 2, true);
  return new File([bytes], "speech.wav", { type: "audio/wav" });
}

test("transcription accepts only a user's dedicated private audio path", async () => {
  const { transcriptionPath } = await loadTranscription();
  assert.equal(transcriptionPath("user-1", "user-1/video-transcriptions/recording.m4a"), "user-1/video-transcriptions/recording.m4a");
  for (const value of ["user-2/video-transcriptions/a.mp3", "user-1/voice-samples/a.mp3", "user-1/video-transcriptions/../a.mp3", "https://example.com/a.mp3", "user-1/video-transcriptions/a.mp4"])
    assert.throws(() => transcriptionPath("user-1", value), error => error.code === "INVALID_TRANSCRIPTION_FILE");
});

test("transcription charge duration comes from stored audio bytes", async () => {
  const { measureTranscriptionAudio } = await loadTranscription();
  assert.equal(await measureTranscriptionAudio(wav(2.5)), 2.5);
  await assert.rejects(measureTranscriptionAudio(wav(1)), error => error.code === "INVALID_TRANSCRIPTION_DURATION");
  await assert.rejects(measureTranscriptionAudio(new File(["not audio"], "bad.wav", { type: "audio/wav" })),
    error => error.code === "INVALID_TRANSCRIPTION_DURATION");
});

test("Scribe response preserves verbatim transcript and actual word timestamps", async () => {
  const { parseTranscriptionResult } = await loadTranscription();
  const result = parseTranscriptionResult({ text: "Xin chào bạn.", language_code: "vie", words: [
    { text: "Xin", type: "word", start: 0.2, end: 0.5 },
    { text: " ", type: "spacing", start: 0.5, end: 0.5 },
    { text: "chào", type: "word", start: 0.6, end: 1.1 },
    { text: "(music)", type: "audio_event", start: 1.2, end: 1.4 },
    { text: "bạn.", type: "word", start: 1.5, end: 1.9 },
  ] }, 2.5);
  assert.equal(result.text, "Xin chào bạn.");
  assert.deepEqual([...result.words].map(word => word.text), ["Xin", "chào", "bạn."]);
  assert.equal(result.words[1].start, 0.6);
  assert.equal(result.duration, 2.5);
  assert.throws(() => parseTranscriptionResult({ text: "Xin chào", words: [
    { type: "word", text: "Xin", start: 0.1, end: 0.3 },
  ] }, 2.5), error => error.code === "TRANSCRIPTION_INVALID");
});

test("Scribe sends the private file with a server-only key and maps permission errors", async () => {
  let calls = 0;
  const { transcribeAudio } = await loadTranscription(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(init.headers["xi-api-key"], "private-key");
    assert.equal(init.body.get("model_id"), "scribe_v2");
    assert.equal(init.body.get("language_code"), "vie");
    assert.equal(init.body.get("timestamps_granularity"), "word");
    assert.equal(init.body.get("file").size, wav(2).size);
    return Response.json({ text: "Xin chào bạn.", language_code: "vie", words: [
      { type: "word", text: "Xin", start: 0.1, end: 0.3 },
      { type: "word", text: "chào", start: 0.4, end: 0.8 },
      { type: "word", text: "bạn.", start: 0.9, end: 1.2 },
    ] });
  });
  assert.equal((await transcribeAudio(wav(2), "private-key", 2)).text, "Xin chào bạn.");
  assert.equal(calls, 1);
  const permission = await loadTranscription(async () => new Response("secret diagnostic", { status: 403 }));
  await assert.rejects(permission.transcribeAudio(wav(2), "private-key", 2), error =>
    error.code === "TRANSCRIPTION_PERMISSION" && !error.message.includes("secret diagnostic"));
});

test("transcribe route authenticates, reads private storage, and reserves before calling provider", async () => {
  const calls = [];
  let savedResult = null;
  let status = null;
  const context = vm.createContext({ process, console, Response });
  const exportsByModule = new Map([
    ["studio-contract", { StudioError }],
    ["studio-credit-operation", {
      creditRequestId: request => {
        assert.equal(request.headers.get("Idempotency-Key"), "ee3de503-9f73-4a2c-a999-9a86b07a01c9");
        calls.push("idempotency");
      },
      runWithCredits: async (_request, _user, kind, amount, run) => {
        assert.equal(kind, "transcribe"); assert.equal(amount, 3);
        calls.push("reserve"); const result = await run(); calls.push("settle"); return result;
      },
    }],
    ["studio-credits", {
      creditsForTranscription: seconds => { assert.equal(seconds, 30); return 3; },
      settleCredits: async () => { calls.push("recover-settle"); },
    }],
    ["studio-supabase", { downloadOwnedMedia: async (_user, file) => {
      assert.equal(file, "user-1/video-transcriptions/recording.mp3"); calls.push("download"); return wav(2);
    } }],
    ["studio-server", {
      requestUser: async () => { calls.push("auth"); return "user-1"; },
      limitedJson: request => request.json(), providerKey: async () => ({ key: "private-key" }),
      json: (data, status = 200) => Response.json(data, { status }), apiError: error => Response.json({ code: error.code }, { status: error.status || 500 }),
    }],
    ["studio-transcription", {
      measureTranscriptionAudio: async () => { calls.push("measure"); return 30; },
      transcriptionPath: (_user, value) => value,
      transcribeAudio: async () => { calls.push("provider"); return { text: "Xin chào bạn.", words: [{ text: "Xin", start: 0, end: 0.3 }], duration: 30, languageCode: "vie" }; },
    }],
    ["studio-transcription-result", {
      readSavedTranscription: async () => { calls.push("lookup"); return savedResult; },
      transcriptionRequestStatus: async () => { calls.push("status"); return status; },
      saveTranscription: async (_user, _id, _path, result) => { calls.push("save"); savedResult = result; status = "reserved"; },
    }],
  ]);
  const routeFile = path.join(root, "app/api/video/transcribe/route.ts");
  const module = new vm.SourceTextModule(ts.transpileModule(await fs.readFile(routeFile, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText, { context, identifier: routeFile });
  await module.link(specifier => {
    const key = [...exportsByModule.keys()].find(name => specifier.endsWith(name));
    assert.ok(key, `Unexpected dependency ${specifier}`);
    const values = exportsByModule.get(key);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const response = await module.namespace.POST(new Request("https://ibeetool.com/api/video/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ee3de503-9f73-4a2c-a999-9a86b07a01c9" },
    body: JSON.stringify({ storagePath: "user-1/video-transcriptions/recording.mp3" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "Xin chào bạn.");
  assert.deepEqual(calls, ["auth", "idempotency", "lookup", "status", "download", "measure", "reserve", "provider", "save", "settle"]);
  calls.length = 0;
  const replay = await module.namespace.POST(new Request("https://ibeetool.com/api/video/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ee3de503-9f73-4a2c-a999-9a86b07a01c9" },
    body: JSON.stringify({ storagePath: "user-1/video-transcriptions/recording.mp3" }),
  }));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).text, "Xin chào bạn.");
  assert.deepEqual(calls, ["auth", "idempotency", "lookup", "recover-settle"]);
  calls.length = 0;
  savedResult = null; status = "reserved";
  const pending = await module.namespace.POST(new Request("https://ibeetool.com/api/video/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ee3de503-9f73-4a2c-a999-9a86b07a01c9" },
    body: JSON.stringify({ storagePath: "user-1/video-transcriptions/recording.mp3" }),
  }));
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).pending, true);
  assert.deepEqual(calls, ["auth", "idempotency", "lookup", "status"]);
  calls.length = 0;
  status = "refunded";
  const refunded = await module.namespace.POST(new Request("https://ibeetool.com/api/video/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ee3de503-9f73-4a2c-a999-9a86b07a01c9" },
    body: JSON.stringify({ storagePath: "user-1/video-transcriptions/recording.mp3" }),
  }));
  assert.equal(refunded.status, 409);
  assert.equal((await refunded.json()).code, "TRANSCRIPTION_RETRY_NEW_REQUEST");
  assert.deepEqual(calls, ["auth", "idempotency", "lookup", "status"]);
});
