import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const owner = "11111111-1111-4111-8111-111111111111";
const secret = "offline-library-cron-secret-0123456789";

async function fixture() {
  const rows = new Map();
  const deleted = [];
  const stuck = new Set();
  const now = Date.now();
  let deleteCalls = 0;
  class StudioError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  const database = {
    from(table) {
      assert.equal(table, "library_assets");
      let action = "select", filters = [], order = [], start = 0, end = 999;
      const query = {
        select() { return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        lte(key, value) { filters.push(row => row[key] <= value); return this; },
        gt(key, value) { filters.push(row => row[key] > value); return this; },
        order(key, options) { order.push([key, options?.ascending]); return this; },
        range(a, b) { start = a; end = b; return execute(); },
        delete() { action = "delete"; return this; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      async function execute() {
        const matching = [...rows.values()].filter(row => filters.every(filter => filter(row)));
        if (action === "delete") {
          for (const row of matching) rows.delete(row.id);
          return { data: null, error: null };
        }
        matching.sort((a, b) => {
          for (const [key, ascending] of order) {
            const diff = String(a[key]).localeCompare(String(b[key]));
            if (diff) return ascending ? diff : -diff;
          }
          return 0;
        });
        return { data: matching.slice(start, end + 1), error: null };
      }
      return query;
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "studio-media");
        return { remove: async paths => {
          deleted.push(...paths);
          return { error: null };
        } };
      },
    },
  };
  const r2 = {
    libraryDatabase: () => database,
    assertOwnedLibraryAsset: (userId, asset) => {
      if (!asset.storage_path.startsWith(`${userId}/`)) throw new StudioError("LIBRARY_NOT_AUTHORIZED", "Bad path", 403);
      return asset;
    },
    deleteVideoObject: async objectPath => {
      deleteCalls++;
      if (stuck.has(objectPath)) throw Object.assign(new Error("R2 unavailable"), { code: "R2_UNAVAILABLE" });
      deleted.push(objectPath);
    },
  };
  const server = {
    apiError: error => Response.json({ code: error.code }, { status: error.status || 500 }),
    json: value => Response.json(value),
  };
  const mocks = new Map([
    [path.join(root, "lib/studio-server.ts"), server],
    [path.join(root, "lib/studio-contract.ts"), { StudioError }],
    [path.join(root, "lib/studio-supabase.ts"), { STUDIO_MEDIA_BUCKET: "studio-media" }],
    [path.join(root, "lib/r2.ts"), r2],
  ]);
  const context = vm.createContext({
    Response, Date, console: { warn() {} },
    process: { env: { CRON_SECRET: secret } },
  });
  const source = await fs.readFile(path.join(root, "app/api/library/scheduled/route.ts"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = new vm.SourceTextModule(code, { context });
  await module.link(specifier => {
    const file = path.join(root, `${specifier.slice(2)}.ts`);
    const values = mocks.get(file);
    assert.ok(values, `unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  function add(index, type = "expired") {
    const id = String(index).padStart(8, "0") + "-1111-4111-8111-111111111111";
    const isAudio = index % 3 === 0;
    const row = {
      id, user_id: owner, kind: isAudio ? "audio" : "video", provider: isAudio ? "supabase" : "r2",
      storage_path: `${owner}/${isAudio ? "narration" : "videos"}/${id}.${isAudio ? "mp3" : "mp4"}`,
      status: type === "abandoned" ? "uploading" : "ready",
      created_at: type === "abandoned" ? new Date(now - 2 * 3600_000).toISOString() : new Date(now - 40 * 86400_000).toISOString(),
      expires_at: type === "abandoned" ? new Date(now + 7 * 86400_000).toISOString() : new Date(now - 86400_000).toISOString(),
    };
    rows.set(id, row);
    return row;
  }
  return {
    add, rows, stuck, deleted,
    run: async authorized => module.namespace.GET({ headers: { get: () => authorized ? `Bearer ${secret}` : "Bearer wrong" } }),
    get deleteCalls() { return deleteCalls; },
  };
}

test("cleanup drains more than one page, including abandoned uploads, while skipping one poisoned row", async () => {
  const h = await fixture();
  for (let i = 1; i <= 270; i++) h.add(i, "expired");
  for (let i = 271; i <= 420; i++) h.add(i, "abandoned");
  const poisoned = h.rows.get("00000002-1111-4111-8111-111111111111");
  h.stuck.add(poisoned.storage_path);
  const response = await h.run(true);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.removed, 419);
  assert.equal(report.failed, 1);
  assert.equal(report.scanned, 420);
  assert.equal(report.partial, false);
  assert.equal(h.rows.size, 1);
  assert.equal([...h.rows.values()][0].id, poisoned.id);
  assert.equal(h.deleted.length, 419);
});

test("cleanup rejects unauthenticated schedule invocation before reading files", async () => {
  const h = await fixture();
  h.add(1);
  const response = await h.run(false);
  assert.equal(response.status, 403);
  assert.equal(h.rows.size, 1);
  assert.equal(h.deleted.length, 0);
});
