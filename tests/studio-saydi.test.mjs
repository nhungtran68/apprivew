import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const source = path.join(process.cwd(), "lib/studio-saydi.ts");
const requests = [];
const waits = [];
let responder = () => { throw new Error("Unexpected SaydiVoice request"); };
class StudioError extends Error {
  constructor(code, message, status = 400, action) { super(message); this.code = code; this.status = status; this.action = action; }
}
const context = vm.createContext({
  console, Date, Number, Math, String, JSON, Promise, Set, URL, Headers, Request, Response,
  AbortSignal, Uint8Array, TextDecoder, FormData, File, Blob,
  setTimeout(callback, milliseconds) { waits.push(milliseconds); queueMicrotask(callback); return 1; },
  fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return responder(String(url), init);
  },
});
const code = ts.transpileModule(await fs.readFile(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = new vm.SourceTextModule(code, { context, identifier: source });
await module.link(async specifier => {
  const values = specifier === "./studio-contract" ? { StudioError } : {};
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
await module.evaluate();
const api = module.namespace;
const key = "sv_live_offline_test_key";
const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]);

async function check(name, run) {
  requests.length = 0;
  waits.length = 0;
  await run();
  console.log(`PASS ${name}`);
}

await check("catalog uses the documented voice_id and bearer header", async () => {
  responder = () => Response.json([{ voice_id: "vi-adam", display_name: "Adam" }]);
  const result = await api.listSaydiSamples(key);
  assert.equal(result[0].voice_id, "vi-adam");
  assert.equal(requests[0].url, "https://voice.saydi.ai/api/samples");
  assert.equal(new Headers(requests[0].init.headers).get("Authorization"), `Bearer ${key}`);
});

await check("TTS sends Saydi ID and returns audio bytes with charged characters", async () => {
  responder = () => new Response(audio, { headers: {
    "content-type": "audio/mpeg", "x-ov-voice": "vi-adam", "x-ov-chars": "9",
  } });
  const result = await api.synthesizeSaydi(key, { text: "Xin chào!", voiceId: "vi-adam", speed: 1.1 });
  assert.deepEqual([...result.audio], [...audio]);
  assert.equal(result.chars, 9);
  assert.equal(requests[0].url, "https://voice.saydi.ai/api/v1/audio/speech");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "tts-1", voice: "vi-adam", input: "Xin chào!", response_format: "mp3", speed: 1.1,
  });
});

await check("429 honors Retry-After and retries; OpenAI error envelope is preserved", async () => {
  let count = 0;
  responder = () => ++count === 1
    ? Response.json({ error: { message: "Busy", code: "rate_limit_exceeded" } }, { status: 429, headers: { "Retry-After": "2", "X-OV-Limit": "api-key-window" } })
    : new Response(audio, { headers: { "content-type": "audio/mpeg", "x-ov-voice": "vi-adam", "x-ov-chars": "3" } });
  assert.equal((await api.synthesizeSaydi(key, { text: "abc", voiceId: "vi-adam" })).chars, 3);
  assert.equal(requests.length, 2);
  assert.ok(waits[0] >= 2000);
  responder = () => Response.json({ error: { message: "Quota exhausted", code: "insufficient_quota" } }, { status: 429, headers: { "Retry-After": "120", "X-OV-Limit": "usage-limit" } });
  await assert.rejects(api.synthesizeSaydi(key, { text: "abc", voiceId: "vi-adam" }), error =>
    error.code === "SAYDI_RATE_LIMIT" && error.providerCode === "insufficient_quota" && error.limit === "usage-limit");
});

await check("clone sends one recording and required consent with stable idempotency key", async () => {
  responder = () => Response.json({ id: "vc_123", status: "processing" }, { status: 201 });
  const result = await api.cloneSaydi(key, { file: new File([audio], "voice.mp3", { type: "audio/mpeg" }),
    name: "My voice", consent: true, idempotencyKey: "test-request" });
  assert.equal(result.id, "vc_123");
  assert.equal(result.status, "processing");
  assert.equal(new Headers(requests[0].init.headers).get("Idempotency-Key"), "test-request");
  const form = requests[0].init.body;
  assert.equal(form.get("name"), "My voice");
  assert.equal(form.get("consent"), "true");
  assert.equal(form.get("language"), "vi");
  assert.equal(form.get("file").name, "voice.mp3");
});

await check("a failed POST connection is not submitted twice", async () => {
  responder = () => { throw new Error("socket closed after submit"); };
  await assert.rejects(api.synthesizeSaydi(key, { text: "abc", voiceId: "vi-adam" }),
    error => error.code === "SAYDI_UNAVAILABLE");
  assert.equal(requests.length, 1);
});

await check("mismatched returned voice is rejected instead of silently using a fallback", async () => {
  responder = () => new Response(audio, { headers: {
    "content-type": "audio/mpeg", "x-ov-voice": "vi-other", "x-ov-chars": "3",
  } });
  await assert.rejects(api.synthesizeSaydi(key, { text: "abc", voiceId: "vi-adam" }),
    error => error.code === "SAYDI_INVALID_RESPONSE");
});
