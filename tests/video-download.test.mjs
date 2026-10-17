import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/video-download.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function helpers(window, navigator = {}) {
  const module = { exports: {} };
  new Function("module", "exports", "window", "navigator", "Blob", "File", compiled)(module, module.exports, window, navigator, Blob, File);
  return module.exports;
}
const mp4 = new Blob([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109])], { type: "video/mp4" });

test("video names preserve Vietnamese while removing path characters and reserved file names", () => {
  const { videoDownloadName } = helpers();
  assert.equal(videoDownloadName('  Vườn nho: "Mùa mới"/2026?.mp4 '), "Vườn nho Mùa mới 2026.mp4");
  assert.equal(videoDownloadName("CON"), "loi-ke.mp4");
  assert.equal(videoDownloadName("../\\"), "loi-ke.mp4");
  assert.equal(videoDownloadName(""), "loi-ke.mp4");
  assert.ok(videoDownloadName("a".repeat(200)).length <= 104);
});

test("native save picker is invoked immediately in the original click and writes the actual MP4", async () => {
  const calls = [];
  const { saveVideoFile } = helpers({ isSecureContext: true, showSaveFilePicker(options) {
    calls.push(["picker", options]);
    return Promise.resolve({ async createWritable() { return { async write(blob) { calls.push(["write", blob]); }, async close() { calls.push(["close"]); } }; } });
  } });
  const result = saveVideoFile(mp4, "Vườn nho");
  assert.equal(calls[0][0], "picker", "Do not await media reads or module imports before opening the picker.");
  assert.equal(await result, "saved");
  assert.equal(calls[0][1].suggestedName, "Vườn nho.mp4");
  assert.deepEqual(calls[0][1].types[0].accept, { "video/mp4": [".mp4"] });
  assert.equal(calls[1][1], mp4);
  assert.equal(calls[2][0], "close");
});

test("cancelling native save does not trigger an unexpected browser download", async () => {
  const { saveVideoFile } = helpers({ isSecureContext: true, showSaveFilePicker() { return Promise.reject(new DOMException("Cancelled", "AbortError")); } });
  assert.equal(await saveVideoFile(mp4, "Test"), "cancelled");
});

test("partial disk-write failure aborts the writable and offers the persistent download fallback", async () => {
  let aborted = false;
  const { saveVideoFile } = helpers({ isSecureContext: true, async showSaveFilePicker() { return { async createWritable() { return {
    async write() { throw new Error("disk full"); }, async close() { assert.fail("Do not close failed writes."); }, async abort() { aborted = true; },
  }; } }; } });
  await assert.rejects(saveVideoFile(mp4, "Test"), /Tải trực tiếp/);
  assert.equal(aborted, true);
});

test("browsers without the save API keep a direct download available", async () => {
  assert.equal(await helpers({ isSecureContext: true }).saveVideoFile(mp4, "Test"), "unsupported");
  assert.equal(await helpers().saveVideoFile(mp4, "Test"), "unsupported");
  let called = false;
  assert.equal(await helpers({ isSecureContext: false, showSaveFilePicker() { called = true; } }).saveVideoFile(mp4, "Test"), "unsupported");
  assert.equal(called, false);
});

test("empty or non-MP4 files are rejected before a save dialog opens", async () => {
  let called = false;
  const { saveVideoFile } = helpers({ isSecureContext: true, showSaveFilePicker() { called = true; } });
  await assert.rejects(saveVideoFile(new Blob([], { type: "video/mp4" }), "Test"), /chưa sẵn sàng/);
  await assert.rejects(saveVideoFile(new Blob(["wrong"], { type: "text/html" }), "Test"), /chưa sẵn sàng/);
  assert.equal(called, false);
});

test("mobile share passes the real MP4 file, with no invalid blob URL", async () => {
  let shared;
  const { canShareVideoFile, shareVideoFile } = helpers({}, { canShare: ({ files }) => files[0].type === "video/mp4", share(data) { shared = data; return Promise.resolve(); } });
  assert.equal(canShareVideoFile(mp4, "Vườn nho"), true);
  const result = shareVideoFile(mp4, "Vườn nho");
  assert.ok(shared.files[0] instanceof File, "Sharing must start directly during the click.");
  assert.equal(await result, "shared");
  assert.equal(shared.files[0].name, "Vườn nho.mp4");
  assert.equal(shared.url, undefined);
  assert.deepEqual(new Uint8Array(await shared.files[0].arrayBuffer()), new Uint8Array(await mp4.arrayBuffer()));
});

test("sharing capability, cancellation, and failure do not claim a file was saved", async () => {
  assert.equal(await helpers({}, {}).shareVideoFile(mp4, "Test"), "unsupported");
  assert.equal(helpers({}, { canShare() { throw new Error("blocked"); }, share() {} }).canShareVideoFile(mp4), false);
  const available = { canShare: () => true };
  assert.equal(await helpers({}, { ...available, share: () => Promise.reject(new DOMException("Cancelled", "AbortError")) }).shareVideoFile(mp4, "Test"), "cancelled");
  await assert.rejects(helpers({}, { ...available, share: () => Promise.reject(new Error("blocked")) }).shareVideoFile(mp4, "Test"), /tải tệp MP4/);
});
