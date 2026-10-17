// Offline tests of the actual browser upload helper; no network or real accounts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const alice = "11111111-1111-4111-8111-111111111111", bob = "22222222-2222-4222-8222-222222222222";
const origin = "https://offline.supabase.invalid", bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const paths = ["first", "second", "third"].map(name => `${alice}/narration/${name}.wav`);
let state;
function reset() {
  state = { userId: alice, authError: null, authThrows: false, removeError: null, removeThrows: false, removals: [], fetches: [], fetch: async () => new Response(bytes, { headers: { "content-type": "audio/wav" } }), audioDuration: 6, decodeFails: false, contextClosed: 0, renderRequests: [] };
}
reset();
const client = {
  auth: { async getUser() {
    if (state.authThrows) throw new Error("private-auth-detail");
    return { data: { user: state.userId ? { id: state.userId } : null }, error: state.authError };
  } },
  storage: { from(bucket) {
    assert.equal(bucket, "studio-media");
    return { async remove(removed) {
      state.removals.push([...removed]);
      if (state.removeThrows) throw new Error("private-storage-detail");
      return { data: [], error: state.removeError };
    } };
  } },
};
class TestFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onload?.();
    }, () => this.onerror?.());
  }
}
// Browser decoding/resampling is a platform API; capture its requested channel,
// frame and rate settings, then verify the real helper's WAV with the server parser.
class TestAudioContext {
  async decodeAudioData() {
    if (state.decodeFails) throw new Error("private-decoder-detail");
    return { duration: state.audioDuration };
  }
  async close() { state.contextClosed++; }
}
class TestOfflineAudioContext {
  constructor(channels, frames, sampleRate) {
    this.frames = frames; this.destination = {};
    state.renderRequests.push({ channels, frames, sampleRate });
  }
  createBufferSource() {
    const source = { buffer: null, connect: destination => assert.equal(destination, this.destination), start: () => assert.equal(source.buffer.duration, state.audioDuration) };
    return source;
  }
  async startRendering() {
    const samples = new Float32Array(this.frames);
    samples.set([-2, -0.5, 0, 0.5, 2]);
    return { getChannelData: channel => { assert.equal(channel, 0); return samples; } };
  }
}
const source = readFileSync(new URL("../lib/studio-upload.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const evaluated = { exports: {} };
new Function("require", "module", "exports", "process", "fetch", "FileReader", "window", "OfflineAudioContext", compiled)(
  name => { assert.equal(name, "./studio-browser"); return { createStudioBrowser: () => client }; },
  evaluated, evaluated.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: origin } },
  async (url, options) => { state.fetches.push({ url, options }); return state.fetch(url, options); }, TestFileReader, { AudioContext: TestAudioContext }, TestOfflineAudioContext,
);
const { cleanupAnalysisMedia, downloadSpeechSegments, prepareMaziaoVoiceSample } = evaluated.exports;
const contractModule = { exports: {} }, wavModule = { exports: {} };
const compile = input => ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function("module", "exports", compile(readFileSync(new URL("../lib/studio-contract.ts", import.meta.url), "utf8")))(contractModule, contractModule.exports);
new Function("require", "module", "exports", compile(readFileSync(new URL("../lib/studio-wav.ts", import.meta.url), "utf8")))(name => { assert.equal(name, "./studio-contract"); return contractModule.exports; }, wavModule, wavModule.exports);
const segment = (path, index = 0) => ({ start: index * 2, end: index * 2 + 2, text: `Offline segment ${index}`, audioPath: path, audioUrl: `${origin}/storage/v1/object/sign/studio-media/${path}?token=offline`, audioMime: "audio/wav", duration: 1 });
let passed = 0;
async function check(name, test) { reset(); await test(); passed++; console.log(`PASS ${name}`); }

await check("failed first HTTP or network download still attempts removal of every owned segment", async () => {
  for (const fail of [async () => new Response("offline failure", { status: 503 }), async () => { throw new Error("offline network failure"); }]) {
    reset(); state.fetch = fail;
    await assert.rejects(downloadSpeechSegments(paths.map(segment)));
    assert.equal(state.fetches.length, 1, "later segments should not be downloaded after the first failure");
    assert.deepEqual(state.removals, [paths], "the failed and not-yet-downloaded objects must all be cleaned");
  }
});

await check("cleanup never removes foreign paths and signed downloads must match the current owner and app origin", async () => {
  const foreign = `${bob}/narration/foreign.wav`;
  await cleanupAnalysisMedia({ samplePaths: [paths[0], foreign, `${alice}/../foreign.wav`, paths[0]] });
  assert.deepEqual(state.removals, [[paths[0]]], "cleanup filters foreign/traversal paths and deduplicates own paths");
  for (const invalid of [
    segment(foreign),
    { ...segment(paths[0]), audioUrl: `https://untrusted.example.invalid/storage/v1/object/sign/studio-media/${paths[0]}` },
    { ...segment(paths[0]), audioUrl: `${origin}/storage/v1/object/sign/studio-media/${foreign}?token=offline` },
  ]) {
    reset();
    await assert.rejects(downloadSpeechSegments([invalid, segment(paths[1], 1)]));
    assert.equal(state.fetches.length, 0, "invalid/foreign signed paths must be rejected before any download");
    assert.ok(state.removals.flat().every(path => path.startsWith(`${alice}/`) && !path.includes("..")));
    assert.ok(state.removals.flat().includes(paths[1]), "valid later owned objects still need cleanup");
  }
});

await check("explicit cleanup reports auth/storage failures safely while paid downloaded audio survives cleanup failure", async () => {
  for (const failure of ["authError", "authThrows", "noUser", "removeError", "removeThrows"]) {
    reset();
    if (failure === "noUser") state.userId = null;
    else state[failure] = failure.endsWith("Throws") ? true : { message: `private-${failure}-detail` };
    await assert.rejects(cleanupAnalysisMedia([paths[0]]), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-"), "SDK error details must not reach the user");
      assert.ok(error.message.length > 20, "cleanup must report a meaningful safe error");
      return true;
    });
  }
  reset(); state.removeError = { message: "private-storage-detail" };
  const downloaded = await downloadSpeechSegments([segment(paths[0])]);
  assert.equal(downloaded[0].audioBase64, Buffer.from(bytes).toString("base64"));
  assert.deepEqual(state.removals, [[paths[0]]], "best-effort cleanup must still be attempted");
});

await check("successful downloads return exact base64 without signed URLs and remove all temporary objects", async () => {
  const downloaded = await downloadSpeechSegments(paths.map(segment));
  assert.equal(downloaded.length, paths.length);
  for (const [index, audio] of downloaded.entries()) {
    assert.equal(audio.audioBase64, Buffer.from(bytes).toString("base64"));
    assert.equal(audio.mimeType, "audio/wav");
    assert.equal(audio.text, `Offline segment ${index}`);
    assert.equal(audio.audioUrl, undefined); assert.equal(audio.audioPath, undefined);
  }
  assert.deepEqual(state.removals, [paths]);
  assert.equal(state.fetches.length, paths.length);
  for (const request of state.fetches) {
    assert.equal(new URL(request.url).origin, origin);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error", "redirects cannot escape the approved storage origin");
  }
});

await check("Maziao samples become server-readable mono 24 kHz PCM WAV and long recordings stop at eight seconds", async () => {
  for (const duration of [3, 6.25, 12]) {
    reset(); state.audioDuration = duration;
    const prepared = await prepareMaziaoVoiceSample(new File(["offline browser audio fixture"], "voice.m4a", { type: "audio/mp4" }));
    const wav = new Uint8Array(await prepared.arrayBuffer()), format = wavModule.exports.inspectWav(wav);
    assert.equal(prepared.name, "voice-sample.wav"); assert.equal(prepared.type, "audio/wav");
    assert.deepEqual(state.renderRequests, [{ channels: 1, frames: Math.min(8, duration) * 24000, sampleRate: 24000 }]);
    assert.equal(format.duration, Math.min(8, duration)); assert.equal(format.sampleRate, 24000);
    assert.equal(format.channels, 1); assert.equal(format.encoding, 1); assert.equal(format.bits, 16);
    const pcm = new DataView(wav.buffer, wav.byteOffset + 44);
    assert.deepEqual(Array.from({ length: 5 }, (_, index) => pcm.getInt16(index * 2, true)), [-32768, -16384, 0, 16383, 32767], "normalization preserves sample signs and clips safely to PCM limits");
    assert.equal(state.contextClosed, 1); assert.equal(state.fetches.length, 0);
  }
});

await check("short or unreadable Maziao samples close the browser decoder before any network or upload", async () => {
  for (const failure of ["short", "decode"]) {
    reset();
    if (failure === "short") state.audioDuration = 2.99;
    else state.decodeFails = true;
    await assert.rejects(prepareMaziaoVoiceSample(new File(["offline"], "voice.mp3", { type: "audio/mpeg" })), error => {
      assert.ok(!error.message.includes("private-decoder-detail"));
      assert.match(error.message, failure === "short" ? /ít nhất 3 giây/ : /Chưa đọc được/);
      return true;
    });
    assert.equal(state.contextClosed, 1); assert.deepEqual(state.renderRequests, []); assert.equal(state.fetches.length, 0);
  }
});
console.log(`${passed} offline upload/download cleanup tests passed.`);
