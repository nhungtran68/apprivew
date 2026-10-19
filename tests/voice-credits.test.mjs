import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const userId = "11111111-1111-4111-8111-111111111111";
const ids = {
  success: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  failed: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ambiguous: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  empty: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  clone: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

function wav(seconds = 1) {
  const size = seconds * 16000 * 2;
  const bytes = new Uint8Array(44 + size), view = new DataView(bytes.buffer);
  const tag = (offset, value) => value.split("").forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, size, true);
  return bytes;
}

async function harness() {
  let balance = 100, status = "completed", submitFailure = false;
  const operations = new Map(), requests = [], events = [];
  const modules = new Map(), synthetics = new Map();
  let contract;
  const context = vm.createContext({
    console: { ...console, info: () => {} }, crypto, process: { env: {} },
    TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, FormData, File,
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, setTimeout,
    fetch: async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      requests.push({ pathname, method: init.method || "GET" });
      if (pathname === "/api/configs") return Response.json({ data: { ttsModels: [{ id: "vieten_speech", support_cloning: true, supported_languages: ["vi"] }] } });
      if (pathname === "/api/tts/submit") {
        if (submitFailure) throw new Error("Network broke after sending body");
        return Response.json({ data: { taskId: "taskVoice1", totalCost: 109 } });
      }
      if (pathname === "/api/tts/status") return Response.json({ data: [{ id: "taskVoice1", status, resultUrl: "https://r2-storage.maziao.com/voice.wav" }] });
      if (pathname === "/voice.wav") return new Response(wav(), { headers: { "content-type": "audio/wav" } });
      if (pathname === "/api/voices" && init.method === "POST") return Response.json({ data: { id: "clone123", refFile: "https://r2-storage.maziao.com/sample.wav" } });
      throw new Error(`Unexpected provider path ${pathname}`);
    },
  });
  const credit = {
    creditsForSpeech: chars => Math.ceil(chars / 100),
    deriveCreditRequestId: async (parent, label) => `${parent.slice(0, 8)}-${parent.slice(9, 13)}-8${parent.slice(15, 18)}-8${parent.slice(20, 23)}-${label.padEnd(12, "0").slice(0, 12)}`,
    reserveCredits: async (_user, requestId, kind, amount) => {
      if (operations.has(requestId)) return { created: false };
      if (balance < amount) throw new contract.StudioError("INSUFFICIENT_CREDITS", "Hết credit", 402);
      balance -= amount;
      operations.set(requestId, { kind, amount, status: "reserved" });
      events.push(["reserve", kind, amount]);
      return { created: true };
    },
    markCreditProviderTask: async (_user, id, taskId) => { operations.get(id).providerTaskId = taskId; events.push(["mark", taskId]); },
    settleCredits: async (_user, id) => { operations.get(id).status = "settled"; events.push(["settle", id]); },
    refundCredits: async (_user, id) => { const op = operations.get(id); if (op.status === "reserved") { balance += op.amount; op.status = "refunded"; } events.push(["refund", id]); },
  };
  const server = {
    MAZIAO_MODELS: ["vieten_speech", "lingual_speech_v2"], maziaoModel: () => "vieten_speech",
    authorizedVoiceRows: async () => [], consumeAiUnits: async () => { throw new Error("Legacy billing called"); },
    consumeVoiceClone: async () => { throw new Error("Legacy billing called"); },
    getMember: async () => ({ role: "member" }), sharedVoiceCatalog: async () => [],
    providerKey: async () => ({ key: "offline-provider-key" }),
    saveAuthorizedVoice: async () => {}, savePersonalVoicePreview: async () => {}, saveSharedVoiceList: async () => {},
  };
  const mocks = new Map([
    [path.join(root, "lib/studio-credits.ts"), credit],
    [path.join(root, "lib/studio-server.ts"), server],
    [path.join(root, "lib/studio-deepseek.ts"), { shortenSegment: async () => { throw new Error("No shortening expected"); } }],
    [path.join(root, "lib/studio-supabase.ts"), {
      removeOwnedMedia: async () => {},
      storeNarration: async () => ({ audioPath: `${userId}/narration/result.wav`, audioUrl: "https://audio.example.invalid/result.wav" }),
    }],
    [path.join(root, "lib/studio-mp3.ts"), { inspectMp3: async () => { throw new Error("Expected WAV"); } }],
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
    const file = specifier === "server-only" ? specifier : specifier.startsWith("@/") ? `${path.join(root, specifier.slice(2))}.ts` : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
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
  async function entry(name) {
    const module = await load(path.join(root, name));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  contract = await entry("lib/studio-contract.ts");
  const maziao = await entry("lib/studio-maziao.ts");
  return { maziao, operations, requests, events, setBalance: value => { balance = value; }, balance: () => balance, setStatus: value => { status = value; }, setSubmitFailure: value => { submitFailure = value; } };
}

const script = "Đây là lời thoại tiếng Việt đã được người dùng duyệt. ".repeat(3);
const base = { key: "offline-provider-key", userId, voiceId: "maziao:vieten_speech:voiceA", text: script, speed: 1, volume: 1, pitch: 1 };

const success = await harness();
const result = await success.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.success });
assert.equal(result.provider, "maziao");
assert.equal(result.usage.credits, 109);
assert.equal(success.balance(), 98);
assert.equal(success.operations.get(ids.success).status, "settled");
assert.equal(success.operations.get(ids.success).providerTaskId, "taskVoice1");
await assert.rejects(success.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.success }), { code: "CREDIT_REQUEST_REUSED" });
assert.equal(success.requests.filter(item => item.pathname === "/api/tts/submit").length, 1);

const failed = await harness();
failed.setStatus("failed");
await assert.rejects(failed.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.failed }), { code: "MAZIAO_TASK_FAILED" });
assert.equal(failed.balance(), 100);
assert.equal(failed.operations.get(ids.failed).status, "refunded");

const ambiguous = await harness();
ambiguous.setSubmitFailure(true);
await assert.rejects(ambiguous.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.ambiguous }), { code: "MAZIAO_UNAVAILABLE" });
assert.equal(ambiguous.balance(), 98);
assert.equal(ambiguous.operations.get(ids.ambiguous).status, "reserved");
await assert.rejects(ambiguous.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.ambiguous }), { code: "CREDIT_REQUEST_REUSED" });
assert.equal(ambiguous.requests.filter(item => item.pathname === "/api/tts/submit").length, 1);

const empty = await harness();
empty.setBalance(0);
await assert.rejects(empty.maziao.generateMaziaoVoiceOver({ ...base, requestId: ids.empty }), { code: "INSUFFICIENT_CREDITS" });
assert.equal(empty.requests.filter(item => item.pathname === "/api/tts/submit").length, 0);

const clone = await harness();
const sample = new File([wav(4)], "sample.wav", { type: "audio/wav" });
const voice = await clone.maziao.cloneMaziaoVoice(base.key, userId, "Giọng của tôi", [sample], "female", ids.clone);
assert.equal(voice.voiceId, "maziao:vieten_speech:clone123");
assert.equal(clone.balance(), 50);
assert.equal(clone.operations.get(ids.clone).status, "settled");
assert.equal(clone.requests.filter(item => item.pathname === "/api/voices" && item.method === "POST").length, 1);

console.log("PASS voice credit reserve, settle, refund, replay, ambiguous job, zero balance and clone");
