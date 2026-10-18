import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const admin = "11111111-1111-4111-8111-111111111111";
const alice = "22222222-2222-4222-8222-222222222222";
const bob = "33333333-3333-4333-8333-333333333333";
const privatePrompt = "Mở đầu bằng một câu hỏi gần gũi. Dùng trải nghiệm thật do người dùng cung cấp. Kết thúc bằng lời mời nhẹ nhàng, không nói quá công dụng.";
const fields = (title, prompt = privatePrompt) => ({ title, prompt, description: "Một góc nhìn hữu ích" });

async function fixture() {
  const rows = new Map();
  const builtinRows = new Map();
  const charges = [];
  const providerCalls = [];
  const logs = [];
  const members = new Map([[admin, { role: "admin", enabled: true }], [alice, { role: "member", enabled: true }], [bob, { role: "member", enabled: true }]]);
  let identity = admin;
  let providerScript = "Đây là một lời thoại ngắn gọn, đúng thông tin đã cung cấp.";

  const modulePath = name => path.join(root, name);
  const scriptTemplates = modulePath("lib/script-templates.ts");
  const scriptGeneration = modulePath("lib/script-generation.ts");
  const studioServer = modulePath("lib/studio-server.ts");
  const studioSupabase = modulePath("lib/studio-supabase.ts");
  const studioProfile = modulePath("lib/studio-profile.ts");

  // The in-memory table models the table's RLS: enabled members see shared and
  // their own rows; only the owner can mutate a personal row or an admin's shared row.
  class Query {
    constructor(action = "select", values = null) {
      this.action = action;
      this.values = values;
      this.filters = [];
      this.selected = "*";
      this.max = Infinity;
    }
    select(value) { this.selected = value; return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    order() { return this; }
    limit(value) { this.max = value; return this; }
    insert(values) { return new Query("insert", values); }
    update(values) { return new Query("update", values); }
    delete() { return new Query("delete"); }
    maybeSingle() { const result = this.execute(); return Promise.resolve({ data: result.data[0] || null, error: result.error }); }
    single() { const result = this.execute(); return Promise.resolve({ data: result.data[0] || null, error: result.error }); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    execute() {
      const member = members.get(identity);
      if (!member?.enabled) return { data: [], error: null };
      const matches = row => this.filters.every(([key, value]) => row[key] === value);
      const visible = row => row.scope === "shared" || row.owner_id === identity;
      const mutable = row => row.owner_id === identity && (row.scope === "personal" || member.role === "admin");
      const project = row => this.selected === "id" ? { id: row.id } : structuredClone(row);
      if (this.action === "insert") {
        const row = { description: "", sort_order: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...this.values };
        if (row.owner_id !== identity || (row.scope === "shared" && member.role !== "admin")) return { data: [], error: { code: "42501" } };
        rows.set(row.id, row);
        return { data: [project(row)], error: null };
      }
      const candidates = [...rows.values()].filter(row => visible(row) && matches(row));
      if (this.action === "select") return { data: candidates.slice(0, this.max).map(project), error: null };
      const changes = candidates.filter(mutable);
      if (this.action === "update") {
        const updated = changes.map(row => {
          Object.assign(row, this.values);
          return project(row);
        });
        return { data: updated, error: null };
      }
      if (this.action === "delete") {
        for (const row of changes) rows.delete(row.id);
        return { data: changes.map(project), error: null };
      }
      throw new Error(`Unexpected query action ${this.action}`);
    }
  }

  class BuiltinQuery {
    constructor(action = "select", values = null) {
      this.action = action;
      this.values = values;
      this.filters = [];
    }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    upsert(values, { onConflict }) { assert.equal(onConflict, "format"); return new BuiltinQuery("upsert", values); }
    maybeSingle() { const result = this.execute(); return Promise.resolve({ data: result.data[0] || null, error: result.error }); }
    single() { return this.maybeSingle(); }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    execute() {
      const member = members.get(identity);
      if (!member?.enabled) return { data: [], error: null };
      if (this.action === "upsert") {
        if (member.role !== "admin" || this.values.owner_id !== identity)
          return { data: [], error: { code: "42501" } };
        const row = { ...this.values };
        builtinRows.set(row.format, row);
        return { data: [structuredClone(row)], error: null };
      }
      const data = [...builtinRows.values()].filter(row => this.filters.every(([key, value]) => row[key] === value));
      return { data: structuredClone(data), error: null };
    }
  }

  const serverMock = {
    getMember: async userId => {
      if (userId !== identity || !members.get(userId)?.enabled) throw new Error("Member unavailable");
      return members.get(userId);
    },
    requireAdmin: async userId => {
      if (userId !== identity || members.get(userId)?.role !== "admin" || !members.get(userId)?.enabled)
        throw Object.assign(new Error("Chỉ quản trị viên được quản lý dạng kịch bản."), { code: "ADMIN_REQUIRED", status: 403 });
      return members.get(userId);
    },
    requestUser: async (request, mutation = false) => {
      if (!identity) throw Object.assign(new Error("Đăng nhập để tiếp tục."), { code: "AUTH_REQUIRED", status: 401 });
      if (!members.get(identity)?.enabled) throw Object.assign(new Error("Tài khoản chưa được bật."), { code: "MEMBER_DISABLED", status: 403 });
      if (mutation && request.headers.get("origin") !== new URL(request.url).origin)
        throw Object.assign(new Error("Nguồn yêu cầu không hợp lệ."), { code: "INVALID_ORIGIN", status: 403 });
      return identity;
    },
    limitedJson: async (request, maxBytes) => {
      const text = await request.text();
      if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error("Quá dung lượng."), { code: "PAYLOAD_TOO_LARGE", status: 413 });
      return JSON.parse(text);
    },
    json: (data, status = 200) => Response.json(data, { status }),
    apiError: error => Response.json({ code: error.code, error: error.message }, { status: error.status || 500 }),
    providerKey: async (_userId, provider) => {
      assert.equal(provider, "deepseek");
      return { key: "offline-deepseek-key" };
    },
    consumeAiUnits: async (userId, amount) => charges.push({ userId, amount }),
    modelNames: () => ({ deepseekModel: "deepseek-flash" }),
    providerResponse: async response => response,
  };
  const mocks = new Map([
    [studioServer, serverMock],
    [studioSupabase, { createStudioSupabaseServer: async () => ({ from: table => {
      if (table === "studio_script_templates") return new Query();
      if (table === "studio_script_builtin_styles") return new BuiltinQuery();
      assert.fail(`Unexpected table ${table}`);
    } }) }],
    [studioProfile, { projectProfile: async () => ({ channel: "Cửa hàng của tôi", tone: "Chân thành" }) }],
  ]);
  const context = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, AbortSignal,
    Buffer, TextEncoder, TextDecoder, crypto: webcrypto,
    process: { env: { STUDIO_ENCRYPTION_KEY: "offline-encryption-key-with-at-least-32-characters" } },
    console: { info: value => logs.push(value), warn: () => {}, error: () => {} },
    fetch: async (url, init) => {
      providerCalls.push({ url: String(url), init });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ script: providerScript }) } }] });
    },
  });
  const modules = new Map();
  const synthetics = new Map();
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = await fs.readFile(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    modules.set(file, module);
    return module;
  }
  async function linker(specifier, parent) {
    const file = specifier === "server-only" ? specifier : specifier.startsWith("@/")
      ? `${modulePath(specifier.slice(2))}.ts`
      : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
    if (file === "server-only" || mocks.has(file)) {
      if (synthetics.has(file)) return synthetics.get(file);
      const values = mocks.get(file) || {};
      const synthetic = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context, identifier: file });
      synthetics.set(file, synthetic);
      return synthetic;
    }
    return load(file);
  }
  async function entry(name) {
    const file = modulePath(name);
    const module = await load(file);
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  const request = (route, method, body, origin = "https://app.example") => new Request(`https://app.example${route}`, {
    method, headers: { Origin: origin, "Content-Type": "application/json" },
    ...(["GET", "DELETE"].includes(method) ? {} : { body: JSON.stringify(body) }),
  });
  return {
    entry, request, rows, builtinRows, charges, providerCalls, logs, members,
    as(userId) { identity = userId; },
    setScript(script) { providerScript = script; },
  };
}

test("admin shared prompt is encrypted at rest and omitted from a member's template API", async () => {
  const h = await fixture();
  const route = await h.entry("app/api/script-templates/route.ts");
  const created = await route.POST(h.request("/api/script-templates", "POST", { ...fields("Review sản phẩm"), format: "story" }));
  assert.equal(created.status, 201);
  const adminTemplate = (await created.json()).template;
  assert.equal(adminTemplate.scope, "shared");
  assert.equal(adminTemplate.format, "custom");
  assert.equal(adminTemplate.prompt, privatePrompt);
  const saved = h.rows.get(adminTemplate.id);
  assert.match(saved.prompt_ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify(saved).includes(privatePrompt));
  h.as(alice);
  const response = await route.GET(h.request("/api/script-templates", "GET"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.templates.length, 1);
  assert.equal(body.templates[0].title, "Review sản phẩm");
  assert.equal(body.templates[0].prompt, undefined);
  assert.ok(!JSON.stringify(body).includes("prompt_ciphertext"));
  h.as(admin);
  assert.equal((await (await route.GET(h.request("/api/script-templates", "GET"))).json()).templates[0].prompt, privatePrompt);
});

test("four built-in types belong to admin; member uses the saved private prompt without seeing or editing it", async () => {
  const h = await fixture();
  const listRoute = await h.entry("app/api/script-templates/route.ts");
  const builtinRoute = await h.entry("app/api/script-builtins/[format]/route.ts");
  const generate = await h.entry("app/api/script-generate/route.ts");
  const defaults = (await (await listRoute.GET(h.request("/api/script-templates", "GET"))).json()).builtins;
  assert.deepEqual(defaults.map(item => item.format), ["review", "story", "tips", "sales"]);
  assert.ok(defaults.every(item => item.prompt === ""));
  const context = format => ({ params: Promise.resolve({ format }) });
  const updated = await builtinRoute.PATCH(h.request("/api/script-builtins/review", "PATCH", fields("Review theo vấn đề")), context("review"));
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).builtin.prompt, privatePrompt);
  assert.equal(h.builtinRows.get("review").title, "Review theo vấn đề");
  assert.match(h.builtinRows.get("review").prompt_ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify(h.builtinRows.get("review")).includes(privatePrompt));

  h.as(alice);
  const memberList = (await (await listRoute.GET(h.request("/api/script-templates", "GET"))).json()).builtins;
  assert.equal(memberList.find(item => item.format === "review").title, "Review theo vấn đề");
  assert.ok(memberList.every(item => item.prompt === undefined));
  assert.ok(!JSON.stringify(memberList).includes(privatePrompt));
  assert.equal((await builtinRoute.PATCH(h.request("/api/script-builtins/review", "PATCH", fields("Cố sửa")), context("review"))).status, 403);
  assert.equal((await builtinRoute.PATCH(h.request("/api/script-builtins/fake", "PATCH", fields("Cố sửa")), context("fake"))).status, 403);
  const response = await generate.POST(h.request("/api/script-generate", "POST", {
    format: "review", title: "Cây giống", brief: "Giới thiệu cây giống cho người mới trồng ban công.", durationSeconds: 30,
  }));
  assert.equal(response.status, 200);
  assert.equal(h.charges.length, 1);
  const payload = JSON.parse(h.providerCalls[0].init.body);
  assert.ok(payload.messages[0].content.includes(privatePrompt));
  assert.ok(payload.messages[0].content.includes("Review theo vấn đề"));
  assert.match(payload.messages[0].content, /đừng chỉ tường thuật/i);
  assert.match(payload.messages[0].content, /không tự nhận đã dùng sản phẩm/i);
  assert.ok(!payload.messages[1].content.includes(privatePrompt));
  assert.ok(h.logs.every(line => !line.includes(privatePrompt)));
});

test("members can edit/delete only their personal script types; shared and foreign types resist mutation", async () => {
  const h = await fixture();
  const listRoute = await h.entry("app/api/script-templates/route.ts");
  const itemRoute = await h.entry("app/api/script-templates/[id]/route.ts");
  const shared = (await (await listRoute.POST(h.request("/api/script-templates", "POST", fields("Mẫu quản trị")))).json()).template;
  h.as(alice);
  const created = await listRoute.POST(h.request("/api/script-templates", "POST", fields("Mẫu của Alice", "Kể chuyện thật, không bịa thông tin.")));
  assert.equal(created.status, 201);
  const personal = (await created.json()).template;
  assert.equal(personal.scope, "personal");
  assert.equal(personal.format, "custom");
  assert.equal(personal.prompt, "Kể chuyện thật, không bịa thông tin.");
  const context = id => ({ params: Promise.resolve({ id }) });
  const edited = await itemRoute.PATCH(h.request(`/api/script-templates/${personal.id}`, "PATCH", fields("Alice đã sửa", "Viết ba mẹo ngắn.")), context(personal.id));
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).template.title, "Alice đã sửa");
  assert.equal(h.rows.get(personal.id).format, "custom");
  const blockedShared = await itemRoute.PATCH(h.request(`/api/script-templates/${shared.id}`, "PATCH", fields("Cố sửa mẫu quản trị")), context(shared.id));
  assert.equal(blockedShared.status, 403);
  assert.equal((await itemRoute.DELETE(h.request(`/api/script-templates/${shared.id}`, "DELETE"), context(shared.id))).status, 403);
  h.as(bob);
  assert.equal((await (await listRoute.GET(h.request("/api/script-templates", "GET"))).json()).templates.length, 1);
  assert.equal((await itemRoute.PATCH(h.request(`/api/script-templates/${personal.id}`, "PATCH", fields("Bob cố sửa")), context(personal.id))).status, 404);
  assert.equal((await itemRoute.DELETE(h.request(`/api/script-templates/${personal.id}`, "DELETE"), context(personal.id))).status, 404);
  h.as(alice);
  assert.equal((await itemRoute.DELETE(h.request(`/api/script-templates/${personal.id}`, "DELETE"), context(personal.id))).status, 200);
  assert.equal(h.rows.has(personal.id), false);
  assert.equal(h.rows.get(shared.id).title, "Mẫu quản trị");
});

test("script generation uses a custom type privately, charges once, and keeps legacy no-template mode", async () => {
  const h = await fixture();
  const listRoute = await h.entry("app/api/script-templates/route.ts");
  const generate = await h.entry("app/api/script-generate/route.ts");
  const shared = (await (await listRoute.POST(h.request("/api/script-templates", "POST", fields("Review uy tín")))).json()).template;
  // Existing data may still carry one of the four formats from the old UI.
  h.rows.get(shared.id).format = "review";
  h.as(alice);
  const input = { templateId: shared.id, format: "sales", title: "Nho tươi", brief: "Giới thiệu chùm nho có trong ảnh cho khách mới.", durationSeconds: 30 };
  const first = await generate.POST(h.request("/api/script-generate", "POST", input));
  assert.equal(first.status, 200);
  assert.match((await first.json()).script, /lời thoại/);
  assert.deepEqual(h.charges, [{ userId: alice, amount: 1 }]);
  const payload = JSON.parse(h.providerCalls[0].init.body);
  assert.equal(h.providerCalls[0].url, "https://api.deepseek.com/chat/completions");
  assert.ok(payload.messages[0].content.includes(privatePrompt));
  assert.ok(payload.messages[0].content.includes("Review uy tín"));
  assert.ok(!payload.messages[1].content.includes(privatePrompt));
  assert.ok(h.logs.every(line => !line.includes(privatePrompt)));
  const second = await generate.POST(h.request("/api/script-generate", "POST", { ...input, templateId: undefined }));
  assert.equal(second.status, 200);
  assert.equal(h.charges.length, 2);
  assert.ok(!JSON.parse(h.providerCalls[1].init.body).messages[0].content.includes(privatePrompt));
});

test("generation rejects foreign personal types but ignores an old format when a type is selected", async () => {
  const h = await fixture();
  const listRoute = await h.entry("app/api/script-templates/route.ts");
  const generate = await h.entry("app/api/script-generate/route.ts");
  h.as(alice);
  const personal = (await (await listRoute.POST(h.request("/api/script-templates", "POST", fields("Kể chuyện")))).json()).template;
  const base = { templateId: personal.id, format: "story", title: "Một câu chuyện", brief: "Chia sẻ trải nghiệm thật của cửa hàng.", durationSeconds: 20 };
  h.as(bob);
  const denied = await generate.POST(h.request("/api/script-generate", "POST", base));
  assert.equal(denied.status, 404);
  h.as(alice);
  assert.equal(h.charges.length, 0);
  assert.equal(h.providerCalls.length, 0);
  const oldFormat = await generate.POST(h.request("/api/script-generate", "POST", { ...base, format: "review" }));
  assert.equal(oldFormat.status, 200);
  assert.equal(h.charges.length, 1);
  assert.equal(h.providerCalls.length, 1);
});

test("provider output copying a private template is withheld after one charged attempt", async () => {
  const h = await fixture();
  const listRoute = await h.entry("app/api/script-templates/route.ts");
  const generate = await h.entry("app/api/script-generate/route.ts");
  const shared = (await (await listRoute.POST(h.request("/api/script-templates", "POST", fields("Review an toàn")))).json()).template;
  h.as(alice);
  h.setScript(`Đây là hướng dẫn: ${privatePrompt}`);
  const response = await generate.POST(h.request("/api/script-generate", "POST", {
    templateId: shared.id, format: "review", title: "Nho tươi", brief: "Giới thiệu sản phẩm thực tế cho khách hàng.", durationSeconds: 30,
  }));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, "TEMPLATE_PROMPT_DISCLOSED");
  assert.ok(!JSON.stringify(body).includes(privatePrompt));
  assert.deepEqual(h.charges, [{ userId: alice, amount: 1 }]);
});
