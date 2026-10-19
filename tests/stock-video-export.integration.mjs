import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const project = process.cwd();
const require = createRequire(join(project, "package.json"));
globalThis.self = { location: { href: "file:///stock-video-test.js" } };
const coreFile = require.resolve("@ffmpeg/core").replace(/[/\\]umd[/\\]/, "/esm/");
const { default: createCore } = await import(pathToFileURL(coreFile).href);
const wasm = await readFile(join(project, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"));
const core = await createCore({ wasmBinary: wasm });
const logs = [];
core.setLogger(({ message }) => logs.push(message));

function execute(args) {
  core.exec(...args);
  const result = core.ret;
  core.reset();
  assert.equal(result, 0, logs.slice(-15).join("\n"));
}

execute(["-f", "lavfi", "-i", "color=c=red:size=160x90:rate=30:duration=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "red.mp4"]);
execute(["-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=30:duration=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "blue.mp4"]);
execute(["-f", "lavfi", "-i", "color=c=green:size=160x90:rate=30:duration=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "long.mp4"]);
const clip = (file) => new Blob([new Uint8Array(core.FS.readFile(file))], { type: "video/mp4" });

const nativeFetch = globalThis.fetch;
globalThis.window = { location: { origin: "http://stock-video.test" } };
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith("/ffmpeg/")) {
    const data = await readFile(join(project, "public", String(input)));
    return new Response(data, { headers: { "Content-Type": String(input).endsWith("json") ? "application/json" : "application/octet-stream" } });
  }
  return nativeFetch(input, init);
};
globalThis.__FFmpegAdapter = class {
  callbacks = { log: [], progress: [] };
  on(type, callback) { this.callbacks[type].push(callback); }
  off(type, callback) { this.callbacks[type] = this.callbacks[type].filter((item) => item !== callback); }
  async load(config) {
    const supplied = new Uint8Array(await (await nativeFetch(config.wasmURL)).arrayBuffer());
    assert.equal(Buffer.compare(supplied, wasm), 0);
    core.setLogger((event) => { logs.push(event.message); this.callbacks.log.forEach((callback) => callback(event)); });
    core.setProgress((event) => this.callbacks.progress.forEach((callback) => callback(event)));
    return true;
  }
  async writeFile(path, data) { core.FS.writeFile(path, data); }
  async readFile(path, encoding = "binary") { return core.FS.readFile(path, { encoding }); }
  async ffprobe(args) { core.ffprobe(...args); const code = core.ret; core.reset(); return code; }
  async exec(args) { core.exec(...args); const code = core.ret; core.reset(); return code; }
  terminate() { core.setLogger(() => {}); core.setProgress(() => {}); }
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "http://stock-video.test/ffmpeg/ffmpeg/index.js") {
    return { url: "data:text/javascript,export const FFmpeg = globalThis.__FFmpegAdapter", shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { exportStockVideo, planStockTimeline } = await import(pathToFileURL(join(project, "lib/video-export.ts")).href);

function tone(seconds) {
  const samples = Math.round(seconds * 48000);
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / 48000) * 8000), 44 + index * 2);
  return new Blob([data], { type: "audio/wav" });
}

function inspect(blob) {
  return blob.arrayBuffer().then((buffer) => {
    core.FS.writeFile("stock-inspect.mp4", new Uint8Array(buffer));
    core.ffprobe("-v", "error", "-show_streams", "-show_format", "-of", "json", "stock-inspect.mp4", "-o", "stock-inspect.json");
    const code = core.ret; core.reset(); assert.ok(code === 0 || code === -1);
    return JSON.parse(core.FS.readFile("stock-inspect.json", { encoding: "utf8" }));
  });
}

assert.deepEqual(planStockTimeline([1], 2).map((scene) => scene.frames), [60]);
assert.equal(planStockTimeline([3], 1)[0].duration, 1);
assert.deepEqual(planStockTimeline([1, 1], 2, [{ clipIndex: 0, duration: 1 }, { clipIndex: 1, duration: 1 }]).map((scene) => scene.frames), [30, 30]);
assert.deepEqual(planStockTimeline([1, 1], 10).map((scene) => scene.clipIndex), [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
assert.deepEqual(planStockTimeline([60, 60], 10).map((scene) => scene.clipIndex), [0, 1]);

for (const test of [
  { name: "shorter-video-loops", video: clip("red.mp4"), audioSeconds: 2 },
  { name: "longer-video-trims", video: clip("long.mp4"), audioSeconds: 1 },
  { name: "matching-duration", video: clip("blue.mp4"), audioSeconds: 1 },
]) {
  const progress = [];
  let output;
  try {
    output = await exportStockVideo({ clips: [test.video], narration: tone(test.audioSeconds), aspectRatio: "1:1", onProgress: (value) => progress.push(value) });
  } catch (error) {
    console.error(test.name, error, logs.slice(-20));
    try { console.error("finished info", core.FS.readFile("finished-stock.mp4.json", { encoding: "utf8" })); } catch { /* no output */ }
    throw error;
  }
  const info = await inspect(output);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264", test.name);
  assert.equal(audio.codec_name, "aac", test.name);
  assert.equal(video.width, 960, test.name);
  assert.equal(video.height, 960, test.name);
  assert.ok(Math.abs(Number(video.duration) - (test.audioSeconds + 0.1)) <= 1 / 30 + 0.002, test.name);
  assert.ok(Number(audio.duration) + 1 / 30 >= test.audioSeconds, test.name);
  assert.equal(progress.at(-1), 1, test.name);
  execute(["-i", "stock-inspect.mp4", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "stock-audio.pcm"]);
  const pcm = core.FS.readFile("stock-audio.pcm");
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const start = Math.floor((test.audioSeconds - 0.1) * 48000);
  const end = Math.floor((test.audioSeconds - 0.02) * 48000);
  let energy = 0;
  for (let sample = start; sample < end; sample++) energy += samples[sample] ** 2;
  assert.ok(Math.sqrt(energy / (end - start)) > 0.05, `Last spoken samples must survive: ${test.name}`);
  if (test.name === "shorter-video-loops") {
    execute(["-ss", "2.05", "-i", "stock-inspect.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "last-pixel.rgb"]);
    const pixel = core.FS.readFile("last-pixel.rgb");
    assert.ok(pixel[0] > pixel[2] + 80, "Repeated video must still contain a visible frame at the end");
  }
  console.log(`${test.name}: ${output.size} bytes, video=${video.duration}s audio=${audio.duration}s`);
}

const scenesOutput = await exportStockVideo({
  clips: [clip("red.mp4"), clip("blue.mp4")], narration: tone(2), aspectRatio: "16:9",
  scenes: [{ clipIndex: 0, duration: 1 }, { clipIndex: 1, duration: 1 }],
});
const scenesInfo = await inspect(scenesOutput);
assert.equal(scenesInfo.streams.find((stream) => stream.codec_type === "video").width, 1280);
for (const [time, expected] of [["0.5", "red"], ["1.5", "blue"]]) {
  execute(["-ss", time, "-i", "stock-inspect.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "scene-pixel.rgb"]);
  const pixel = core.FS.readFile("scene-pixel.rgb");
  if (expected === "red") assert.ok(pixel[0] > pixel[2] + 80, "First scene must show red clip");
  else assert.ok(pixel[2] > pixel[0] + 80, "Second scene must show blue clip");
}
console.log("two-scene export: pass");

const portraitOutput = await exportStockVideo({ clips: [clip("red.mp4")], narration: tone(1), aspectRatio: "9:16" });
const portraitInfo = await inspect(portraitOutput);
const portraitVideo = portraitInfo.streams.find((stream) => stream.codec_type === "video");
assert.equal(portraitVideo.width, 720);
assert.equal(portraitVideo.height, 1280);
console.log("portrait export: pass");
