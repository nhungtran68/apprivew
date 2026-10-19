import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const clip = (id, tags, width = 1080, height = 1920) => ({
  id, tags, width, height, duration: 8, size: 2_000_000,
  thumbnail: `https://cdn.pixabay.com/${id}.jpg`, videoUrl: `https://cdn.pixabay.com/${id}.mp4`,
  pageUrl: `https://pixabay.com/videos/${id}/`, user: "Creator",
});

async function fixture() {
  const calls = [];
  let plan = { scenes: [] };
  let results = new Map();
  let signedIn = true;
  class StudioError extends Error {
    constructor(code, message, status = 400, action) { super(message); Object.assign(this, { code, status, action }); }
  }
  const values = new Map([
    ["server-only", {}],
    [path.join(root, "lib/studio-contract.ts"), { StudioError }],
    [path.join(root, "lib/studio-deepseek.ts"), { deepseekJson: async (_key, prompt, _example, charge, frames) => {
      calls.push(["deepseek", prompt, frames]); await charge(); return plan;
    } }],
    [path.join(root, "lib/pixabay.ts"), { searchPixabayVideos: async (query, page, lang) => {
      calls.push(["pixabay", query, page, lang]);
      const result = results.get(query);
      if (result instanceof Error) throw result;
      return { videos: result ?? [] };
    } }],
    [path.join(root, "lib/studio-server.ts"), {
      requestUser: async (_request, mutation) => {
        calls.push(["auth", mutation]);
        if (!signedIn) throw new StudioError("SIGN_IN_REQUIRED", "Đăng nhập", 401);
        if (mutation && _request.headers.get("origin") !== new URL(_request.url).origin) throw new StudioError("INVALID_ORIGIN", "Nguồn không hợp lệ", 403);
        return "user-1";
      },
      limitedJson: request => request.json(),
      providerKey: async () => ({ key: "deepseek-private" }),
      consumeAiUnits: async (_user, units) => { calls.push(["charge", units]); },
      json: (data, status = 200) => Response.json(data, { status }),
      apiError: error => Response.json({ code: error.code ?? "INTERNAL_ERROR", error: error.message }, { status: error.status ?? 500 }),
    }],
  ]);
  const context = vm.createContext({ process, console, URL, URLSearchParams, Request, Response, AbortSignal });
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (values.has(file)) {
      const exports = values.get(file);
      const module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context, identifier: file });
      cache.set(file, module); return module;
    }
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    cache.set(file, module); return module;
  }
  async function entry(name) {
    const module = await load(path.join(root, name));
    if (module.status === "unlinked") await module.link((specifier, parent) => {
      const target = specifier === "server-only" ? specifier : specifier.startsWith("@/")
        ? path.join(root, `${specifier.slice(2)}.ts`)
        : path.resolve(path.dirname(parent.identifier), `${specifier}.ts`);
      return load(target);
    });
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  return {
    calls, entry, StudioError,
    setPlan(value) { plan = value; }, setResults(value) { results = value; }, setSignedIn(value) { signedIn = value; },
    request(body, origin = "https://app.example") { return new Request("https://app.example/api/pixabay/scenes", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }); },
  };
}

test("approved narration stays unchanged while scenes search English Pixabay terms without analyzing stock video", async () => {
  process.env.PIXABAY_API_KEY = "pixabay-private";
  const h = await fixture();
  const script = "Cuộc sống có lúc áp lực. Sau khó khăn là bình minh. Tôi tiếp tục bước đi.";
  h.setPlan({ scenes: [
    { start: 1, end: 1, description: "Áp lực công việc", query: "stressed office worker", alternateQuery: "person thinking" },
    { start: 2, end: 2, description: "Ánh sáng hy vọng", query: "sunrise after rain", alternateQuery: "sunrise" },
    { start: 3, end: 3, description: "Tiếp tục hành trình", query: "walking forward road", alternateQuery: "person walking" },
  ] });
  h.setResults(new Map([
    ["stressed office worker", [clip(1, "office, stressed, worker")]],
    ["sunrise after rain", [clip(2, "sunrise, rain, morning")]],
    ["walking forward road", [clip(3, "walking, road, forward")]],
  ]));
  const route = await h.entry("app/api/pixabay/scenes/route.ts");
  const response = await route.POST(h.request({ script, aspectRatio: "9:16" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.script, script);
  assert.equal(data.scenes.map(scene => scene.text).join(""), script);
  assert.deepEqual(data.scenes.map(scene => scene.video.id), [1, 2, 3]);
  assert.equal(data.scenes[0].startFraction, 0);
  assert.equal(data.scenes.at(-1).endFraction, 1);
  assert.equal(data.needsReview, true);
  assert.deepEqual(h.calls.filter(call => call[0] === "charge"), [["charge", 1]]);
  assert.deepEqual(h.calls.filter(call => call[0] === "pixabay").map(call => call.slice(1)), [
    ["stressed office worker", 1, "en"], ["sunrise after rain", 1, "en"], ["walking forward road", 1, "en"],
  ]);
  assert.equal(h.calls.find(call => call[0] === "deepseek")[2].length, 0);
  assert.ok(!JSON.stringify(data).includes("pixabay-private"));
});

test("empty search retries a broader query and leaves unresolved scenes for manual review", async () => {
  const h = await fixture();
  h.setPlan({ scenes: [
    { start: 1, end: 1, description: "Tìm ánh sáng", query: "silver dawn after storm", alternateQuery: "sunrise" },
    { start: 2, end: 2, description: "Bước đi", query: "walker crossing mountain path", alternateQuery: "walking" },
  ] });
  h.setResults(new Map([["sunrise", [clip(5, "sunrise")]]]));
  const planner = await h.entry("lib/stock-scenes.ts");
  const script = "Sau cơn mưa, trời sáng. Chúng ta bước về phía trước.";
  const result = await planner.planStockScenes("secret", { script, aspectRatio: "16:9" }, async () => {});
  assert.equal(result.scenes[0].video.id, 5);
  assert.equal(result.scenes[1].video, null);
  assert.match(result.scenes[1].warning, /thay cảnh/);
  assert.ok(h.calls.some(call => call[1] === "sunrise"));
  assert.ok(h.calls.some(call => call[1] === "walking"));
});

test("sentence splitting preserves approved punctuation, line breaks, and long comma clauses byte-for-byte", async () => {
  const h = await fixture();
  const planner = await h.entry("lib/stock-scenes.ts");
  const multiline = "\n  Lời đầu tiên!\nLời thứ hai có nhịp nghỉ; lời cuối cùng?  ";
  assert.equal(planner.validStockScript(multiline), multiline);
  const units = planner.scriptUnits(multiline);
  assert.ok(units.length > 1);
  assert.equal(units.join(""), multiline);
  const longScript = `${"Một ý tưởng dài, ".repeat(28)}một đoạn kết.`;
  const longUnits = planner.scriptUnits(longScript);
  assert.ok(longUnits.length > 1);
  assert.ok(longUnits.length <= 6);
  assert.equal(longUnits.join(""), longScript);
});

test("repeated scene searches share one cached request and prefer different usable clips", async () => {
  const h = await fixture();
  h.setPlan({ scenes: [
    { start: 1, end: 1, description: "Nhân vật bắt đầu", query: "person walking road", alternateQuery: "person walking" },
    { start: 2, end: 2, description: "Nhân vật tiếp tục", query: "person walking road", alternateQuery: "person walking" },
  ] });
  h.setResults(new Map([["person walking road", [clip(11, "walking road person"), clip(12, "walking road person")]]]));
  const planner = await h.entry("lib/stock-scenes.ts");
  const result = await planner.planStockScenes("secret", { script: "Tôi bắt đầu bước đi. Tôi tiếp tục trên con đường ấy.", aspectRatio: "9:16" }, async () => {});
  assert.deepEqual(Array.from(result.scenes, scene => scene.video.id), [11, 12]);
  assert.equal(h.calls.filter(call => call[0] === "pixabay").length, 1);
});

test("invalid scene coverage, unauthorized request, and invalid ratio never search Pixabay", async () => {
  process.env.PIXABAY_API_KEY = "pixabay-private";
  const h = await fixture();
  const route = await h.entry("app/api/pixabay/scenes/route.ts");
  h.setSignedIn(false);
  assert.equal((await route.POST(h.request({ script: "Kịch bản đủ dài cho thử nghiệm." }))).status, 401);
  h.setSignedIn(true);
  assert.equal((await route.POST(h.request({ script: "Kịch bản đủ dài cho thử nghiệm.", aspectRatio: "4:3" }))).status, 400);
  assert.equal((await route.POST(h.request({ script: "Kịch bản đủ dài cho thử nghiệm." }, "https://evil.example"))).status, 403);
  assert.equal(h.calls.filter(call => call[0] === "pixabay").length, 0);
  h.setPlan({ scenes: [{ start: 2, end: 2, description: "Sai", query: "person walking", alternateQuery: "walking" }] });
  const bad = await route.POST(h.request({ script: "Một câu thứ nhất. Và câu thứ hai." }));
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).code, "INVALID_SCENE_PLAN");
  assert.equal(h.calls.filter(call => call[0] === "pixabay").length, 0);
});
