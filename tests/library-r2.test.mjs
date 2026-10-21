import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

async function fixture() {
  const rows = new Map();
  let identity = alice, signCalls = 0, headCalls = 0, deleteCalls = 0;
  let object = { sizeBytes: 1_000_000, mimeType: "video/mp4", mp4: true };
  class StudioError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  const database = {
    async rpc(name, params) {
      assert.equal(name, "reserve_library_video_upload");
      const now = new Date();
      const existing = [...rows.values()].find(row => row.user_id === params.p_user_id && row.request_id === params.p_request_id);
      if (existing) {
        if (existing.size_bytes !== params.p_size_bytes || existing.kind !== "video") return { data: { outcome: "conflict" }, error: null };
        if (new Date(existing.expires_at) > now) return { data: { outcome: existing.status, asset: { ...existing } }, error: null };
      }
      const active = [...rows.values()].filter(row => row.user_id === params.p_user_id && row.kind === "video" && ["ready", "uploading"].includes(row.status) && new Date(row.expires_at) > now);
      if (active.length >= 500) return { data: { outcome: "file_limit" }, error: null };
      if (active.reduce((sum, row) => sum + row.size_bytes, 0) + params.p_size_bytes > 1024 * 1024 * 1024)
        return { data: { outcome: "quota_exceeded" }, error: null };
      const id = existing?.id || crypto.randomUUID();
      const asset = {
        id, user_id: params.p_user_id, kind: "video", provider: "r2",
        storage_path: `${params.p_user_id}/videos/${id}.mp4`, title: params.p_title,
        mime_type: "video/mp4", size_bytes: params.p_size_bytes,
        duration_seconds: params.p_duration_seconds, status: "uploading", request_id: params.p_request_id,
        created_at: now.toISOString(), updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 86400_000).toISOString(),
      };
      rows.set(id, asset);
      return { data: { outcome: "created", asset: { ...asset } }, error: null };
    },
    from() {
      let filters = [], action = "select", input = null, count = false, limit = Infinity;
      const builder = {
        select(_cols, options) { count = Boolean(options?.count); return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        gt(key, value) { filters.push(row => row[key] > value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        order() { return this; },
        limit(value) { limit = value; return this; },
        insert(value) { action = "insert"; input = value; return this; },
        update(value) { action = "update"; input = value; return this; },
        delete() { action = "delete"; return this; },
        maybeSingle() { return run(true); },
        single() { return run(true); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
      async function run(single) {
        if (action === "insert") {
          if ([...rows.values()].some(row => row.user_id === input.user_id && row.request_id && row.request_id === input.request_id)) return { data: null, error: { code: "23505" } };
          rows.set(input.id, { ...input }); return { data: { ...input }, error: null };
        }
        const found = [...rows.values()].filter(row => filters.every(filter => filter(row)));
        if (action === "update") { for (const row of found) Object.assign(row, input); return { data: single ? found[0] || null : found, error: null }; }
        if (action === "delete") { for (const row of found) rows.delete(row.id); return { data: null, error: null }; }
        return { data: single ? found[0] || null : found.slice(0, limit), count: count ? found.length : null, error: null };
      }
      return builder;
    },
  };
  const r2 = {
    LIBRARY_VIDEO_DAYS: 7,
    LIBRARY_VIDEO_MAX_BYTES: 500 * 1024 * 1024,
    LIBRARY_VIDEO_QUOTA_BYTES: 1024 * 1024 * 1024,
    assertR2Configured: () => {},
    libraryDatabase: () => database,
    assertOwnedLibraryAsset: (userId, asset) => {
      if (asset.user_id !== userId || !asset.storage_path.startsWith(`${userId}/`)) throw new StudioError("LIBRARY_NOT_AUTHORIZED", "Forbidden", 403);
      return asset;
    },
    validLibraryRequestId: value => value || null,
    signedVideoUpload: async () => { signCalls++; return "https://r2.example.invalid/signed-put"; },
    checkVideoObject: async () => { headCalls++; return object; },
    deleteVideoObject: async () => { deleteCalls++; },
    ownedLibraryAsset: async (userId, id) => {
      const row = rows.get(id);
      if (!row || row.user_id !== userId) throw new StudioError("LIBRARY_ITEM_NOT_FOUND", "Not found", 404);
      return row;
    },
    signedVideoDownload: async (_path, name) => name ? "https://r2.example.invalid/attachment" : "https://r2.example.invalid/inline",
  };
  const server = {
    requestUser: async (request, mutation) => {
      if (!identity) throw new StudioError("SIGN_IN_REQUIRED", "Sign in", 401);
      if (mutation && request.headers.get("origin") !== new URL(request.url).origin) throw new StudioError("INVALID_ORIGIN", "Origin", 403);
      return identity;
    },
    limitedJson: async request => request.json(),
    json: (value, status = 200) => Response.json(value, { status }),
    apiError: error => Response.json({ code: error.code, error: error.message }, { status: error.status || 500 }),
  };
  const mocks = new Map([
    [path.join(root, "lib/studio-server.ts"), server],
    [path.join(root, "lib/studio-contract.ts"), { StudioError }],
    [path.join(root, "lib/r2.ts"), r2],
    [path.join(root, "lib/studio-supabase.ts"), { STUDIO_MEDIA_BUCKET: "studio-media" }],
  ]);
  const context = vm.createContext({ Request, Response, URL, Date, crypto: globalThis.crypto });
  const modules = new Map(), synthetics = new Map();
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    modules.set(file, module);
    return module;
  }
  async function linker(specifier, parent) {
    const file = specifier.startsWith("@/") ? path.join(root, `${specifier.slice(2)}.ts`) : path.resolve(path.dirname(parent.identifier), `${specifier}.ts`);
    if (mocks.has(file)) {
      if (!synthetics.has(file)) {
        const values = mocks.get(file);
        synthetics.set(file, new vm.SyntheticModule(Object.keys(values), function () {
          for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context }));
      }
      return synthetics.get(file);
    }
    return load(file);
  }
  async function entry(relativePath) {
    const module = await load(path.join(root, relativePath));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  const post = (url, body) => new Request(url, { method: "POST", headers: { origin: "https://ibeetool.com", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    entry, rows, post,
    setIdentity(value) { identity = value; },
    setObject(value) { object = value; },
    get signCalls() { return signCalls; },
    get headCalls() { return headCalls; },
    get deleteCalls() { return deleteCalls; },
  };
}

test("upload reserves one private asset and retries never create a second file", async () => {
  const h = await fixture();
  const route = await h.entry("app/api/library/videos/upload/route.ts");
  const body = { title: "Video mới", mimeType: "video/mp4", sizeBytes: 1_000_000, durationSeconds: 30, requestId };
  const url = "https://ibeetool.com/api/library/videos/upload";
  const first = await route.POST(h.post(url, body));
  assert.equal(first.status, 201);
  assert.equal((await first.json()).headers["Content-Type"], "video/mp4");
  assert.equal(h.rows.size, 1);
  const second = await route.POST(h.post(url, body));
  assert.equal(second.status, 200);
  assert.equal(h.rows.size, 1);
  assert.equal(h.signCalls, 2);
  const asset = [...h.rows.values()][0];
  assert.ok(asset.storage_path.startsWith(`${alice}/videos/`));
  assert.ok(Date.parse(asset.expires_at) - Date.parse(asset.created_at) === 7 * 86400_000);
  asset.status = "ready";
  const third = await route.POST(h.post(url, body));
  assert.equal((await third.json()).alreadySaved, true);
  assert.equal(h.signCalls, 2);
});

test("simultaneous upload reservations cannot exceed one user's 1 GB quota", async () => {
  const h = await fixture();
  const route = await h.entry("app/api/library/videos/upload/route.ts");
  const url = "https://ibeetool.com/api/library/videos/upload";
  const responses = await Promise.all(Array.from({ length: 3 }, () => route.POST(h.post(url, {
    title: "Video đồng thời", mimeType: "video/mp4", sizeBytes: 500 * 1024 * 1024,
    durationSeconds: 30, requestId: crypto.randomUUID(),
  }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 201, 413]);
  assert.equal(h.rows.size, 2);
  assert.ok([...h.rows.values()].reduce((total, row) => total + row.size_bytes, 0) <= 1024 * 1024 * 1024);
});

test("completion rejects incomplete or forged media, then accepts matching MP4", async () => {
  const h = await fixture();
  const upload = await h.entry("app/api/library/videos/upload/route.ts");
  const complete = await h.entry("app/api/library/videos/[id]/complete/route.ts");
  const created = await upload.POST(h.post("https://ibeetool.com/api/library/videos/upload", { title: "Video", mimeType: "video/mp4", sizeBytes: 1_000_000, durationSeconds: 30, requestId }));
  const { asset } = await created.json();
  const ctx = { params: Promise.resolve({ id: asset.id }) };
  h.setObject({ sizeBytes: 999_999, mimeType: "video/mp4", mp4: true });
  let result = await complete.POST(h.post(`https://ibeetool.com/api/library/videos/${asset.id}/complete`, {}), ctx);
  assert.equal(result.status, 422);
  assert.equal(h.deleteCalls, 1);
  assert.equal(h.rows.get(asset.id).status, "uploading");
  h.setObject({ sizeBytes: 1_000_000, mimeType: "video/mp4", mp4: true });
  result = await complete.POST(h.post(`https://ibeetool.com/api/library/videos/${asset.id}/complete`, {}), ctx);
  assert.equal(result.status, 200);
  assert.equal(h.rows.get(asset.id).status, "ready");
});

test("another member cannot complete or obtain signed URL for a private video", async () => {
  const h = await fixture();
  const upload = await h.entry("app/api/library/videos/upload/route.ts");
  const complete = await h.entry("app/api/library/videos/[id]/complete/route.ts");
  const signed = await h.entry("app/api/library/[id]/url/route.ts");
  const created = await upload.POST(h.post("https://ibeetool.com/api/library/videos/upload", { title: "Video", mimeType: "video/mp4", sizeBytes: 1_000_000, durationSeconds: 30, requestId }));
  const { asset } = await created.json();
  h.setIdentity(bob);
  const result = await complete.POST(h.post(`https://ibeetool.com/api/library/videos/${asset.id}/complete`, {}), { params: Promise.resolve({ id: asset.id }) });
  assert.equal(result.status, 404);
  assert.equal(h.headCalls, 0);
  const url = await signed.GET(new Request(`https://ibeetool.com/api/library/${asset.id}/url`), { params: Promise.resolve({ id: asset.id }) });
  assert.equal(url.status, 404);
});

test("R2 helper rejects a forged asset path and signs the expected PUT length", async () => {
  class StudioError extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status; }
  }
  class Command { constructor(input) { this.input = input; } }
  let signed;
  const mocks = new Map([
    ["server-only", {}],
    ["@aws-sdk/client-s3", {
      DeleteObjectCommand: Command, GetObjectCommand: Command,
      HeadObjectCommand: Command, PutObjectCommand: Command,
      S3Client: class { constructor(config) { this.config = config; } },
    }],
    ["@aws-sdk/s3-request-presigner", {
      getSignedUrl: async (_client, command, options) => { signed = { command, options }; return "https://r2.example.invalid/signed"; },
    }],
    ["@supabase/supabase-js", { createClient: () => ({}) }],
    ["./studio-contract", { StudioError }],
  ]);
  const context = vm.createContext({
    process: { env: { R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "ibeetool-videos" } },
    TextDecoder, URL, crypto: globalThis.crypto,
  });
  const source = await fs.readFile(path.join(root, "lib/r2.ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = new vm.SourceTextModule(code, { context });
  await module.link(specifier => {
    const values = mocks.get(specifier);
    assert.ok(values, `unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const { assertOwnedLibraryAsset, signedVideoUpload } = module.namespace;
  const asset = { id: requestId, user_id: alice, kind: "video", provider: "r2", storage_path: `${alice}/videos/${requestId}.mp4` };
  assert.equal(assertOwnedLibraryAsset(alice, asset), asset);
  assert.throws(() => assertOwnedLibraryAsset(bob, asset), { code: "LIBRARY_NOT_AUTHORIZED" });
  assert.throws(() => assertOwnedLibraryAsset(alice, { ...asset, storage_path: `${alice}/voice-samples/clone.mp3` }), { code: "INVALID_LIBRARY_ITEM" });
  await signedVideoUpload(asset.storage_path, 1_000_000);
  assert.equal(signed.command.input.ContentLength, 1_000_000);
  assert.equal(signed.command.input.ContentType, "video/mp4");
  assert.ok(signed.options.signableHeaders.has("content-length"));
  assert.ok(signed.options.signableHeaders.has("content-type"));
});
