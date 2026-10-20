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
const exportsForTests = "\nexport {restoreArchive,freshProject,applyProjectChanges,applySegmentChange,scriptKey,intentKey,safeProfile,applySavedProfile,configurationFrom,affectsExport,voiceScriptMinimumHint,pendingSpeechSegments,withoutSpeechPaths};";
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
const componentRequire = (specifier) => specifier === "@/lib/video-download" ? downloadModule.exports
  : specifier === "@/components/platform/PixabayVideoPicker" ? { default: () => null }
  : specifier === "@/components/platform/StockVideoWorkspace" ? { default: () => null }
  : specifier === "./StudioNavigation.module.css" ? { default: { navigation: "studio-navigation", exit: "studio-exit", label: "studio-label" } }
  : baseRequire(specifier);
new Function("require", "module", "exports", compiled)(componentRequire, evaluated, evaluated.exports);
const { restoreArchive, freshProject, applyProjectChanges, applySegmentChange, scriptKey, intentKey, safeProfile, applySavedProfile, configurationFrom, affectsExport, voiceScriptMinimumHint, pendingSpeechSegments, withoutSpeechPaths, default: Studio } = evaluated.exports;

function renderStudioState(projectState, configuration = {}) {
  const initialProject = `{ ...freshProject("current-user"), source: new Blob(["video"], { type: "video/mp4" }), ...${JSON.stringify(projectState)} }`;
  const initialConfig = { userId: "current-user", deepseek: true, eleven: false, voiceProvider: "maziao", voiceConfigured: true, maziaoConfigured: true, ...configuration };
  const configuredSource = source.replace('useState<Project>(() => freshProject("local"))', `useState<Project>(() => (${initialProject}))`)
    .replace('useState<Configuration>({ userId: "local", deepseek: false, eleven: false })', `useState<Configuration>(${JSON.stringify(initialConfig)})`);
  const output = ts.transpileModule(configuredSource, { fileName: sourcePath, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const viewModule = { exports: {} };
  new Function("require", "module", "exports", output)(componentRequire, viewModule, viewModule.exports);
  return renderToString(React.createElement(viewModule.exports.default));
}

function buttonsWithLabel(html, label) {
  return Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g))
    .filter(match => match[2].replace(/<[^>]*>/g, "").trim() === label)
    .map(match => ({ attributes: match[1], disabled: /\bdisabled(?:\s|=|$)/.test(match[1]) }));
}

// Run click handlers from the real component with stable in-memory hook state.
// Effects are omitted so persistence and navigation can be controlled without a
// browser, IndexedDB, network requests, or a provider account.
function interactiveStudio(initialProject, initialExport) {
  const hooks = [];
  let cursor = 0;
  const navigation = [], requests = [];
  const mockReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useCallback: callback => callback,
    useEffect: () => {},
  };
  const configuredSource = source
    .replace('useState<Project>(() => freshProject("local"))', 'useState<Project>(() => testProject)')
    .replace('useState<Configuration>({ userId: "local", deepseek: false, eleven: false })', 'useState<Configuration>({ userId: "current-user", deepseek: true, eleven: true, voiceConfigured: true })')
    .replace('const [ready, setReady] = useState(false);', 'const [ready, setReady] = useState(true);')
    .replace('const [exported, setExported] = useState<Blob>();', 'const [exported, setExported] = useState<Blob>(testExport);');
  const output = ts.transpileModule(`${configuredSource}\nexports.setPersistence = (persist) => { persistProject = persist; };`, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const viewModule = { exports: {} };
  new Function("require", "module", "exports", "testProject", "testExport", "window", "fetch", output)(
    specifier => specifier === "react" ? mockReact : componentRequire(specifier), viewModule, viewModule.exports,
    initialProject, initialExport, { location: { assign: path => navigation.push(path) } },
    async (...args) => { requests.push(args); throw new Error("Unexpected network request"); },
  );
  return { render: () => { cursor = 0; return viewModule.exports.default(); }, setPersistence: viewModule.exports.setPersistence, navigation, requests };
}

function renderedElements(node) {
  if (Array.isArray(node)) return node.flatMap(renderedElements);
  return React.isValidElement(node) ? [node, ...renderedElements(node.props.children)] : [];
}
function renderedText(node) {
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (React.isValidElement(node)) return renderedText(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function renderedButton(tree, label) {
  const button = renderedElements(tree).find(item => item.type === "button" && renderedText(item) === label);
  assert.ok(button, `the real UI must contain ${label}`);
  return button;
}

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
  const pending = { ...project, segments: [{ ...audio, audioPath: "current-user/narration/paid.wav" }] };
  const changed = applyProjectChanges(pending, { voiceId: "voice-two" });
  assert.equal(changed.segments[0].audioBase64, undefined);
  assert.equal(changed.segments[0].audioPath, undefined, "a voice change must not retain a recovery path for the old voice");
  assert.equal(changed.segments[0].text, audio.text);
  assert.equal(pending.segments[0].audioBase64, "AQID");
  assert.equal(pending.segments[0].audioPath, "current-user/narration/paid.wav");
  assert.equal(applyProjectChanges(pending, { voiceId: "voice-one" }).segments[0].audioBase64, "AQID");
  assert.equal(applyProjectChanges(pending, { voiceId: "voice-one" }).segments[0].audioPath, "current-user/narration/paid.wav");
});

test("editing script text removes the old voice bytes and measured duration", () => {
  const pending = { ...audio, audioPath: "current-user/narration/paid.wav" };
  const changed = applySegmentChange(pending, { text: "Lời kể đã chỉnh" });
  assert.equal(changed.audioBase64, undefined);
  assert.equal(changed.audioMime, undefined);
  assert.equal(changed.duration, undefined);
  assert.equal(changed.audioPath, undefined, "the old text's paid speech is not the edited narration");
  assert.equal(pending.audioPath, "current-user/narration/paid.wav");
  assert.equal(applySegmentChange(pending, { text: pending.text }).audioPath, pending.audioPath);
});

test("editing or removing part of an undelivered batch clears every stale recovery path but timing edits preserve delivery", () => {
  const segments = [
    { ...audio, audioBase64: undefined, audioPath: "current-user/narration/first.wav" },
    { ...audio, start: 3, end: 6, text: "Đoạn thứ hai", audioPath: "current-user/narration/second.wav" },
  ];
  const pending = { ...project, duration: 6, segments };
  const edited = applyProjectChanges(pending, { segments: [applySegmentChange(segments[0], { text: "Lời đã thay đổi" }), segments[1]] });
  assert.ok(edited.segments.every(segment => segment.audioPath === undefined), "mixed old paths and newly edited missing audio must not trap recovery");
  assert.equal(edited.segments[0].text, "Lời đã thay đổi");
  assert.equal(edited.segments[1].audioBase64, audio.audioBase64, "unchanged local audio survives an edit to another segment");
  const removed = applyProjectChanges(pending, { segments: [segments[1]] });
  assert.equal(removed.segments[0].audioPath, undefined);
  const timingOnly = applyProjectChanges(pending, { segments: [applySegmentChange(segments[0], { end: 2.5 }), segments[1]] });
  assert.deepEqual(timingOnly.segments.map(segment => segment.audioPath), segments.map(segment => segment.audioPath));
  const received = applyProjectChanges(pending, { segments: segments.map(segment => ({ ...segment, audioBase64: "AQID" })) });
  assert.deepEqual(received.segments.map(segment => segment.audioPath), segments.map(segment => segment.audioPath), "receiving bytes must retain paths until the durable save succeeds");
  assert.ok(pending.segments.every(segment => segment.audioPath), "edits do not mutate the earlier saved project");
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

test("AI request fingerprints reject results after script type, mode or creator preferences change", () => {
  for (const changes of [{format:"story"}, {templateId:"e0b8aa89-af07-4551-87c0-2bcb8ae15930"}, {angleId:"angle-2"}, {mode:"face"}, {profile:{...project.profile,customPrompt:"Giữ một giọng văn khác"}}, {profile:{...project.profile,audience:"Khán giả khác"}}]) assert.notEqual(intentKey(project), intentKey({...project,...changes}));
  assert.equal(intentKey(project), intentKey({...project,step:4}), "navigation does not change the AI request's editorial inputs");
});

test("analyzed video shows script types without revealing the analysis as narration", () => {
  const hiddenAnalysis = "Cảnh chỉ có hộp sản phẩm màu xanh";
  const html = renderStudioState({ step: 1, duration: 20, intent: "Giải thích cách dùng sản phẩm", analysis: { summary: hiddenAnalysis, suggestedAngles: [{ id: "old", title: "Góc cũ", format: "review" }] } });
  assert.ok(html.includes("Chọn dạng kịch bản"));
  assert.ok(html.includes("Review sản phẩm"));
  assert.ok(html.includes("Giải thích cách dùng sản phẩm"));
  assert.ok(!html.includes(hiddenAnalysis));
  assert.ok(!html.includes("Góc cũ"));
  assert.ok(!html.includes("AI đã nhìn thấy gì?"));
});

test("saving new account defaults preserves explicit per-video preferences and sanitizes the result", () => {
  const previous=safeProfile({channel:"Kênh cũ",audience:"Mặc định",tone:"Mộc mạc",cta:"Hỏi thêm",facts:"Thông tin nền"});
  const current={...previous,audience:"Khán giả riêng của video",cta:"",facts:"Thông tin riêng của video"};
  const saved=safeProfile({channel:"Kênh mới",audience:"Mặc định mới",tone:"Tự nhiên",cta:"Lời nhắn mới",customPrompt:"Câu ngắn",facts:"Nền mới"});
  const merged=applySavedProfile(current,previous,saved);
  assert.equal(merged.channel,"Kênh mới");assert.equal(merged.tone,"Tự nhiên");assert.equal(merged.customPrompt,"Câu ngắn");assert.equal(merged.audience,"Khán giả riêng của video");assert.equal(merged.cta,"");assert.equal(merged.facts,"Thông tin riêng của video");
  assert.equal(current.channel,"Kênh cũ");assert.equal(applySavedProfile({...current,apiKey:"discard"},previous,saved).apiKey,undefined);
});

test("configuration preserves the member identity, shared AI state, and credits without granting admin by default", () => {
  const config = configurationFrom({ userId: "current-user", memberName: "Thành viên", deepseekConfigured: true, elevenConfigured: true, credits: { balance: 10, reserved: 2, available: 8 }, isAdmin: false }, "local");
  assert.equal(config.displayName, "Thành viên");
  assert.equal(config.authenticated, true);
  assert.equal(config.deepseek, true);
  assert.equal(config.eleven, true);
  assert.equal(config.isAdmin, false);
  assert.deepEqual(config.credits, { balance: 10, reserved: 2, available: 8 });
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

test("only Vieten voices require 100 cleaned characters across the whole script, without padding or changing it", () => {
  const segments = [{ ...audio, text: `  ${"a".repeat(49)}  ` }, { ...audio, text: `\n${"b".repeat(50)}\n` }];
  const original = structuredClone(segments);
  assert.ok(voiceScriptMinimumHint("maziao:vieten_speech:voice-1", segments).includes("ít nhất 100 ký tự"));
  assert.equal(voiceScriptMinimumHint("maziao:vieten_speech:voice-1", [{ ...segments[0], text: "a".repeat(50) }, segments[1]]), "");
  for (const voiceId of ["maziao:lingual_speech_v2:voice-1", "eleven-voice", "", "maziao:vieten_speech:"]) assert.equal(voiceScriptMinimumHint(voiceId, segments), "");
  assert.deepEqual(segments, original);
});

test("pending paid speech keeps current-user paths and timing while discarding signed URLs and provider extras", () => {
  const input = [
    { start: 0, end: 3, text: "Lời đọc thứ nhất", audioPath: "current-user/narration/one.mp3", audioMime: "audio/mpeg", duration: 1.5, audioUrl: "https://private.invalid/one.mp3?token=never-persist", providerSecret: "never-persist", audioBase64: "unvalidated-response-data" },
    { start: 3, end: 6, text: "Lời đọc thứ hai", audioPath: "current-user/narration/two.wav", audioMime: "audio/wav", duration: 2 },
  ];
  const original = structuredClone(input);
  const pending = pendingSpeechSegments(input, 6, "current-user");
  assert.equal(pending.length, 2);
  for (const [index, item] of pending.entries()) {
    assert.equal(item.start, input[index].start); assert.equal(item.end, input[index].end); assert.equal(item.text, input[index].text);
    assert.equal(item.audioPath, input[index].audioPath); assert.equal(item.audioMime, input[index].audioMime); assert.equal(item.duration, input[index].duration);
    assert.equal(item.audioUrl, undefined); assert.equal(item.providerSecret, undefined); assert.equal(item.audioBase64, undefined);
  }
  assert.ok(!JSON.stringify(pending).includes("never-persist"));
  assert.deepEqual(input, original);
});

test("pending paid speech rejects foreign or unsafe paths, invalid timelines and oversized batches", () => {
  const valid = { start: 0, end: 3, text: "Lời đọc", audioPath: "current-user/narration/paid.mp3", audioMime: "audio/mpeg" };
  for (const value of [undefined, {}, [], Array.from({ length: 17 }, () => valid), [null],
    [{ ...valid, audioPath: "other-user/narration/paid.mp3" }],
    [{ ...valid, audioPath: "current-user/../other-user/paid.mp3" }],
    [{ ...valid, audioPath: "current-user/narration/paid.mp3?token=private" }],
    [{ ...valid, audioPath: undefined }],
    [{ ...valid, start: -1 }], [{ ...valid, start: NaN }], [{ ...valid, end: Infinity }],
    [{ ...valid, end: 3.1 }], [{ ...valid, start: 2, end: 2 }], [{ ...valid, text: "x".repeat(2401) }],
  ]) assert.throws(() => pendingSpeechSegments(value, 3, "current-user"));
  const maximum = Array.from({ length: 16 }, (_, index) => ({ ...valid, start: index, end: index + 1, audioPath: `current-user/narration/${index}.mp3` }));
  assert.equal(pendingSpeechSegments(maximum, 16, "current-user").length, 16);
});

test("archive transfer preserves inline MP3 and editable duration but drops every account's recovery paths", () => {
  const paid = { ...audio, audioMime: "audio/mpeg", audioPath: "current-user/narration/paid.mp3" };
  const portable = withoutSpeechPaths([paid]);
  assert.equal(portable[0].audioPath, undefined); assert.equal(portable[0].audioBase64, paid.audioBase64); assert.equal(portable[0].audioMime, "audio/mpeg");
  assert.equal(paid.audioPath, "current-user/narration/paid.mp3", "preparing a backup must not clear the live project's recovery state");
  const restored = restoreArchive({ ...archive, project: { ...archive.project, manualDuration: true, segments: [{ ...paid, audioUrl: "https://private.invalid/paid.mp3?token=never-import" }] } }, "another-user");
  assert.equal(restored.userId, "another-user"); assert.equal(restored.manualDuration, true);
  assert.equal(restored.segments[0].audioBase64, paid.audioBase64); assert.equal(restored.segments[0].mimeType, "audio/mpeg");
  assert.equal(restored.segments[0].audioPath, undefined); assert.equal(restored.segments[0].audioUrl, undefined);
  const noBytes = restoreArchive({ ...archive, project: { ...archive.project, segments: [{ ...paid, audioBase64: undefined }] } }, "another-user");
  assert.equal(noBytes.segments[0].text, paid.text); assert.equal(noBytes.segments[0].audioPath, undefined); assert.equal(noBytes.segments[0].audioBase64, undefined);
  const legacyUnknown = restoreArchive({ ...archive, project: { ...archive.project, duration: 0, segments: [] } }, "current-user");
  assert.equal(legacyUnknown.manualDuration, true, "an old archive with no measured duration must still offer manual correction");
});

test("the actual pending speech screen offers download-only recovery despite a short Vieten script or unavailable provider", () => {
  for (const [voiceConfigured, voiceId] of [[true, "maziao:vieten_speech:voice-1"], [false, "maziao:vieten_speech:voice-1"], [false, ""]]) {
    const html = renderStudioState({ duration: 20, step: 3, voiceId, segments: [{ start: 0, end: 20, text: "Lời đọc đã tạo", audioPath: "current-user/narration/paid.mp3", audioMime: "audio/mpeg" }] }, { voiceConfigured, maziaoConfigured: voiceConfigured });
    const retry = buttonsWithLabel(html, "Tải lại lời đọc");
    assert.equal(retry.length, 1, "there is one clear action to receive the completed speech");
    assert.ok(retry.some(button => button.attributes.includes("primary")), "the main action must recover the paid audio");
    assert.ok(retry.every(button => !button.disabled));
    assert.equal(buttonsWithLabel(html, "Tạo giọng đọc").length, 0);
    assert.equal(buttonsWithLabel(html, "Tạo lại giọng đọc").length, 0);
    assert.equal(html.includes("Giọng này cần ít nhất 100 ký tự lời thoại."), false, "generation limits cannot block delivery of an existing result");
  }
});

test("the actual speech screen offers saving existing bytes after local persistence fails without offering a new generation", () => {
  const html = renderStudioState({ duration: 3, step: 3, voiceId: "maziao:vieten_speech:voice-1", segments: [{ ...audio, audioMime: "audio/mpeg", audioPath: "current-user/narration/paid.mp3" }] }, { voiceConfigured: false, maziaoConfigured: false });
  const save = buttonsWithLabel(html, "Lưu lại lời đọc");
  assert.ok(save.length > 0); assert.ok(save.every(button => !button.disabled));
  assert.equal(buttonsWithLabel(html, "Tải lại lời đọc").length, 0);
  assert.equal(buttonsWithLabel(html, "Tạo giọng đọc").length, 0);
  assert.equal(buttonsWithLabel(html, "Tạo lại giọng đọc").length, 0);
  assert.ok(html.includes("data:audio/mpeg;base64,AQID"), "the paid audio stays available to preview in the current page");
});

test("the actual duration editor stays available after the first digit, multidigit entry and correction", () => {
  for (const duration of [0, 3, 30, 30.5, 25]) {
    const html = renderStudioState({ duration, manualDuration: true, step: 1, intent: "Lời kể về khu vườn" });
    const field = html.match(/<input\b[^>]*id="manual-duration"[^>]*>/)?.[0];
    assert.equal(typeof field, "string", `the field remains editable at ${duration} seconds`);
    assert.ok(field.includes(`value="${duration || ""}"`));
    assert.ok(!field.includes("disabled"));
  }
  const measured = renderStudioState({ duration: 30, manualDuration: false, step: 1 });
  assert.equal(measured.includes('id="manual-duration"'), false, "a reliably measured clip does not require a manual duration field");
});

test("the actual speech screen explains Vieten's short-script limit while leaving manual audio and other models available", () => {
  for (const [voiceId, characters, blocked] of [["maziao:vieten_speech:voice-1", 99, true], ["maziao:vieten_speech:voice-1", 100, false], ["maziao:lingual_speech_v2:voice-1", 30, false], ["eleven-voice", 30, false]]) {
    const initialProject = `{ ...freshProject("member"), source: new Blob(["video"], { type: "video/mp4" }), duration: 20, step: 3, voiceId: ${JSON.stringify(voiceId)}, segments: [{ start: 0, end: 20, text: ${JSON.stringify("a".repeat(characters))} }] }`;
    const configuredSource = source.replace('useState<Project>(() => freshProject("local"))', `useState<Project>(() => (${initialProject}))`)
      .replace('useState<Configuration>({ userId: "local", deepseek: false, eleven: false })', 'useState<Configuration>({ userId: "member", deepseek: true, eleven: false, voiceProvider: "maziao", voiceConfigured: true, maziaoConfigured: true })');
    const output = ts.transpileModule(configuredSource, { fileName: sourcePath, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const viewModule = { exports: {} };
    new Function("require", "module", "exports", output)(componentRequire, viewModule, viewModule.exports);
    const html = renderToString(React.createElement(viewModule.exports.default));
    const createButton = html.match(/<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*Tạo giọng đọc<\/button>/)?.[1];
    assert.equal(typeof createButton, "string");
    assert.equal(createButton.includes("disabled"), blocked, voiceId);
    assert.equal(html.includes("Giọng này cần ít nhất 100 ký tự lời thoại."), blocked);
    const manualButton = html.match(/<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*Tải bản thu lời thoại<\/button>/)?.[1];
    assert.equal(typeof manualButton, "string"); assert.equal(manualButton.includes("disabled"), false);
  }
});

test("the legacy voice screen keeps voice browsing and sends cloning to the personal area", () => {
  for (const provider of ["maziao", "eleven"]) {
    const configuredSource = source.replace('useState<View>(initialView)', 'useState<View>("voices")')
      .replace('useState<Configuration>({ userId: "local", deepseek: false, eleven: false })', `useState<Configuration>({ userId: "member", deepseek: true, eleven: ${provider === "eleven"}, voiceProvider: "${provider}", voiceConfigured: true, maziaoConfigured: ${provider === "maziao"} })`);
    const output = ts.transpileModule(configuredSource, { fileName: sourcePath, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const viewModule = { exports: {} };
    new Function("require", "module", "exports", output)(componentRequire, viewModule, viewModule.exports);
    const html = renderToString(React.createElement(viewModule.exports.default));
    assert.ok(html.includes("Giọng của tôi"), "the actual voice page should be rendered");
    assert.ok(html.includes('href="/ca-nhan/nhan-ban-giong"'));
    assert.equal(html.includes('id="voice-samples"'), false);
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

test("the legacy Studio route awaits and whitelists its requested view without accepting arbitrary destinations", async () => {
  const pageSource = readFileSync(new URL("../app/studio/page.tsx", import.meta.url), "utf8");
  const pageOutput = ts.transpileModule(pageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const pageModule = { exports: {} };
  new Function("require", "module", "exports", pageOutput)(specifier => specifier === "@/components/Studio" ? evaluated.exports : baseRequire(specifier), pageModule, pageModule.exports);
  for (const requested of ["studio", "projects", "voices", "profile", "guide", undefined, "https://untrusted.invalid", "admin", ["projects", "voices"]]) {
    const expected = ["studio", "projects", "voices", "profile", "guide"].includes(requested) ? requested : "studio";
    const page = await pageModule.exports.default({ searchParams: Promise.resolve({ view: requested }) });
    assert.equal(page.type, Studio);
    assert.equal(page.props.initialView, expected);
  }
});

test("legacy project, profile and voice entry points render their actual views and keep dashboard exit disabled until initialization", () => {
  for (const [initialView, heading] of [["projects", "Video của tôi"], ["profile", "Để AI hiểu bạn hơn"], ["voices", "Giọng của tôi"]]) {
    const html = renderToString(React.createElement(Studio, { initialView }));
    assert.ok(html.includes(`view-${initialView}`));
    assert.ok(Array.from(html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)).some(match => match[1] === heading));
    const exit = buttonsWithLabel(html, "Về tổng quan");
    assert.equal(exit.length, 1);
    assert.equal(exit[0].disabled, true, "leaving before the saved project is loaded must not create or overwrite local state");
  }
});

test("leaving Studio waits for durable save and blocks stale speech clicks while the editor is inert", async () => {
  const current = { ...project, source: new Blob(["video"], { type: "video/mp4" }), step: 3, segments: [{ start: 0, end: 3, text: "Lời kể đang chờ tạo giọng" }] };
  const studio = interactiveStudio(current);
  let finishSave;
  const writes = [];
  studio.setPersistence(saved => { writes.push(saved); return new Promise(resolve => { finishSave = resolve; }); });
  const initialTree = studio.render();
  const exit = renderedButton(initialTree, "Về tổng quan");
  const staleSpeech = renderedButton(initialTree, "Tạo giọng đọc");
  exit.props.onClick();
  staleSpeech.props.onClick();
  exit.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1, "repeated exit must share one pending save");
  assert.equal(writes[0], current, "the current project and its media must reach persistence unchanged");
  assert.deepEqual(studio.requests, [], "a stale handler must not start paid speech during the save");
  assert.deepEqual(studio.navigation, [], "navigation must wait until IndexedDB confirms the write");
  const savingTree = studio.render(), elements = renderedElements(savingTree);
  assert.equal(elements.find(item => item.type === "header" && item.props.className === "app-header").props.inert, true);
  assert.equal(elements.find(item => item.type === "main" && item.props.id === "workspace").props.inert, true);
  assert.ok(elements.filter(item => item.type === "input" && item.props.type === "file").every(item => item.props.disabled));
  const navigationBar = elements.find(item => item.props.className === "studio-navigation");
  assert.ok(renderedElements(navigationBar).some(item => item.props.role === "status" && renderedText(item).includes("Đang lưu")), "the saving status remains outside the inert editor");
  finishSave();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(studio.navigation, ["/"]);
});

test("an unsaved exported MP4 prompts before exit, stays available after cancelling, and a failed save keeps Studio open", async () => {
  const current = { ...project, source: new Blob(["video"], { type: "video/mp4" }), step: 4 };
  const studio = interactiveStudio(current, new Blob(["rendered-mp4"], { type: "video/mp4" }));
  let writes = 0;
  studio.setPersistence(async () => { writes++; throw new Error("Storage full"); });
  renderedButton(studio.render(), "Về tổng quan").props.onClick();
  let tree = studio.render();
  let dialog = renderedElements(tree).find(item => item.props.role === "dialog" && item.props["aria-labelledby"] === "exit-export-title");
  assert.ok(dialog, "the user must see why the rendered MP4 needs a separate download");
  assert.match(renderedText(dialog), /Hãy tải xong trước khi rời trang/);
  assert.equal(writes, 0);
  assert.deepEqual(studio.navigation, []);
  renderedButton(dialog, "Ở lại Studio").props.onClick();
  tree = studio.render();
  assert.equal(renderedElements(tree).some(item => item.props["aria-labelledby"] === "exit-export-title"), false);
  assert.ok(renderedElements(tree).some(item => item.type === "a" && item.props.download === downloadModule.exports.videoDownloadName(current.title)), "cancelling must retain the existing MP4 download");
  renderedButton(tree, "Về tổng quan").props.onClick();
  dialog = renderedElements(studio.render()).find(item => item.props["aria-labelledby"] === "exit-export-title");
  renderedButton(dialog, "Về tổng quan").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = studio.render();
  assert.equal(writes, 1);
  assert.deepEqual(studio.navigation, []);
  assert.equal(renderedElements(tree).find(item => item.type === "main").props.inert, false, "a failed save must unlock the editor for recovery");
  assert.equal(renderedButton(tree, "Về tổng quan").props.disabled, false);
  assert.ok(renderedElements(tree).some(item => item.props.role === "alert" && renderedText(item).includes("Chưa lưu được dự án")));
  assert.deepEqual(studio.requests, []);
});
