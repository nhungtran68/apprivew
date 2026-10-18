import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parseBuffer } from "music-metadata";

// Synthetic MPEG frame fixtures contain no person's voice. The real recovered
// provider file is checked separately against FFprobe, never committed here.
const context = vm.createContext({ Uint8Array, DataView, ArrayBuffer, console });
const modules = new Map();
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  const source = await fs.readFile(file, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = new vm.SourceTextModule(code, { context, identifier: file });
  modules.set(file, module);
  return module;
}
const entry = await load(path.resolve("lib/studio-mp3.ts"));
await entry.link(async (specifier, parent) => {
  if (specifier === "music-metadata") return new vm.SyntheticModule(["parseBuffer"], function () { this.setExport("parseBuffer", parseBuffer); }, { context });
  return load(`${path.resolve(path.dirname(parent.identifier), specifier)}.ts`);
});
await entry.evaluate();
const { inspectMp3 } = entry.namespace;

function mp3({ version = 2, mono = true, count = 20, vbr = false, padding = false, tag = false, trailer = false, xingFrames } = {}) {
  const frames = [];
  const sampleRate = version === 1 ? 44100 : version === 2 ? 24000 : 12000;
  const samples = version === 1 ? 1152 : 576;
  for (let index = 0; index < count; index++) {
    const bitrate = vbr && index % 2 ? 64 : 128;
    const bitrateIndex = version === 1 ? (bitrate === 128 ? 9 : 5) : (bitrate === 128 ? 12 : 8);
    const pad = padding && index % 2 ? 1 : 0;
    const length = Math.floor((version === 1 ? 144000 : 72000) * bitrate / sampleRate) + pad;
    const bytes = new Uint8Array(length);
    bytes.set([0xff, version === 1 ? 0xfb : version === 2 ? 0xf3 : 0xe3, bitrateIndex << 4 | (version === 1 ? 0 : 4) | pad << 1, mono ? 0xc0 : 0]);
    if (index === 0 && xingFrames !== undefined) {
      const start = 4 + (version === 1 ? mono ? 17 : 32 : mono ? 9 : 17);
      bytes.set(new TextEncoder().encode("Xing"), start);
      const view = new DataView(bytes.buffer);
      view.setUint32(start + 4, 3); view.setUint32(start + 8, xingFrames); view.setUint32(start + 12, length * count);
    }
    frames.push(bytes);
  }
  const head = tag ? Uint8Array.of(73, 68, 51, 4, 0, 0, 0, 0, 0, 16, ...new Uint8Array(16)) : new Uint8Array();
  const tail = trailer ? new Uint8Array(128) : new Uint8Array();
  if (trailer) tail.set([84, 65, 71]);
  const bytes = new Uint8Array(head.length + frames.reduce((sum, frame) => sum + frame.length, 0) + tail.length);
  bytes.set(head); let offset = head.length;
  for (const frame of frames) { bytes.set(frame, offset); offset += frame.length; }
  bytes.set(tail, offset);
  return { bytes, duration: count * samples / sampleRate, sampleRate, channels: mono ? 1 : 2, firstFrameLength: frames[0].length, headLength: head.length };
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const invalid = bytes => assert.rejects(inspectMp3(bytes), error => error.code === "INVALID_AUDIO" && error.status === 422);

await check("MPEG2 mono duration matches the provider's CBR frame format", async () => {
  const fixture = mp3({ count: 232 });
  const result = await inspectMp3(fixture.bytes);
  assert.equal(result.duration, 5.568); assert.equal(result.sampleRate, 24000); assert.equal(result.channels, 1);
});

await check("MPEG1 stereo padding and MPEG2.5 sample rates are supported", async () => {
  for (const options of [{ version: 1, mono: false, padding: true }, { version: 2.5 }]) {
    const fixture = mp3(options), result = await inspectMp3(fixture.bytes);
    assert.ok(Math.abs(result.duration - fixture.duration) < 0.000001);
    assert.equal(result.sampleRate, fixture.sampleRate); assert.equal(result.channels, fixture.channels);
  }
});

await check("VBR duration is scanned by the pinned metadata library", async () => {
  const fixture = mp3({ vbr: true, count: 30 });
  const result = await inspectMp3(fixture.bytes);
  assert.ok(Math.abs(result.duration - fixture.duration) < 0.000001);
});

await check("ID3v2 padding and ID3v1 trailers do not extend audio duration", async () => {
  const fixture = mp3({ tag: true, trailer: true });
  const result = await inspectMp3(fixture.bytes);
  assert.equal(result.duration, fixture.duration);
});

await check("ID3v2.4 footer lengths and mirrored fields are validated", async () => {
  const fixture = mp3(), bytes = new Uint8Array(20 + fixture.bytes.length);
  bytes.set([73, 68, 51, 4, 0, 16, 0, 0, 0, 0, 51, 68, 73, 4, 0, 16, 0, 0, 0, 0]);
  bytes.set(fixture.bytes, 20);
  assert.equal((await inspectMp3(bytes)).duration, fixture.duration);
  bytes[10] = 0; await invalid(bytes);
  bytes[10] = 51; bytes[19] = 1; await invalid(bytes);
});

await check("a truncated final frame cannot retain a complete file's duration", async () => {
  const fixture = mp3({ tag: true, xingFrames: 20 });
  await invalid(fixture.bytes.subarray(0, fixture.bytes.length - 1));
  await invalid(fixture.bytes.subarray(0, fixture.bytes.length - 100));
});

await check("a forged Xing duration cannot make a long stream appear short", async () => {
  await invalid(mp3({ count: 100, xingFrames: 2 }).bytes);
  await invalid(mp3({ count: 20, xingFrames: 10000 }).bytes);
});

await check("corrupted frame boundaries and inconsistent stream formats are rejected", async () => {
  for (const mutate of [
    (bytes, fixture) => { bytes[fixture.firstFrameLength] = 0; },
    (bytes, fixture) => { bytes[fixture.firstFrameLength + 2] |= 0x0c; },
    (bytes, fixture) => { bytes[fixture.firstFrameLength + 3] = 0; },
    (bytes, fixture) => { bytes[fixture.firstFrameLength + 1] = 0xfb; },
    bytes => { bytes[1] = 0xf5; }, // Layer II is not MP3.
    bytes => { bytes[2] = 0; }, // Free bitrate cannot establish boundaries.
  ]) { const fixture = mp3(); mutate(fixture.bytes, fixture); await invalid(fixture.bytes); }
});

await check("non-MP3 responses, malformed tags and arbitrary suffixes are rejected", async () => {
  await invalid(new TextEncoder().encode("<!doctype html><html>provider error</html>"));
  await invalid(new Uint8Array(44));
  await invalid(mp3({ count: 2 }).bytes);
  for (const mutate of [bytes => { bytes[3] = 5; }, bytes => { bytes[6] = 0x80; }, bytes => { bytes[9] = 127; }, bytes => { bytes[5] = 1; }]) {
    const fixture = mp3({ tag: true }); mutate(fixture.bytes); await invalid(fixture.bytes);
  }
  const fixture = mp3(), suffix = new Uint8Array(fixture.bytes.length + 1); suffix.set(fixture.bytes); await invalid(suffix);
});

await check("oversized or excessive-duration audio stays bounded", async () => {
  await invalid(new Uint8Array(12 * 1024 * 1024 + 1));
  await invalid(mp3({ count: 7501 }).bytes);
});

console.log(`${passed} isolated MP3 validation tests passed.`);
if (process.argv[2]) console.log(`Actual audio: ${JSON.stringify(await inspectMp3(await fs.readFile(process.argv[2])))}`);
