import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const voiceId = "maziao:vieten_speech:myClone";

async function fixture() {
  const grants = new Map();
  const requests = [];
  let memberRole = "member";
  let memberEnabled = true;
  let provider = "maziao";
  let catalog = [];
  let providerReply = () => Response.json({ data: { message: "Voice deleted successfully" } });
  let rpcError = null;
  let rpcCalls = 0;
  let released = 0;
  let authUser = alice;
  const key = "offline-secret-for-tests";

  class StudioError extends Error {
    constructor(code, message, status = 500, action) {
      super(message);
      this.code = code;
      this.status = status;
      this.action = action;
    }
  }
  const mockServer = {
    authorizedVoiceRows: async userId => [...grants.values()].filter(row => row.user_id === userId && row.authorization_tag === "signed"),
    getMember: async () => ({ role: memberRole, enabled: memberEnabled }),
    providerKey: async () => ({ key }),
    sharedVoiceCatalog: async () => catalog,
    voiceProvider: () => provider,
    requestUser: async (request, mutation) => {
      assert.equal(mutation, true, "DELETE must use mutation-aware auth and Origin checks");
      if (!authUser) throw new StudioError("AUTH_REQUIRED", "Cần đăng nhập.", 401);
      if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)
        throw new StudioError("INVALID_ORIGIN", "Nguồn yêu cầu không hợp lệ.", 403);
      return authUser;
    },
    json: data => Response.json(data),
    apiError: error => Response.json({ code: error.code, error: error.message }, { status: error.status || 500 }),
  };
  const mocks = new Map([
    [path.join(root, "lib/studio-contract.ts"), { StudioError }],
    [path.join(root, "lib/studio-server.ts"), mockServer],
    [path.join(root, "lib/studio-maziao.ts"), {
      parseMaziaoVoiceId: value => {
        const match = /^maziao:(?:vieten_speech|lingual_speech_v2):([a-zA-Z0-9_-]+)$/.exec(value);
        if (!match) throw new StudioError("INVALID_VOICE", "Giọng không hợp lệ.", 422);
        return { id: match[1] };
      },
    }],
    [path.join(root, "lib/studio-supabase.ts"), {
      createStudioSupabaseServer: async () => ({
        rpc: async (name, { p_voice_id: target }) => {
          assert.equal(name, "release_studio_voice_clone");
          rpcCalls++;
          if (rpcError) return { error: rpcError };
          const record = grants.get(`${alice}:${target}`);
          if (record) { grants.delete(`${alice}:${target}`); released++; }
          return { error: null };
        },
      }),
    }],
  ]);
  const context = vm.createContext({
    console, Request, Response, Headers, URL, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options });
      return providerReply();
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
      ? `${path.join(root, specifier.slice(2))}.ts`
      : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
    if (file === "server-only" || mocks.has(file)) {
      if (synthetics.has(file)) return synthetics.get(file);
      const values = mocks.get(file) || {};
      const synthetic = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
      synthetics.set(file, synthetic);
      return synthetic;
    }
    return load(file);
  }
  async function entry(relativePath) {
    const module = await load(path.join(root, relativePath));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  return {
    entry, grants, requests,
    grant(userId = alice, target = voiceId, source = "personal", signed = true) {
      grants.set(`${userId}:${target}`, { user_id: userId, voice_id: target, source, authorization_tag: signed ? "signed" : "unsigned" });
    },
    setRole(value) { memberRole = value; },
    setEnabled(value) { memberEnabled = value; },
    setProvider(value) { provider = value; },
    setCatalog(value) { catalog = value; },
    setProviderReply(value) { providerReply = value; },
    setRpcError(value) { rpcError = value; },
    setAuthUser(value) { authUser = value; },
    get rpcCalls() { return rpcCalls; },
    get released() { return released; },
    key,
  };
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => error.code === code, `expected ${code}`);
}

test("only an owned signed member clone is removed at Maziao, then releases one saved slot", async () => {
  const h = await fixture(); h.grant();
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  assert.equal((await deleteMemberVoice(alice, voiceId)).success, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://app.maziao.com/api/voices/myClone");
  assert.equal(h.requests[0].method, "DELETE");
  assert.equal(h.requests[0].headers.Authorization, `Bearer ${h.key}`);
  assert.equal(h.rpcCalls, 1);
  assert.equal(h.released, 1);
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "VOICE_NOT_AUTHORIZED");
  assert.equal(h.requests.length, 1, "a repeat request must not call the provider");
  assert.equal(h.released, 1, "a repeat request must not release the slot twice");
});

test("admin, disabled member, shared grant and another member's clone are denied before provider access", async () => {
  const h = await fixture(); h.grant(); h.grant(bob, "maziao:vieten_speech:someoneElse");
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  h.setRole("admin");
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "MEMBER_VOICE_ONLY");
  h.setRole("member"); h.setEnabled(false);
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "MEMBER_VOICE_ONLY");
  h.setEnabled(true);
  await rejectsCode(() => deleteMemberVoice(alice, "maziao:vieten_speech:someoneElse"), "VOICE_NOT_AUTHORIZED");
  h.setCatalog([{ voice_id: voiceId, enabled: true }]);
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "VOICE_SHARED");
  assert.equal(h.requests.length, 0);
  assert.equal(h.rpcCalls, 0);
});

test("unsigned or nonpersonal grants cannot delete a provider voice", async () => {
  const h = await fixture();
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  h.grant(alice, voiceId, "personal", false);
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "VOICE_NOT_AUTHORIZED");
  h.grant(alice, voiceId, "shared", true);
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "VOICE_NOT_AUTHORIZED");
  assert.equal(h.requests.length, 0);
  assert.equal(h.rpcCalls, 0);
});

test("provider rejection keeps the grant and saved slot for retry", async () => {
  const h = await fixture(); h.grant();
  h.setProviderReply(() => new Response(null, { status: 403 }));
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "MAZIAO_AUTH");
  assert.ok(h.grants.has(`${alice}:${voiceId}`));
  assert.equal(h.rpcCalls, 0);
  assert.equal(h.released, 0);
});

test("a provider error inside HTTP 200 must not release the saved voice slot", async () => {
  const h = await fixture(); h.grant();
  h.setProviderReply(() => Response.json({ error: "Voice was not deleted" }));
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "MAZIAO_DELETE_FAILED");
  assert.ok(h.grants.has(`${alice}:${voiceId}`));
  assert.equal(h.rpcCalls, 0);
});

test("a provider 200 response that reports failure does not release the voice", async () => {
  const h = await fixture(); h.grant();
  h.setProviderReply(() => Response.json({ success: false, errors: ["provider-rejected"] }));
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "MAZIAO_DELETE_FAILED");
  assert.ok(h.grants.has(`${alice}:${voiceId}`));
  assert.equal(h.rpcCalls, 0);
});

test("provider 404 lets a failed local cleanup retry and releases only once", async () => {
  const h = await fixture(); h.grant();
  h.setProviderReply(() => new Response(null, { status: 404 }));
  h.setRpcError(new Error("temporary database error"));
  const { deleteMemberVoice } = await h.entry("lib/studio-voice-delete.ts");
  await rejectsCode(() => deleteMemberVoice(alice, voiceId), "VOICE_DELETE_SYNC_FAILED");
  assert.ok(h.grants.has(`${alice}:${voiceId}`));
  assert.equal(h.released, 0);
  h.setRpcError(null);
  assert.equal((await deleteMemberVoice(alice, voiceId)).success, true);
  assert.equal(h.released, 1);
  assert.equal(h.rpcCalls, 2);
});

test("DELETE route requires authenticated same-origin mutation before touching the provider", async () => {
  const h = await fixture(); h.grant();
  const { DELETE } = await h.entry("app/api/voices/[voiceId]/route.ts");
  const params = { params: Promise.resolve({ voiceId }) };
  h.setAuthUser(null);
  let result = await DELETE(new Request("https://apprivew.vercel.app/api/voices/myClone", { method: "DELETE" }), params);
  assert.equal(result.status, 401);
  h.setAuthUser(alice);
  result = await DELETE(new Request("https://apprivew.vercel.app/api/voices/myClone", {
    method: "DELETE", headers: { Origin: "https://untrusted.example" },
  }), params);
  assert.equal(result.status, 403);
  assert.equal(h.requests.length, 0);
  result = await DELETE(new Request("https://apprivew.vercel.app/api/voices/myClone", {
    method: "DELETE", headers: { Origin: "https://apprivew.vercel.app" },
  }), params);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true });
  assert.equal(h.requests.length, 1);
});
