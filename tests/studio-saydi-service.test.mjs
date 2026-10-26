import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const userId = "11111111-1111-4111-8111-111111111111";
const calls = { reserved: [], settled: [], refunded: [], stored: [], cloned: [], marked: [], grants: [] };
let speak = async () => ({ audio: new Uint8Array([0x49, 0x44, 0x33]), mime: "audio/mpeg", chars: 100 });
let clone = async () => ({ id: "vc_owned", status: "ready" });
class StudioError extends Error {
  constructor(code, message, status = 400, action) { super(message); this.code = code; this.status = status; this.action = action; }
}
class SaydiApiError extends StudioError {}

const mocks = new Map([
  ["studio-contract", { StudioError }],
  ["studio-credits", {
    creditRates: { clone: 50 }, creditsForSpeech: chars => Math.ceil(chars / 100),
    deriveCreditRequestId: async (_id, label) => label,
    reserveCredits: async (...args) => { calls.reserved.push(args); return { created: true }; },
    settleCredits: async (...args) => { calls.settled.push(args); },
    refundCredits: async (...args) => { calls.refunded.push(args); },
    markCreditProviderTask: async (...args) => { calls.marked.push(args); },
  }],
  ["studio-mp3", { inspectMp3: async () => ({ duration: 2.5, sampleRate: 24000, channels: 1 }) }],
  ["studio-saydi", {
    SaydiApiError, listSaydiSamples: async () => [{ voice_id: "vi-adam", display_name: "Adam", language: "vi" }],
    getSaydiVoice: async (_key, id) => ({ id, status: "ready" }),
    synthesizeSaydi: async (...args) => speak(...args), cloneSaydi: async (...args) => clone(...args),
    previewSaydiVoice: async () => ({ audio: new Uint8Array([1]), mime: "audio/wav" }),
    deleteSaydiVoice: async () => {},
  }],
  ["studio-server", {
    authorizedVoiceRows: async () => [], getMember: async () => ({ role: "member", enabled: true }),
    saveAuthorizedVoice: async (...args) => { calls.grants.push(args); }, sharedVoiceCatalog: async () => [],
  }],
  ["studio-supabase", {
    storeNarration: async (...args) => { calls.stored.push(args); return { audioPath: `${userId}/narration/one.mp3`, audioUrl: "/signed" }; },
    createStudioSupabaseServer: async () => { throw new Error("No ledger query expected"); },
  }],
  ["library-audio", { registerLibraryAudio: async () => {} }],
]);
const context = vm.createContext({ console, crypto, Uint8Array, ArrayBuffer, Blob, File, TextEncoder, Date });
const source = path.join(root, "lib/studio-saydi-service.ts");
const code = ts.transpileModule(await fs.readFile(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = new vm.SourceTextModule(code, { context, identifier: source });
await module.link(async specifier => {
  const name = specifier === "server-only" ? "server-only" : path.basename(specifier);
  const values = mocks.get(name) || {};
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const service = module.namespace;
const reset = () => { for (const list of Object.values(calls)) list.length = 0; };

reset();
const spoken = await service.generateSaydiVoiceOver({ key: "sv_live_test", userId, requestId: "request-1",
  voiceId: "vi-adam", text: "x".repeat(101), speed: 1 });
assert.equal(spoken.audioPath, `${userId}/narration/one.mp3`);
assert.equal(spoken.usage.chars, 100);
assert.equal(calls.reserved[0][3], 2, "reserve using the input before calling SaydiVoice");
assert.equal(calls.settled[0][2], 1, "settle app credits from X-OV-Chars separately from provider usage");
assert.equal(calls.settled[0][3].chars, 100);
assert.equal(calls.refunded.length, 0);
console.log("PASS TTS stores audio and settles app credits using provider character usage");

reset();
speak = async () => { throw new SaydiApiError("SAYDI_RATE_LIMIT", "wait", 429); };
await assert.rejects(service.generateSaydiVoiceOver({ key: "sv_live_test", userId, requestId: "request-2",
  voiceId: "vi-adam", text: "hello" }), error => error.code === "SAYDI_RATE_LIMIT");
assert.equal(calls.refunded.length, 1);
assert.equal(calls.stored.length, 0);
console.log("PASS a definite 429 rejection returns reserved app credits");

reset();
speak = async () => { throw new StudioError("SAYDI_UNAVAILABLE", "unknown delivery", 502); };
await assert.rejects(service.generateSaydiVoiceOver({ key: "sv_live_test", userId, requestId: "request-3",
  voiceId: "vi-adam", text: "hello" }), error => error.code === "SAYDI_UNAVAILABLE");
assert.equal(calls.refunded.length, 0, "uncertain delivery must remain reserved for reconciliation");
console.log("PASS an ambiguous connection failure does not refund or resubmit a paid request");

reset();
const file = new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" });
clone = async () => ({ id: "vc_owned", status: "processing" });
const pending = await service.createSaydiClone({ key: "sv_live_test", userId, requestId: "request-4", name: "Mine", file });
assert.equal(pending.status, "processing");
assert.equal(calls.marked[0][2], "vc_owned");
assert.equal(calls.settled.length, 0, "clone is charged only when ready");
assert.equal(calls.refunded.length, 0);
console.log("PASS a processing clone remains reserved with its provider voice ID");
