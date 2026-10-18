// Offline tests of the actual browser upload helper; no network or real accounts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const alice = "11111111-1111-4111-8111-111111111111", bob = "22222222-2222-4222-8222-222222222222";
const origin = "https://offline.supabase.invalid", bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const paths = ["first", "second", "third"].map(name => `${alice}/narration/${name}.wav`);
let state;
function reset() {
  state = { userId: alice, authError: null, authThrows: false, removeError: null, removeThrows: false, removals: [], signError: null, signThrows: false, signResult: undefined, signings: [], fetches: [], fetch: async () => new Response(bytes, { headers: { "content-type": "audio/wav" } }), audioDuration: 6, decodeFails: false, contextClosed: 0, renderRequests: [] };
}
reset();
const client = {
  auth: { async getUser() {
    if (state.authThrows) throw new Error("private-auth-detail");
    return { data: { user: state.userId ? { id: state.userId } : null }, error: state.authError };
  } },
  storage: { from(bucket) {
    assert.equal(bucket, "studio-media");
    return {
      async remove(removed) {
        state.removals.push([...removed]);
        if (state.removeThrows) throw new Error("private-storage-detail");
        return { data: [], error: state.removeError };
      },
      async createSignedUrl(path, expiresIn) {
        state.signings.push({ path, expiresIn });
        if (state.signThrows) throw new Error("private-signing-detail");
        if (state.signResult !== undefined) return state.signResult;
        return { data: { signedUrl: `${origin}/storage/v1/object/sign/studio-media/${path}?token=fresh-${state.signings.length}` }, error: state.signError };
      },
    };
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

await check("first or middle download interruptions preserve every paid object and recovery reference", async () => {
  for (const failedIndex of [0, 1]) {
    for (const fail of [async () => new Response("offline failure", { status: 503 }), async () => { throw new Error("private-network-detail"); }]) {
      reset();
      state.fetch = async () => state.fetches.length === failedIndex + 1 ? fail() : new Response(bytes);
      const input = paths.map(segment), original = structuredClone(input);
      await assert.rejects(downloadSpeechSegments(input), error => {
        assert.match(error.message, /Tải lại lời đọc/);
        assert.ok(!error.message.includes("private-"));
        return true;
      });
      assert.equal(state.fetches.length, failedIndex + 1, "downloads stop at the first failure");
      assert.deepEqual(state.removals, [], "no paid object may be deleted after an interrupted delivery");
      assert.deepEqual(state.signings, [], "supplied valid URLs do not need signing");
      assert.deepEqual(input, original, "the caller's saved recovery references remain intact");
    }
  }
});

await check("path-only retry signs fresh owner-scoped URLs and returns exact MP3 bytes without generating speech", async () => {
  const mp3Bytes = new Uint8Array([255, 243, 132, 0, 3, 2, 1]);
  const input = paths.map((path, index) => ({ ...segment(path.replace(/\.wav$/, ".mp3"), index), audioMime: "audio/mpeg" }));
  state.fetch = async () => state.fetches.length === 2 ? new Response("interrupted", { status: 503 }) : new Response(mp3Bytes);
  await assert.rejects(downloadSpeechSegments(input));
  assert.deepEqual(state.removals, []);
  const recovered = input.map(({ audioUrl, ...rest }) => rest);
  const previousFetches = state.fetches.length;
  state.fetch = async () => new Response(mp3Bytes, { headers: { "content-type": "audio/mpeg" } });
  const downloaded = await downloadSpeechSegments(recovered);
  assert.deepEqual(state.signings, recovered.map(audio => ({ path: audio.audioPath, expiresIn: 300 })));
  assert.equal(state.fetches.length - previousFetches, recovered.length);
  assert.deepEqual(state.removals, [], "success still waits for the caller to persist bytes before cleanup");
  for (const [index, audio] of downloaded.entries()) {
    assert.equal(audio.audioBase64, Buffer.from(mp3Bytes).toString("base64"));
    assert.equal(audio.mimeType, "audio/mpeg"); assert.equal(audio.audioMime, "audio/mpeg");
    assert.equal(audio.start, input[index].start); assert.equal(audio.end, input[index].end); assert.equal(audio.duration, input[index].duration);
    assert.equal(audio.audioPath, undefined); assert.equal(audio.audioUrl, undefined);
  }
  for (const request of state.fetches) {
    const url = new URL(request.url);
    assert.equal(url.origin, origin, "the retry only uses the existing private Storage objects");
    assert.ok(url.pathname.startsWith(`/storage/v1/object/sign/studio-media/${alice}/narration/`));
    assert.ok(!request.options.method || request.options.method === "GET", "no TTS/provider submission is made");
  }
  assert.ok(state.fetches.slice(previousFetches).every(request => new URL(request.url).searchParams.get("token").startsWith("fresh-")));
  assert.ok(recovered.every(audio => audio.audioUrl === undefined), "fresh signed URLs are never written back to the saved references");
});

await check("all owned paths and supplied signed URLs are validated before any signing or download", async () => {
  const foreign = `${bob}/narration/foreign.wav`;
  for (const invalid of [
    segment(foreign),
    { ...segment(foreign), audioUrl: undefined },
    { ...segment(`${alice}/../foreign.wav`), audioUrl: undefined },
    { ...segment(paths[0]), audioPath: undefined, audioUrl: undefined },
    { ...segment(paths[0]), audioUrl: `https://untrusted.example.invalid/storage/v1/object/sign/studio-media/${paths[0]}` },
    { ...segment(paths[0]), audioUrl: `${origin}/storage/v1/object/sign/studio-media/${foreign}?token=offline` },
    { ...segment(paths[0]), audioUrl: `${origin}/storage/v1/object/sign/studio-media/${paths[0]}#unexpected-fragment` },
    { ...segment(paths[0]), audioUrl: `${origin.replace("https://", "https://name:password@")}/storage/v1/object/sign/studio-media/${paths[0]}` },
    { ...segment(paths[0]), audioUrl: "" },
  ]) {
    reset();
    await assert.rejects(downloadSpeechSegments([{ ...segment(paths[1], 1), audioUrl: undefined }, invalid]));
    assert.equal(state.fetches.length, 0, "invalid/foreign signed paths must be rejected before any download");
    assert.deepEqual(state.signings, [], "even an earlier valid path must not be signed before validation finishes");
    assert.deepEqual(state.removals, [], "validation failure is never permission to delete paid files");
  }
});

await check("signing failures and untrusted signing results keep paid objects and hide SDK details", async () => {
  for (const failure of ["signError", "signThrows", "missingUrl", "foreignOrigin", "foreignPath"]) {
    reset();
    if (failure === "signError") state.signError = { message: "private-signing-detail" };
    if (failure === "signThrows") state.signThrows = true;
    if (failure === "missingUrl") state.signResult = { data: {}, error: null };
    if (failure === "foreignOrigin") state.signResult = { data: { signedUrl: `https://untrusted.invalid/storage/v1/object/sign/studio-media/${paths[0]}?token=private-token` }, error: null };
    if (failure === "foreignPath") state.signResult = { data: { signedUrl: `${origin}/storage/v1/object/sign/studio-media/${bob}/narration/voice.wav?token=private-token` }, error: null };
    await assert.rejects(downloadSpeechSegments([{ ...segment(paths[0]), audioUrl: undefined }]), error => {
      assert.ok(error.message.length > 20);
      assert.ok(!error.message.includes("private-") && !error.message.includes("token="));
      return true;
    });
    assert.equal(state.signings.length, 1); assert.deepEqual(state.fetches, []); assert.deepEqual(state.removals, []);
  }
});

await check("path-only recovery requires a currently authenticated owner before signing or fetching", async () => {
  for (const failure of ["authError", "authThrows", "noUser"]) {
    reset();
    if (failure === "noUser") state.userId = null;
    else state[failure] = failure.endsWith("Throws") ? true : { message: `private-${failure}-detail` };
    await assert.rejects(downloadSpeechSegments([{ ...segment(paths[0]), audioUrl: undefined }]), error => !error.message.includes("private-"));
    assert.deepEqual(state.signings, []); assert.deepEqual(state.fetches, []); assert.deepEqual(state.removals, []);
  }
});

await check("explicit cleanup filters foreign paths and reports auth/storage failures safely", async () => {
  const foreign = `${bob}/narration/foreign.wav`;
  await cleanupAnalysisMedia({ samplePaths: [paths[0], foreign, `${alice}/../foreign.wav`, paths[0]] });
  assert.deepEqual(state.removals, [[paths[0]]], "cleanup filters foreign/traversal paths and deduplicates own paths");
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
});

await check("successful downloads strip cloud references and wait for explicit cleanup after local persistence", async () => {
  const downloaded = await downloadSpeechSegments(paths.map(segment));
  assert.equal(downloaded.length, paths.length);
  for (const [index, audio] of downloaded.entries()) {
    assert.equal(audio.audioBase64, Buffer.from(bytes).toString("base64"));
    assert.equal(audio.mimeType, "audio/wav");
    assert.equal(audio.text, `Offline segment ${index}`);
    assert.equal(audio.audioUrl, undefined); assert.equal(audio.audioPath, undefined);
  }
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.signings, []);
  assert.equal(state.fetches.length, paths.length);
  for (const request of state.fetches) {
    assert.equal(new URL(request.url).origin, origin);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error", "redirects cannot escape the approved storage origin");
  }
  // The caller has now persisted these returned bytes; cleanup is a separate act.
  await cleanupAnalysisMedia(paths);
  assert.deepEqual(state.removals, [paths]);
});

await check("already downloaded audio retries locally, retains MP3 MIME, and drops every private reference", async () => {
  state.userId = null; state.authThrows = true;
  const audioBase64 = Buffer.from(bytes).toString("base64");
  const input = [{ ...segment(paths[0]), audioBase64, audioMime: "audio/mpeg" }, { ...segment(paths[1], 1), audioBase64, audioMime: undefined, mimeType: "audio/mpeg" }];
  const downloaded = await downloadSpeechSegments(input);
  for (const audio of downloaded) {
    assert.equal(audio.audioBase64, audioBase64); assert.equal(audio.mimeType, "audio/mpeg");
    assert.equal(audio.audioUrl, undefined); assert.equal(audio.audioPath, undefined);
  }
  assert.deepEqual(state.fetches, []); assert.deepEqual(state.signings, []); assert.deepEqual(state.removals, []);
  assert.equal(input[0].audioPath, paths[0], "the caller still knows what to clean after a durable save");
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
