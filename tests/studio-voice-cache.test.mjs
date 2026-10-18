import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual cache and sync modules against explicit in-memory fakes.
// No provider account, recording, API request or paid generation is used.
const root = process.cwd();
const admin = "00000000-0000-4000-8000-000000000000";
const alice = "11111111-1111-4111-8111-111111111111";
const scoped = (id, model = "vieten_speech") => `maziao:${model}:${id}`;
const epoch = Date.parse("2026-10-18T10:00:00.000Z");
const iso = milliseconds => new Date(milliseconds).toISOString();

async function harness() {
  const rows = new Map(), grants = new Map(), approvals = new Map(), blocked = new Set();
  const events = [], writes = [], modules = new Map(), synthetics = new Map();
  let clock = epoch, snapshot = [], snapshotError, queryError, upsertErrorAt, upserts = 0, retirementError = false;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({ console, Date: TestDate, URL, Uint8Array, DataView, ArrayBuffer,
    fetch() { throw new Error("Cache tests must not contact external services"); },
  });
  function failure(code, status = 403) {
    return new (modules.get(path.join(root, "lib/studio-contract.ts")).namespace.StudioError)(code, code, status);
  }
  function query(table) {
    let action = "select", input, limit = Infinity, filters = [];
    const builder = {
      select() { return this; }, order() { return this; }, limit(value) { limit = value; return this; },
      eq(field, value) { filters.push(["eq", field, value]); return this; },
      lt(field, value) { filters.push(["lt", field, value]); return this; },
      upsert(value, options) { action = "upsert"; input = value; assert.equal(options.onConflict, "voice_id"); return this; },
      update(value) { action = "update"; input = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    function run() {
      events.push({ action, table, filters: structuredClone(filters) });
      assert.equal(table, "studio_voice_cache", "sync must never mutate grants or the approval catalog");
      const matches = row => filters.every(([operator, field, value]) => operator === "eq" ? row[field] === value : row[field] < value);
      if (action === "select") return queryError ? { data: null, error: { message: "offline-read-error" } } : { data: [...rows.values()].filter(matches).slice(0, limit), error: null };
      if (action === "upsert") {
        upserts++;
        if (upserts === upsertErrorAt) return { data: null, error: { message: "offline-upsert-error" } };
        writes.push({ action, table, rows: structuredClone(input) });
        for (const row of input) rows.set(row.voice_id, structuredClone(row));
        return { error: null };
      }
      if (retirementError) return { error: { message: "offline-retirement-error" } };
      writes.push({ action, table, values: structuredClone(input), filters: structuredClone(filters) });
      for (const row of rows.values()) if (matches(row)) Object.assign(row, structuredClone(input));
      return { error: null };
    }
    return builder;
  }
  const client = { from: query };
  const mocks = new Map([
    [path.join(root, "lib/studio-server.ts"), {
      getMember: async userId => ({ role: userId === admin ? "admin" : "member", enabled: true }),
      sharedVoiceCatalog: async () => [...approvals.values()],
      authorizedVoiceRows: async userId => [...grants.values()].filter(row => row.user_id === userId),
    }],
    [path.join(root, "lib/studio-supabase.ts"), { createStudioSupabaseServer: async () => client }],
    [path.join(root, "lib/studio-voice-guard.ts"), {
      publishableAdminVoiceIds: async (userId, ids) => {
        events.push({ action: "privacyGuard", userId, ids: Array.from(ids) });
        if (userId !== admin) throw failure("ADMIN_REQUIRED");
        return ids.filter(id => !blocked.has(id));
      },
    }],
    [path.join(root, "lib/studio-maziao.ts"), {
      fetchVoiceCatalogSnapshot: async () => {
        events.push({ action: "providerSnapshot" });
        clock += 1000;
        if (snapshotError) throw snapshotError;
        return snapshot;
      },
    }],
  ]);
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const source = readFileSync(file, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    modules.set(file, module); return module;
  }
  function linker(specifier, parent) {
    const file = specifier === "server-only" ? specifier : specifier.startsWith("@/") ? `${path.join(root, specifier.slice(2))}.ts` : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
    if (file === "server-only" || mocks.has(file)) {
      if (synthetics.has(file)) return synthetics.get(file);
      const values = mocks.get(file) || {};
      const module = new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
      synthetics.set(file, module); return module;
    }
    return load(file);
  }
  async function entry(relative) {
    const module = load(path.join(root, relative));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status !== "evaluated") await module.evaluate();
    return module.namespace;
  }
  function cache(id, extra = {}) {
    const row = { voice_id: id, name: id, kind: "admin_clone", preview_url: "https://r2-storage.maziao.com/samples/offline.wav", gender: "female", status: "active", updated_at: iso(epoch - 10000), last_seen_at: iso(epoch - 10000), ...extra };
    rows.set(id, row); return row;
  }
  function grant(userId, id, extra = {}) {
    const row = { user_id: userId, voice_id: id, name: id, source: "personal", ...extra }; grants.set(`${userId}:${id}`, row); return row;
  }
  function approve(id, extra = {}) { approvals.set(id, { voice_id: id, name: id, enabled: true, kind: "admin_clone", ...extra }); }
  return { rows, grants, approvals, blocked, events, writes, client, cache, grant, approve, entry,
    setSnapshot(value) { snapshot = value; }, failSnapshot(error) { snapshotError = error; }, failReads() { queryError = true; },
    failUpsertAt(value) { upsertErrorAt = value; }, failRetirement() { retirementError = true; },
  };
}

function snapshotVoice(id, kind = "admin_clone") { return { voiceId: id, name: id, kind, previewUrl: "https://r2-storage.maziao.com/samples/offline.wav", gender: "female" }; }
let passed = 0;
async function check(name, run) { await run(); console.log(`PASS ${name}`); passed++; }

await check("an imported administrator clone displays as cloned without requiring a historical personal grant", async () => {
  const h = await harness(); h.cache(scoped("accountClone"));
  const cache = await h.entry("lib/studio-voice-cache.ts"), result = await cache.cachedVoiceList(admin);
  assert.equal(result.voices.length, 1); assert.equal(result.voices[0].voiceId, scoped("accountClone"));
  assert.equal(result.voices[0].category, "cloned"); assert.equal(result.voices[0].group, "personal");
  assert.equal(h.grants.size, 0); assert.equal(h.writes.length, 0);
  assert.ok(!h.events.some(event => event.action === "providerSnapshot"));
});

await check("administrator candidates preserve both model namespaces and exclude another member's private clones", async () => {
  const h = await harness(), viet = scoped("sameRawId"), multilingual = scoped("sameRawId", "lingual_speech_v2"), foreign = scoped("otherMemberClone");
  h.cache(viet); h.cache(multilingual); h.cache(foreign, { name: "Private other member name" }); h.blocked.add(foreign);
  h.cache(scoped("retiredClone"), { status: "unavailable" }); h.cache(scoped("publicVoice"), { kind: "system" });
  const cache = await h.entry("lib/studio-voice-cache.ts"), candidates = await cache.cachedAdminCandidates(admin);
  assert.deepEqual(Array.from(candidates, row => row.voice_id), [viet, multilingual]);
  assert.ok(candidates.every(row => row.kind === "admin_clone" && row.enabled === false));
  assert.ok(!JSON.stringify(candidates).includes("Private other member name"));
  assert.equal(h.writes.length, 0);
});

await check("privacy filtering cannot be bypassed by an old administrator grant for a known other-member clone", async () => {
  const h = await harness(), id = scoped("privateForeignClone");
  h.cache(id, { name: "Private foreign name" }); h.blocked.add(id); h.grant(admin, id);
  const cache = await h.entry("lib/studio-voice-cache.ts"), result = await cache.cachedVoiceList(admin);
  assert.equal(result.voices.length, 0); assert.ok(!JSON.stringify(result).includes("Private foreign name"));
  assert.equal(h.writes.length, 0);
});

await check("known unavailable clones never reappear through old personal grants for administrators or members", async () => {
  for (const userId of [admin, alice]) {
    const h = await harness(), id = scoped("retiredPersonalClone"); h.cache(id, { status: "unavailable" }); h.grant(userId, id); h.approve(id);
    const cache = await h.entry("lib/studio-voice-cache.ts");
    assert.equal((await cache.cachedVoiceList(userId)).voices.length, 0);
    assert.equal(h.writes.length, 0);
  }
});

await check("a newly created personal voice remains available while it has no cache row yet", async () => {
  for (const userId of [admin, alice]) {
    const h = await harness(), id = scoped("justCreatedClone"); h.grant(userId, id, { name: "Giọng vừa tạo", preview_url: "https://r2-storage.maziao.com/samples/own.wav" });
    const cache = await h.entry("lib/studio-voice-cache.ts"), result = await cache.cachedVoiceList(userId);
    assert.equal(result.voices.length, 1); assert.equal(result.voices[0].voiceId, id); assert.equal(result.voices[0].name, "Giọng vừa tạo");
    assert.equal(result.voices[0].previewUrl, "https://r2-storage.maziao.com/samples/own.wav");
    assert.equal(result.voices[0].isPersonalClone, userId === alice ? true : undefined);
    assert.equal(result.voices[0].category, "cloned"); assert.equal(h.writes.length, 0);
  }
});

await check("members see enabled approved cache entries and their own private clones only", async () => {
  const h = await harness(), shared = scoped("approvedClone"), system = scoped("approvedSystem"), own = scoped("ownPrivateClone");
  h.cache(shared); h.cache(system, { kind: "system" }); h.cache(own); h.grant(alice, own, { preview_url: "https://r2-storage.maziao.com/samples/private.wav" });
  h.cache(scoped("unapprovedClone"), { name: "Hidden unapproved name" });
  h.cache(scoped("disabledClone")); h.approve(scoped("disabledClone"), { enabled: false });
  h.cache(scoped("foreignPrivateClone"), { name: "Hidden foreign name" });
  h.grant(admin, scoped("foreignPrivateClone")); h.approve(shared); h.approve(system, { kind: "system" });
  const cache = await h.entry("lib/studio-voice-cache.ts"), result = await cache.cachedVoiceList(alice);
  assert.deepEqual(Array.from(result.voices, row => row.voiceId), [shared, system, own]);
  assert.equal(result.voices.find(row => row.voiceId === shared).category, "cloned");
  assert.equal(result.voices.find(row => row.voiceId === shared).isPersonalClone, undefined);
  assert.equal(result.voices.find(row => row.voiceId === system).category, "library");
  assert.equal(result.voices.find(row => row.voiceId === own).isPersonalClone, true);
  assert.equal(result.voices.find(row => row.voiceId === own).previewUrl, "https://r2-storage.maziao.com/samples/private.wav");
  for (const secret of ["Hidden unapproved name", "Hidden foreign name", "foreignPrivateClone"]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(h.writes.length, 0);
});

await check("member requests cannot enumerate administrator candidates and cache read errors fail closed", async () => {
  const h = await harness(), cache = await h.entry("lib/studio-voice-cache.ts");
  await assert.rejects(cache.cachedAdminCandidates(alice), { code: "ADMIN_REQUIRED", status: 403 });
  assert.equal(h.events.length, 0);
  h.failReads(); await assert.rejects(cache.cachedVoiceList(admin), { code: "VOICE_CACHE_UNAVAILABLE", status: 503 });
  assert.equal(h.writes.length, 0);
});

await check("a failed provider snapshot performs no cache writes or retirement", async () => {
  const h = await harness(), id = scoped("oldClone"); h.cache(id); h.approve(id); h.grant(admin, id);
  const error = new Error("Offline provider snapshot failed"); h.failSnapshot(error);
  const sync = await h.entry("lib/studio-voice-sync.ts");
  await assert.rejects(sync.syncProviderVoices(h.client, "offline-server-only-key"), error);
  assert.deepEqual(h.events.map(event => event.action), ["providerSnapshot"]);
  assert.equal(h.rows.get(id).status, "active"); assert.equal(h.writes.length, 0); assert.equal(h.approvals.get(id).enabled, true); assert.equal(h.grants.size, 1);
});

await check("complete sync stores the snapshot before retiring only stale administrator clones from before its start", async () => {
  const h = await harness(), current = scoped("currentClone"), stale = scoped("deletedClone"), publicId = scoped("publicVoice");
  h.cache(current); h.cache(stale); h.cache(publicId, { kind: "system" });
  h.cache(scoped("equalStartClone"), { last_seen_at: iso(epoch) });
  h.cache(scoped("concurrentClone"), { last_seen_at: iso(epoch + 5000) });
  h.approve(stale); h.grant(admin, stale);
  h.setSnapshot([snapshotVoice(current), snapshotVoice(scoped("secondModelClone", "lingual_speech_v2")), snapshotVoice(publicId, "system")]);
  const sync = await h.entry("lib/studio-voice-sync.ts"), result = await sync.syncProviderVoices(h.client, "offline-server-only-key");
  assert.equal(result.synced, 3); assert.equal(result.adminClones, 2);
  assert.deepEqual(h.events.map(event => event.action), ["providerSnapshot", "upsert", "update"]);
  assert.equal(h.rows.get(stale).status, "unavailable"); assert.equal(h.rows.get(current).status, "active"); assert.equal(h.rows.get(publicId).status, "active");
  assert.equal(h.rows.get(scoped("equalStartClone")).status, "active"); assert.equal(h.rows.get(scoped("concurrentClone")).status, "active");
  const retirement = h.writes.find(write => write.action === "update");
  assert.deepEqual(retirement.filters, [["eq", "kind", "admin_clone"], ["eq", "status", "active"], ["lt", "last_seen_at", iso(epoch)]]);
  assert.equal(h.approvals.size, 1); assert.equal(h.approvals.get(stale).enabled, true); assert.equal(h.grants.size, 1);
  assert.ok(!JSON.stringify(h.writes).includes("offline-server-only-key"));
});

await check("a successful empty account snapshot retires stale account clones but leaves system voices and approvals intact", async () => {
  const h = await harness(), clone = scoped("noLongerOwnedClone"), system = scoped("existingSystemVoice");
  h.cache(clone); h.cache(system, { kind: "system" }); h.approve(clone); h.grant(admin, clone); h.setSnapshot([]);
  const sync = await h.entry("lib/studio-voice-sync.ts"), result = await sync.syncProviderVoices(h.client, "offline-server-only-key");
  assert.equal(result.synced, 0); assert.equal(result.adminClones, 0);
  assert.equal(h.rows.get(clone).status, "unavailable"); assert.equal(h.rows.get(system).status, "active");
  assert.equal(h.approvals.get(clone).enabled, true); assert.equal(h.grants.size, 1);
  assert.deepEqual(h.events.map(event => event.action), ["providerSnapshot", "update"]);
});

await check("an upsert failure after an earlier saved batch never retires voices or modifies sharing decisions", async () => {
  const h = await harness(), stale = scoped("oldApprovedClone"); h.cache(stale); h.approve(stale); h.grant(admin, stale);
  h.setSnapshot(Array.from({ length: 101 }, (_, index) => snapshotVoice(scoped(`batchClone${index}`)))); h.failUpsertAt(2);
  const sync = await h.entry("lib/studio-voice-sync.ts");
  await assert.rejects(sync.syncProviderVoices(h.client, "offline-server-only-key"), { code: "VOICE_SYNC_STORAGE", status: 503 });
  assert.deepEqual(h.events.map(event => event.action), ["providerSnapshot", "upsert", "upsert"]);
  assert.equal(h.rows.get(stale).status, "active"); assert.equal(h.approvals.get(stale).enabled, true); assert.equal(h.grants.size, 1);
  assert.ok(!h.writes.some(write => write.action === "update"));
});

await check("sync never auto-enables an administrator clone and reports a retirement storage error", async () => {
  const h = await harness(), id = scoped("newProviderClone"); h.setSnapshot([snapshotVoice(id)]); h.failRetirement();
  const sync = await h.entry("lib/studio-voice-sync.ts");
  await assert.rejects(sync.syncProviderVoices(h.client, "offline-server-only-key"), { code: "VOICE_SYNC_STORAGE", status: 503 });
  assert.equal(h.approvals.size, 0); assert.equal(h.grants.size, 0); assert.equal(h.rows.get(id).status, "active");
});

console.log(`${passed} isolated voice cache and sync tests passed.`);
