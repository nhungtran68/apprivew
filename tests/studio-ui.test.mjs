// Run from the repository root: node tests/studio-ui.test.mjs
// This also works with node --test on hosts that permit test-runner child processes.
// The helpers and initial UI are evaluated from the actual component source.
// No network, camera, account, or external provider is used by these tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";

const sourcePath = fileURLToPath(new URL("../components/Studio.tsx", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const exportsForTests = "\nexport {restoreArchive,freshProject,applyProjectChanges,applySegmentChange,scriptKey,intentKey,safeProfile,applySavedProfile,configurationFrom,affectsExport};";
const compiled = ts.transpileModule(source + exportsForTests, {
  fileName: sourcePath,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const evaluated = { exports: {} };
const baseRequire = createRequire(import.meta.url);
const downloadSource = readFileSync(new URL("../lib/video-download.ts", import.meta.url), "utf8");
const downloadCompiled = ts.transpileModule(downloadSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const downloadModule = { exports: {} };
new Function("module", "exports", downloadCompiled)(downloadModule, downloadModule.exports);
const componentRequire = (specifier) => specifier === "@/lib/video-download" ? downloadModule.exports : baseRequire(specifier);
new Function("require", "module", "exports", compiled)(componentRequire, evaluated, evaluated.exports);
const { restoreArchive, freshProject, applyProjectChanges, applySegmentChange, scriptKey, intentKey, safeProfile, applySavedProfile, configurationFrom, affectsExport, default: Studio } = evaluated.exports;

const audio = { start: 0, end: 3, text: "Lời kể thử nghiệm", audioBase64: "AQID", audioMime: "audio/wav", duration: 1 };
const archive = {
  format: "loike-project-v1",
  project: { id: "foreign-project", userId: "foreign-user", duration: 3, title: "Dự án thử nghiệm", segments: [audio], profile: { name: "Tên thử", apiKey: "must-not-copy" } },
  video: { data: "AQID", type: "video/mp4" },
};
const project = { ...freshProject("current-user"), duration: 3, voiceId: "voice-one", segments: [audio] };

test("archive imports assign a fresh id and current owner, preserving the real media bytes", () => {
  const restored = restoreArchive(archive, "current-user");
  assert.equal(restored.userId, "current-user");
  assert.notEqual(restored.id, archive.project.id);
  assert.ok(restored.source instanceof Blob);
  assert.equal(restored.source.size, 3);
  assert.equal(restored.profile.apiKey, undefined);
});

test("archive imports reject media outside the expected video type", () => {
  assert.throws(() => restoreArchive({ ...archive, video: { ...archive.video, type: "text/html" } }, "current-user"));
});

test("archive imports reject duration above the supported 90 seconds", () => {
  assert.throws(() => restoreArchive({ ...archive, project: { ...archive.project, duration: 91 } }, "current-user"));
});

test("archive imports reject narration timelines extending beyond the clip", () => {
  assert.throws(() => restoreArchive({ ...archive, project: { ...archive.project, segments: [{ start: 0, end: 99, text: "Invalid" }] } }, "current-user"));
});

test("changing a voice invalidates its previously generated audio without mutating the old project", () => {
  const changed = applyProjectChanges(project, { voiceId: "voice-two" });
  assert.equal(changed.segments[0].audioBase64, undefined);
  assert.equal(changed.segments[0].text, audio.text);
  assert.equal(project.segments[0].audioBase64, "AQID");
  assert.equal(applyProjectChanges(project, { voiceId: "voice-one" }).segments[0].audioBase64, "AQID");
});

test("editing script text removes the old voice bytes and measured duration", () => {
  const changed = applySegmentChange(audio, { text: "Lời kể đã chỉnh" });
  assert.equal(changed.audioBase64, undefined);
  assert.equal(changed.audioMime, undefined);
  assert.equal(changed.duration, undefined);
});

test("adjusting a timing boundary preserves audio for the exporter to measure against the new interval", () => {
  const changed = applySegmentChange(audio, { end: 2.5 });
  assert.equal(changed.audioBase64, "AQID");
  assert.equal(changed.end, 2.5);
});

test("request fingerprints change after a script edit, allowing stale AI results to be rejected", () => {
  const edited = { ...project, segments: [{ ...audio, text: "Nội dung mới" }] };
  assert.notEqual(scriptKey(project), scriptKey(edited));
});

test("AI request fingerprints reject results after format, angle, mode or creator preferences change", () => {
  for (const changes of [{format:"story"}, {angleId:"angle-2"}, {mode:"face"}, {profile:{...project.profile,customPrompt:"Giữ một giọng văn khác"}}, {profile:{...project.profile,audience:"Khán giả khác"}}]) assert.notEqual(intentKey(project), intentKey({...project,...changes}));
  assert.equal(intentKey(project), intentKey({...project,step:4}), "navigation does not change the AI request's editorial inputs");
});

test("saving new account defaults preserves explicit per-video preferences and sanitizes the result", () => {
  const previous=safeProfile({channel:"Kênh cũ",audience:"Mặc định",tone:"Mộc mạc",cta:"Hỏi thêm",facts:"Thông tin nền"});
  const current={...previous,audience:"Khán giả riêng của video",cta:"",facts:"Thông tin riêng của video"};
  const saved=safeProfile({channel:"Kênh mới",audience:"Mặc định mới",tone:"Tự nhiên",cta:"Lời nhắn mới",customPrompt:"Câu ngắn",facts:"Nền mới"});
  const merged=applySavedProfile(current,previous,saved);
  assert.equal(merged.channel,"Kênh mới");assert.equal(merged.tone,"Tự nhiên");assert.equal(merged.customPrompt,"Câu ngắn");assert.equal(merged.audience,"Khán giả riêng của video");assert.equal(merged.cta,"");assert.equal(merged.facts,"Thông tin riêng của video");
  assert.equal(current.channel,"Kênh cũ");assert.equal(applySavedProfile({...current,apiKey:"discard"},previous,saved).apiKey,undefined);
});

test("configuration preserves the member identity, shared AI state, and quota without granting admin by default", () => {
  const config = configurationFrom({ userId: "current-user", memberName: "Thành viên", deepseekConfigured: true, elevenConfigured: true, quota: { used: 2, limit: 10 }, isAdmin: false }, "local");
  assert.equal(config.displayName, "Thành viên");
  assert.equal(config.authenticated, true);
  assert.equal(config.deepseek, true);
  assert.equal(config.eleven, true);
  assert.equal(config.isAdmin, false);
  assert.deepEqual(config.quota, { used: 2, limit: 10 });
  assert.equal(configurationFrom({}, "local").isAdmin, false);
  assert.equal(configurationFrom({ userId: "admin", isAdmin: true }, "local").isAdmin, true);
  assert.deepEqual(Object.keys(safeProfile({ name: "Tên", apiKey: "must-not-copy" })).sort(), ["audience", "brand", "channel", "cta", "customPrompt", "facts", "name", "pronoun", "tone", "topic"]);
});

test("Maziao readiness works without ElevenLabs and an explicitly unavailable provider never falls back", () => {
  const maziao = configurationFrom({ userId: "current-user", voiceProvider: "maziao", maziaoConfigured: true, voiceConfigured: true, elevenConfigured: false }, "local");
  assert.equal(maziao.voiceProvider, "maziao"); assert.equal(maziao.voiceConfigured, true); assert.equal(maziao.eleven, false);
  const unavailable = configurationFrom({ voiceProvider: "maziao", voiceConfigured: false, maziaoConfigured: false, elevenConfigured: true }, "local");
  assert.equal(unavailable.voiceConfigured, false, "an ElevenLabs key must not enable a disconnected Maziao selection");
  const legacy = configurationFrom({ elevenConfigured: true }, "local");
  assert.equal(legacy.voiceProvider, "eleven"); assert.equal(legacy.voiceConfigured, true);
});

test("the actual voice screen presents provider-specific clone requirements while keeping ElevenLabs uploads", () => {
  for (const provider of ["maziao", "eleven"]) {
    const configuredSource = source.replace('useState<View>("studio")', 'useState<View>("voices")')
      .replace('useState<Configuration>({ userId: "local", deepseek: false, eleven: false })', `useState<Configuration>({ userId: "member", deepseek: true, eleven: ${provider === "eleven"}, voiceProvider: "${provider}", voiceConfigured: true, maziaoConfigured: ${provider === "maziao"} })`);
    const output = ts.transpileModule(configuredSource, { fileName: sourcePath, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const viewModule = { exports: {} };
    new Function("require", "module", "exports", output)(componentRequire, viewModule, viewModule.exports);
    const html = renderToString(React.createElement(viewModule.exports.default));
    assert.ok(html.includes("Tạo giọng cá nhân"), "the actual voice page should be rendered");
    assert.equal(html.includes('id="clone-gender"'), provider === "maziao");
    assert.equal(/id="voice-samples"[^>]*multiple=""/.test(html), provider === "eleven");
    assert.equal(html.includes("gói ElevenLabs Starter"), provider === "eleven");
    assert.equal(html.includes("ít nhất 3 giây"), provider === "maziao");
    const refreshAttributes = html.match(/<button class="button secondary"([^>]*)>/)?.[1];
    assert.equal(typeof refreshAttributes, "string");
    assert.equal(refreshAttributes.includes("disabled"), false, "configured Maziao must not be blocked by an absent ElevenLabs key");
  }
});

test("exported video survives step navigation and editorial metadata updates but expires after media changes", () => {
  for (const changes of [{ step: 4 }, { title: "Tên video mới" }, { format: "story", angleId: "angle-2" }, { intent: "Thông điệp mới" }, { profile: safeProfile({ channel: "Kênh riêng" }) }]) assert.equal(affectsExport(changes), false);
  for (const changes of [{ id: "another-project" }, { source: new Blob(["new-video"]) }, { duration: 15 }, { segments: [{ start: 0, end: 3, text: "Đổi lời" }] }, { voiceId: "different-voice" }, { narration: undefined }, { keepAmbient: true }]) assert.equal(affectsExport(changes), true);
});

test("archive preserves creator preferences, selected format and safe suggested script angles", () => {
  const analysis = { summary: "Tư liệu cảnh vườn", suggestedAngles: [{ id: "angle-2", title: "Chuyện khu vườn", format: "story", purpose: "Tạo đồng cảm", hook: "Bạn vui vì điều gì?", reason: "Phù hợp thông điệp người quay", apiKey: "must-not-copy" }], recommendedAngleId: "angle-2", providerSecret: "must-not-copy" };
  const profile = { name: "Người kể", channel: "Vườn của mình", brand: "Nhà vườn", audience: "Người mới làm vườn", topic: "Nho", pronoun: "Mình — bạn", customPrompt: "Câu ngắn, không nói quá", cta: "Mời chia sẻ ý kiến", facts: "Vườn nhà", tone: "Mộc mạc", apiKey: "must-not-copy" };
  const restored = restoreArchive({ ...archive, project: { ...archive.project, format: "story", angleId: "angle-2", analysis, profile } }, "current-user");
  assert.equal(restored.format, "story"); assert.equal(restored.angleId, "angle-2");
  for (const field of ["channel", "brand", "audience", "topic", "pronoun", "customPrompt", "tone"]) assert.equal(restored.profile[field], profile[field]);
  assert.equal(restored.analysis.suggestedAngles[0].purpose, "Tạo đồng cảm"); assert.equal(restored.analysis.recommendedAngleId, "angle-2");
  assert.equal(restored.profile.apiKey, undefined); assert.equal(restored.analysis.providerSecret, undefined); assert.equal(restored.analysis.suggestedAngles[0].apiKey, undefined);
  const invalid = restoreArchive({ ...archive, project: { ...archive.project, format: "unsafe-format", analysis: { suggestedAngles: [{ format: "unsafe-format", title: "Discard" }] } } }, "current-user");
  assert.equal(invalid.format, "review"); assert.deepEqual(invalid.analysis.suggestedAngles, []);
});

test("the real initial UI renders the simplified workspace without admin links or member API key fields", () => {
  const html = renderToString(React.createElement(Studio));
  assert.ok(html.includes("app-header"));
  assert.ok(html.includes("Tạo video"));
  assert.ok(html.includes("Video của tôi"));
  assert.ok(html.includes("Giọng của tôi"));
  assert.ok(html.indexOf('class="capture-actions"') < html.indexOf('class="camera-stage'), "record controls must be presented before the preview canvas");
  assert.ok(html.includes('href="/dang-nhap"'));
  assert.equal(html.includes('href="/quan-tri"'), false);
  for (const removed of ["sidebar", "intent-panel", "ChatGPT", "Gemini", "API key"]) assert.equal(html.includes(removed), false, `${removed} should not appear in the initial UI`);
});
