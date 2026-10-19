import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const validHit = {
  id: 125,
  pageURL: "https://pixabay.com/videos/id-125/",
  tags: "flowers, yellow",
  duration: 12,
  user: "Creator",
  videos: {
    medium: { url: "https://cdn.pixabay.com/video/125_medium.mp4", width: 1920, height: 1080, size: 8, thumbnail: "https://cdn.pixabay.com/video/125_medium.jpg" },
    small: { url: "https://cdn.pixabay.com/video/125_small.mp4", width: 1280, height: 720, size: 5, thumbnail: "https://cdn.pixabay.com/video/125_small.jpg" },
  },
};

async function fixture() {
  let authorized = true;
  let fetchMock = async () => { throw new Error("Unexpected fetch"); };
  const calls = [];
  class StudioError extends Error {
    constructor(code, message, status = 400, action) { super(message); this.code = code; this.status = status; this.action = action; }
  }
  const server = {
    requestUser: async (_request, mutation = false) => {
      calls.push(["auth", mutation]);
      if (!authorized) throw new StudioError("SIGN_IN_REQUIRED", "Đăng nhập.", 401);
      if (mutation && _request.headers.get("origin") !== new URL(_request.url).origin) throw new StudioError("INVALID_ORIGIN", "Nguồn yêu cầu không hợp lệ.", 403);
      return "user-1";
    },
    limitedJson: request => request.json(),
    json: (value, status = 200) => Response.json(value, { status }),
    apiError: error => Response.json({ code: error.code ?? "INTERNAL_ERROR", error: error.message }, { status: error.status ?? 500 }),
  };
  const context = vm.createContext({
    URL, URLSearchParams, Response, Request, AbortSignal, ReadableStream, TextDecoder,
    process, console,
    fetch: (...args) => { calls.push(["fetch", ...args]); return fetchMock(...args); },
  });
  const modules = new Map();
  const stubs = new Map([
    ["server-only", {}],
    [path.join(root, "lib/studio-contract.ts"), { StudioError }],
    [path.join(root, "lib/studio-server.ts"), server],
  ]);
  const entryPath = name => path.join(root, name);
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    if (stubs.has(file)) {
      const values = stubs.get(file);
      const module = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context, identifier: file });
      modules.set(file, module);
      return module;
    }
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    modules.set(file, module);
    return module;
  }
  async function linker(specifier, parent) {
    const file = specifier === "server-only" ? specifier : specifier.startsWith("@/")
      ? entryPath(`${specifier.slice(2)}.ts`)
      : path.resolve(path.dirname(parent.identifier), `${specifier}.ts`);
    return load(file);
  }
  async function entry(name) {
    const module = await load(entryPath(name));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  return {
    entry, calls,
    setFetch(fn) { fetchMock = fn; },
    setAuthorized(value) { authorized = value; },
    request(route, method = "GET", body) {
      return new Request(`https://app.example${route}`, {
        method,
        ...(method === "POST" ? { headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    },
  };
}

test("search authenticates before calling Pixabay, keeps its key private, and caches for 24 hours", async () => {
  process.env.PIXABAY_API_KEY = "test-secret-search";
  const h = await fixture();
  h.setFetch(async (url, options) => {
    assert.equal(new URL(url).searchParams.get("key"), "test-secret-search");
    assert.equal(options.cache, "force-cache");
    assert.equal(options.next.revalidate, 86400);
    assert.equal(options.redirect, "error");
    return Response.json({ total: 1, totalHits: 1, hits: [validHit] });
  });
  const route = await h.entry("app/api/pixabay/videos/route.ts");
  h.setAuthorized(false);
  assert.equal((await route.GET(h.request("/api/pixabay/videos?q=flowers"))).status, 401);
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 0);
  h.setAuthorized(true);
  const first = await route.GET(h.request("/api/pixabay/videos?q=flowers"));
  assert.equal(first.status, 200);
  const data = await first.json();
  assert.equal(data.videos[0].id, 125);
  assert.equal(data.videos[0].videoUrl, validHit.videos.medium.url);
  assert.equal(data.videos[0].pageUrl, validHit.pageURL);
  assert.equal(data.source, "Pixabay");
  assert.ok(!JSON.stringify(data).includes("test-secret-search"));
  assert.equal((await route.GET(h.request("/api/pixabay/videos?q=flowers"))).status, 200);
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 1);
  assert.equal((await route.GET(h.request(`/api/pixabay/videos?q=${"a".repeat(101)}`))).status, 400);
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 1);
});

test("stock-video proxy re-reads the Pixabay ID, streams MP4, and rejects unsafe hosts and oversized media", async () => {
  process.env.PIXABAY_API_KEY = "test-secret-proxy";
  const h = await fixture();
  const body = new Uint8Array([0, 1, 2, 3, 4]);
  h.setFetch(async (url, options) => {
    if (url.startsWith("https://pixabay.com/api/videos/")) {
      assert.equal(new URL(url).searchParams.get("id"), "125");
      return Response.json({ total: 1, totalHits: 1, hits: [validHit] });
    }
    assert.equal(url, validHit.videos.small.url);
    assert.equal(options.redirect, "error");
    return new Response(body, { headers: { "Content-Type": "video/mp4", "Content-Length": String(body.length) } });
  });
  const route = await h.entry("app/api/pixabay/video/route.ts");
  const response = await route.POST(h.request("/api/pixabay/video", "POST", { id: 125, quality: "small" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 2);

  const crossOriginRequest = new Request("https://app.example/api/pixabay/video", {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ id: 125 }),
  });
  assert.equal((await route.POST(crossOriginRequest)).status, 403);
  assert.equal(h.calls.filter(call => call[0] === "fetch").length, 2);

  assert.equal((await route.POST(h.request("/api/pixabay/video", "POST", { id: 125, quality: "wrong" }))).status, 400);
  assert.ok(h.calls.filter(call => call[0] === "auth" && call[1] === true).length >= 2);

  process.env.PIXABAY_API_KEY = "test-secret-host";
  h.setFetch(async url => {
    if (url.startsWith("https://pixabay.com/api/videos/")) return Response.json({ hits: [{ ...validHit, videos: { medium: { ...validHit.videos.medium, url: "https://example.com/private" } } }] });
    throw new Error("An unsafe CDN URL was fetched");
  });
  const unsafe = await route.POST(h.request("/api/pixabay/video", "POST", { id: 125 }));
  assert.equal(unsafe.status, 404);

  process.env.PIXABAY_API_KEY = "test-secret-size";
  h.setFetch(async url => {
    if (url.startsWith("https://pixabay.com/api/videos/")) return Response.json({ hits: [{ ...validHit, videos: { medium: { ...validHit.videos.medium, size: 61 * 1024 * 1024 } } }] });
    throw new Error("Oversized CDN media was fetched");
  });
  assert.equal((await route.POST(h.request("/api/pixabay/video", "POST", { id: 125 }))).status, 413);
});
