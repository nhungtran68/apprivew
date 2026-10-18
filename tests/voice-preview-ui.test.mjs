// Render the real voice page with cached voice/account state. No provider,
// network, browser, or paid audio generation is used by this regression suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const sourcePath = new URL("../components/platform/VoiceAiPage.tsx", import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  fileName: sourcePath.pathname,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const baseRequire = createRequire(import.meta.url);
const preview = "https://r2-storage.maziao.com/users/owner/clone-preview.wav";
const cloneId = "maziao:lingual_speech_v2:owner-clone";
const clone = { voiceId: cloneId, name: "Giọng của quản trị", category: "cloned", previewUrl: preview };

function renderPage({ voices = [clone], curated = [], candidates = [], isAdmin = true, fetchImpl } = {}) {
  // The first three state values are the page's fetched voice list, approval
  // list, and verified admin candidates, respectively. Remaining hooks use
  // their real initial values; effects stay deferred just as they do in SSR.
  const states = [voices, curated, candidates];
  let cursor = 0;
  const calls = [];
  const mockReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useCallback: callback => callback,
    useEffect: () => {},
    useRef: initial => ({ current: initial }),
  };
  const viewModule = { exports: {} };
  const componentRequire = specifier => {
    if (specifier === "react") return mockReact;
    if (specifier === "next/link") return { default: props => React.createElement("a", props, props.children) };
    if (specifier === "./AccountProvider") return { useAccount: () => ({ status: "ready", account: { userId: "viewer", isAdmin }, refresh: () => {} }) };
    if (specifier === "./PlatformIcon") return { PlatformIcon: () => React.createElement("svg", { "aria-hidden": true }) };
    if (specifier === "./VoiceAiPage.module.css") return { default: new Proxy({}, { get: (_target, property) => String(property) }) };
    if (specifier === "@/lib/studio-upload") return {};
    return baseRequire(specifier);
  };
  new Function("require", "module", "exports", "fetch", compiled)(componentRequire, viewModule, viewModule.exports, (...args) => {
    calls.push(args);
    if (fetchImpl) return fetchImpl(...args);
    throw new Error("SSR must not request provider audio or other APIs");
  });
  const rerender = () => {
    cursor = 0;
    const tree = viewModule.exports.default();
    return { tree, html: renderToStaticMarkup(tree), calls, rerender };
  };
  return rerender();
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
}
function catalogRows(tree) {
  return elements(tree).filter(element => element.type === "article" && element.props.className === "catalogRow");
}

test("admin clone cards replace clone metadata with an audio sample and preserve the approved state", () => {
  const { tree, html, calls } = renderPage({ curated: [{ voice_id: cloneId, name: clone.name, enabled: true, kind: "admin_clone" }] });
  const [row] = catalogRows(tree);
  assert.ok(row, "the shared voice section must render its actual clone card");
  const descendants = elements(row);
  const audio = descendants.find(element => element.type === "audio");
  assert.equal(audio.props.src, preview);
  assert.equal(audio.props.controls, true);
  assert.equal(audio.props.preload, "none");
  assert.equal(audio.props["aria-label"], `Nghe thử ${clone.name}`);
  const checkbox = descendants.find(element => element.type === "input" && element.props.type === "checkbox");
  assert.equal(checkbox.props["aria-label"], `Cho thành viên dùng giọng ${clone.name}`);
  assert.equal(checkbox.props.checked, true);
  assert.equal(typeof checkbox.props.onChange, "function");
  assert.ok(!html.includes("Giọng nhân bản của quản trị viên"));
  assert.ok(!html.includes("Đang dùng chung"));
  assert.deepEqual(calls, []);
});

test("playing a sample cannot toggle sharing through a wrapping checkbox label", () => {
  const { tree } = renderPage();
  const [row] = catalogRows(tree);
  assert.ok(row);
  assert.equal(row.type, "article");
  for (const label of elements(row).filter(element => element.type === "label")) {
    assert.ok(!elements(label).some(element => element.type === "audio"), "audio controls must be outside every checkbox label");
  }
  const checkbox = elements(row).find(element => element.type === "input");
  assert.equal(checkbox.props.checked, false);
});

test("sharing card samples occupy their own row instead of shrinking inside the title beside the checkbox", () => {
  const { tree } = renderPage();
  const [row] = catalogRows(tree);
  const children = React.Children.toArray(row.props.children);
  const title = children.find(element => elements(element).some(child => child.type === "strong"));
  const checkbox = children.find(element => element.type === "input" && element.props.type === "checkbox");
  const sample = children.find(element => element.type === "audio");
  assert.ok(title, "the title remains an independent grid item");
  assert.ok(checkbox, "sharing remains an independent control beside the title");
  assert.ok(sample, "the player must be a direct card child so it can span the full mobile card width");
  assert.ok(!elements(title).some(element => element.type === "audio"), "the player must never inherit the title's narrow grid column");
  assert.equal(sample.props.className, "catalogPreview");
  assert.equal(sample.props.src, preview);
});

test("verified admin candidates supply the sample even when the older display list calls the clone a library voice", () => {
  const { tree, html, calls } = renderPage({
    voices: [{ ...clone, category: "library", previewUrl: undefined }],
    candidates: [{ voice_id: cloneId, name: clone.name, kind: "admin_clone", enabled: false, previewUrl: preview }],
  });
  const [row] = catalogRows(tree);
  assert.equal(elements(row).find(element => element.type === "audio").props.src, preview);
  assert.ok(!renderToStaticMarkup(row).includes("Giọng thư viện"));
  assert.ok(!html.includes("Giọng nhân bản của quản trị viên"));
  assert.deepEqual(calls, []);
});

test("a clone without a supplied sample shows a short placeholder without manufacturing audio", () => {
  const { tree, calls } = renderPage({ voices: [{ ...clone, previewUrl: undefined }] });
  const [row] = catalogRows(tree);
  assert.ok(renderToStaticMarkup(row).includes("Chưa có bản nghe thử"));
  assert.equal(elements(row).filter(element => element.type === "audio").length, 0);
  assert.deepEqual(calls, []);
});

test("members retain ordinary voice samples and never render the admin sharing controls", () => {
  const { tree, html, calls } = renderPage({ isAdmin: false });
  assert.equal(catalogRows(tree).length, 0);
  assert.ok(!html.includes("Giọng dùng chung cho tất cả thành viên"));
  assert.ok(elements(tree).some(element => element.type === "audio" && element.props.src === preview));
  assert.deepEqual(calls, []);
});

test("a member can confirm deletion only for their own personal clone", () => {
  const personal = { ...clone, isPersonalClone: true };
  const { tree, rerender, calls } = renderPage({ voices: [personal], isAdmin: false });
  const trigger = elements(tree).find(element => element.type === "button" && element.props.className === "deleteTrigger");
  assert.ok(trigger, "an owned clone should provide a deletion action");
  assert.ok(renderToStaticMarkup(tree).includes("Xóa giọng để tạo giọng khác"));
  assert.ok(!renderToStaticMarkup(tree).includes("Xác nhận xóa"));
  trigger.props.onClick();
  const confirmed = rerender();
  assert.ok(confirmed.html.includes("không thể khôi phục"));
  const buttons = elements(confirmed.tree).filter(element => element.type === "button");
  assert.ok(buttons.some(button => button.props.className === "deleteConfirmButton"));
  buttons.find(button => button.props.className === "deleteCancel").props.onClick();
  assert.ok(!rerender().html.includes("Xác nhận xóa"));
  assert.deepEqual(calls, [], "opening and cancelling confirmation must not call an API");
});

test("admin and shared voices have no deletion action even when clone metadata is present", () => {
  const personal = { ...clone, isPersonalClone: true };
  const admin = renderPage({ voices: [personal], isAdmin: true });
  assert.ok(!admin.html.includes("Xóa giọng để tạo giọng khác"));
  const memberShared = renderPage({ voices: [clone], isAdmin: false });
  assert.ok(!memberShared.html.includes("Xóa giọng để tạo giọng khác"));
  assert.deepEqual(admin.calls, []);
  assert.deepEqual(memberShared.calls, []);
});

test("confirmed member deletion sends DELETE for the encoded owned voice ID", () => {
  const personal = { ...clone, isPersonalClone: true };
  const view = renderPage({ voices: [personal], isAdmin: false, fetchImpl: () => new Promise(() => {}) });
  elements(view.tree).find(element => element.type === "button" && element.props.className === "deleteTrigger").props.onClick();
  const confirmed = view.rerender();
  elements(confirmed.tree).find(element => element.type === "button" && element.props.className === "deleteConfirmButton").props.onClick();
  assert.deepEqual(view.calls, [[`/api/voices/${encodeURIComponent(cloneId)}`, { method: "DELETE" }]]);
});
