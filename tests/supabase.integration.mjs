// Opt-in integration test against a disposable LOCAL Supabase stack only.
// First apply supabase/setup.sql to that stack, then run from the repo root:
// node tests/supabase.integration.mjs --config /absolute/path/work/local-supabase.json
// The explicit JSON contains {apiUrl,publishableKey,serviceRoleKey}. Never commit it.
// These tests create randomized .invalid users, consume local quotas and clean up.
// They never invoke DeepSeek, ElevenLabs, a remote project, or the normal offline suite.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) {
  throw new Error("Pass --config with an explicit local credentials JSON inside a work directory.");
}
const configPath = resolve(process.argv[configIndex + 1]);
if (!configPath.split(/[\\/]/).includes("work") || extname(configPath) !== ".json") {
  throw new Error("Integration credentials must be a .json file inside a work directory.");
}
const configuration = JSON.parse(await readFile(configPath, "utf8"));
const api = new URL(configuration.apiUrl);
if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname)
  || api.port !== "55321" || api.username || api.password || api.search || api.hash || api.pathname !== "/") {
  throw new Error("Refusing to run: only disposable http://127.0.0.1:55321 or localhost:55321 is allowed.");
}
for (const key of ["publishableKey", "serviceRoleKey"]) {
  if (typeof configuration[key] !== "string" || !configuration[key].trim()) throw new Error(`Missing local ${key}.`);
}
// Constrain every SDK request as well as the initial URL. Redirects cannot leave localhost.
const localFetch = async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (target.origin !== api.origin) throw new Error("An integration request tried to leave the local test origin.");
  return fetch(input, { ...init, redirect: "error", signal: init?.signal || AbortSignal.timeout(20000) });
};
const makeClient = (key = configuration.publishableKey) => createClient(api.origin, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: localFetch },
});
const service = makeClient(configuration.serviceRoleKey), anonymous = makeClient();
const users = [], mediaPaths = new Set();
const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const password = `Local-only-${randomBytes(20).toString("base64url")}7!`;
let passed = 0;
const bucket = "studio-media";
function value(result, label) {
  if (result.error) throw new Error(`${label} rejected (${String(result.error.code || result.error.status || "error").replace(/[^a-zA-Z0-9_]/g, "")}).`);
  return result.data;
}
function denied(result, label) {
  assert.ok(result.error || (Array.isArray(result.data) && result.data.length === 0), label);
}
async function check(label, test) {
  await test();
  passed++;
  console.log(`PASS ${label}`);
}
async function member(client, id) {
  return value(await client.from("studio_members").select("user_id,email,role,enabled,ai_units_limit,ai_units_used").eq("user_id", id).single(), "read member");
}
async function signup(name, metadata = {}) {
  const client = makeClient(), email = `apprivew-${name}-${runId}@example.invalid`;
  assert.ok(email.endsWith("@example.invalid"));
  const created = value(await client.auth.signUp({ email, password, options: { data: { display_name: name, ...metadata } } }), `signup ${name}`);
  assert.ok(created.user?.id, "real Auth signup must return a user");
  const entry = { name, email, id: created.user.id, client };
  users.push(entry); // Register immediately so all later failures still clean up the Auth identity.
  if (!created.session) {
    value(await service.auth.admin.updateUserById(entry.id, { email_confirm: true }), "confirm local test user");
  }
  value(await client.auth.signOut(), "sign out signup session");
  const signedIn = value(await client.auth.signInWithPassword({ email, password }), `password login ${name}`);
  assert.equal(signedIn.user.id, entry.id);
  assert.equal(value(await client.auth.getUser(), "validate Auth user").user.id, entry.id);
  return entry;
}

try {
  let alice, bob, admin;
  await check("real signup/login and trigger ignore forged role, activation and quota metadata", async () => {
    alice = await signup("alice", { role: "admin", enabled: true, ai_units_limit: 99999 });
    bob = await signup("bob");
    admin = await signup("admin");
    for (const user of users) {
      const row = await member(service, user.id);
      assert.equal(row.role, "member");
      assert.equal(row.enabled, false);
      assert.equal(row.ai_units_limit, 0);
      assert.equal(row.ai_units_used, 0);
    }
  });
  await check("pending member cannot save a profile, consume units, or grant self access", async () => {
    denied(await alice.client.from("studio_settings").insert({ user_id: alice.id, profile_json: { name: "pending" } }), "pending profile write must be blocked");
    const charge = await alice.client.rpc("consume_studio_ai_units", { p_units: 1 });
    assert.ok(charge.error?.message.includes("MEMBER_DISABLED"));
    denied(await alice.client.from("studio_members").update({ enabled: true, ai_units_limit: 1000, ai_units_used: 0 }).eq("user_id", alice.id).select("user_id"), "pending member cannot approve self");
    assert.equal((await member(service, alice.id)).enabled, false);
  });
  await check("anonymous clients cannot read membership or invoke the allowance RPC", async () => {
    assert.ok((await anonymous.from("studio_members").select("user_id")).error);
    assert.ok((await anonymous.rpc("consume_studio_ai_units", { p_units: 1 })).error);
  });
  await check("local owner bootstrap enables admin and members without trusting Auth metadata", async () => {
    value(await service.from("studio_members").update({ enabled: true, ai_units_limit: 5 }).in("user_id", [alice.id, bob.id]), "enable local members");
    value(await service.from("studio_members").update({ enabled: true, role: "admin", ai_units_limit: 10 }).eq("user_id", admin.id), "bootstrap local admin");
    assert.equal((await member(admin.client, admin.id)).role, "admin");
  });
  await check("members see only their membership while enabled admin sees all test members", async () => {
    for (const user of [alice, bob]) {
      const rows = value(await user.client.from("studio_members").select("user_id"), "member rows");
      assert.deepEqual(rows.map(row => row.user_id), [user.id]);
    }
    const rows = value(await admin.client.from("studio_members").select("user_id"), "admin member list");
    for (const user of users) assert.ok(rows.some(row => row.user_id === user.id));
  });
  await check("members cannot reset consumption, grant quota, insert members, or alter identity/role columns", async () => {
    denied(await alice.client.from("studio_members").update({ ai_units_limit: 100000, ai_units_used: 0 }).eq("user_id", alice.id).select("user_id"), "member quota update must be blocked");
    assert.ok((await alice.client.from("studio_members").update({ role: "admin" }).eq("user_id", alice.id)).error);
    assert.ok((await alice.client.from("studio_members").update({ email: "forged@example.invalid" }).eq("user_id", alice.id)).error);
    assert.ok((await alice.client.from("studio_members").update({ user_id: randomUUID() }).eq("user_id", alice.id)).error);
    assert.ok((await alice.client.from("studio_members").insert({ user_id: randomUUID() })).error);
    const row = await member(service, alice.id);
    assert.equal(row.role, "member");
    assert.equal(row.ai_units_limit, 5);
  });
  await check("admin updates allowed activation/quota columns but cannot change roles through the client", async () => {
    const updated = value(await admin.client.from("studio_members").update({ ai_units_limit: 7 }).eq("user_id", bob.id).select("ai_units_limit").single(), "admin quota update");
    assert.equal(updated.ai_units_limit, 7);
    assert.ok((await admin.client.from("studio_members").update({ role: "admin" }).eq("user_id", bob.id)).error);
    assert.equal((await member(service, bob.id)).role, "member");
  });
  await check("profiles support own writes and hide foreign rows including from an app admin", async () => {
    for (const user of [alice, bob]) value(await user.client.from("studio_settings").insert({ user_id: user.id, profile_json: { name: user.name } }), "own profile insert");
    const own = value(await alice.client.from("studio_settings").select("user_id,profile_json"), "own profile select");
    assert.equal(own.length, 1);
    assert.equal(own[0].user_id, alice.id);
    assert.equal(own[0].profile_json.name, "alice");
    value(await alice.client.from("studio_settings").update({ profile_json: { name: "Alice updated" } }).eq("user_id", alice.id), "own profile update");
    denied(await alice.client.from("studio_settings").update({ profile_json: { name: "foreign edit" } }).eq("user_id", bob.id).select("user_id"), "foreign profile update must affect zero rows");
    denied(await alice.client.from("studio_settings").delete().eq("user_id", bob.id).select("user_id"), "foreign profile delete must affect zero rows");
    assert.ok((await alice.client.from("studio_settings").upsert({ user_id: bob.id, profile_json: {} })).error);
    assert.ok((await alice.client.from("studio_settings").update({ user_id: bob.id }).eq("user_id", alice.id)).error);
    assert.deepEqual(value(await admin.client.from("studio_settings").select("user_id").in("user_id", [alice.id, bob.id]), "admin profile isolation"), []);
  });
  await check("voice rows enforce owner CRUD and prevent moving a row to another member", async () => {
    for (const user of [alice, bob]) value(await user.client.from("studio_voices").insert({ user_id: user.id, voice_id: `test-${runId}`, name: user.name, source: "personal", authorization_tag: "intentionally-invalid-local-signature" }), "own voice row insert");
    // An own row can hold an invalid tag; the application HMAC check separately rejects it.
    const rows = value(await alice.client.from("studio_voices").select("user_id,name"), "own voice rows");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, alice.id);
    value(await alice.client.from("studio_voices").update({ name: "Alice own voice" }).eq("user_id", alice.id), "own voice update");
    denied(await alice.client.from("studio_voices").update({ name: "stolen" }).eq("user_id", bob.id).select("user_id"), "foreign voice update must affect zero rows");
    denied(await alice.client.from("studio_voices").delete().eq("user_id", bob.id).select("user_id"), "foreign voice delete must affect zero rows");
    assert.ok((await alice.client.from("studio_voices").insert({ user_id: bob.id, voice_id: "foreign-insert", name: "foreign", source: "personal", authorization_tag: "invalid" })).error);
    assert.ok((await alice.client.from("studio_voices").update({ user_id: bob.id }).eq("user_id", alice.id)).error);
  });
  const ownPath = user => `${user.id}/integration/${runId}.wav`;
  const wav = new Uint8Array(524);
  const wavView = new DataView(wav.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]]) [...text].forEach((letter, index) => wav[offset + index] = letter.charCodeAt(0));
  wavView.setUint32(4, wav.length - 8, true); wavView.setUint32(16, 16, true); wavView.setUint16(20, 1, true); wavView.setUint16(22, 1, true); wavView.setUint32(24, 24000, true); wavView.setUint32(28, 48000, true); wavView.setUint16(32, 2, true); wavView.setUint16(34, 16, true); wavView.setUint32(40, wav.length - 44, true);
  await check("private storage permits own upload/download/update and a working short-lived signed URL", async () => {
    const info = value(await service.storage.getBucket(bucket), "private bucket configuration");
    assert.equal(info.public, false);
    assert.equal(Number(info.file_size_limit), 62914560);
    for (const user of [alice, bob]) {
      mediaPaths.add(ownPath(user));
      value(await user.client.storage.from(bucket).upload(ownPath(user), wav, { contentType: "audio/wav" }), "own audio upload");
      const downloaded = value(await user.client.storage.from(bucket).download(ownPath(user)), "own audio download");
      assert.equal(downloaded.size, wav.length);
    }
    value(await alice.client.storage.from(bucket).upload(ownPath(alice), wav, { contentType: "audio/wav", upsert: true }), "own audio upsert");
    const signed = value(await alice.client.storage.from(bucket).createSignedUrl(ownPath(alice), 30), "own signed URL");
    const response = await localFetch(signed.signedUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wav);
  });
  await check("storage blocks foreign reads/signing/replacement/deletion, anonymous access and public URLs", async () => {
    assert.ok((await alice.client.storage.from(bucket).download(ownPath(bob))).error);
    assert.ok((await alice.client.storage.from(bucket).createSignedUrl(ownPath(bob), 30)).error);
    assert.ok((await alice.client.storage.from(bucket).upload(ownPath(bob), wav, { contentType: "audio/wav", upsert: true })).error);
    const forbidden = `${bob.id}/integration/forbidden-${runId}.wav`;
    mediaPaths.add(forbidden);
    assert.ok((await alice.client.storage.from(bucket).upload(forbidden, wav, { contentType: "audio/wav" })).error);
    await alice.client.storage.from(bucket).remove([ownPath(bob)]); // RLS may return an empty successful result.
    assert.equal(value(await bob.client.storage.from(bucket).download(ownPath(bob)), "foreign delete preserved owner object").size, wav.length);
    assert.ok((await anonymous.storage.from(bucket).download(ownPath(alice))).error);
    const publicUrl = anonymous.storage.from(bucket).getPublicUrl(ownPath(alice)).data.publicUrl;
    assert.equal((await localFetch(publicUrl)).ok, false);
  });
  await check("allowance rejects invalid costs, charges only the caller and preserves state after over-limit failure", async () => {
    for (const p_units of [0, -1, null, 10001]) {
      const result = await alice.client.rpc("consume_studio_ai_units", { p_units });
      assert.ok(result.error?.message.includes("INVALID_AI_UNITS"));
    }
    assert.equal((await member(service, alice.id)).ai_units_used, 0);
    assert.equal(value(await alice.client.rpc("consume_studio_ai_units", { p_units: 2 }), "valid atomic consumption"), 3);
    const exhausted = await alice.client.rpc("consume_studio_ai_units", { p_units: 4 });
    assert.ok(exhausted.error?.message.includes("QUOTA_EXCEEDED"));
    assert.equal((await member(service, alice.id)).ai_units_used, 2);
    assert.equal((await member(service, bob.id)).ai_units_used, 0);
  });
  await check("12 simultaneous real RPC requests consume exactly five remaining units", async () => {
    value(await admin.client.from("studio_members").update({ ai_units_limit: 5, ai_units_used: 0 }).eq("user_id", alice.id), "reset only local test allowance");
    const results = await Promise.all(Array.from({ length: 12 }, () => alice.client.rpc("consume_studio_ai_units", { p_units: 1 })));
    const success = results.filter(result => !result.error), failure = results.filter(result => result.error);
    assert.equal(success.length, 5);
    assert.equal(failure.length, 7);
    assert.deepEqual(success.map(result => result.data).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
    assert.ok(failure.every(result => result.error.message.includes("QUOTA_EXCEEDED")));
    assert.equal((await member(service, alice.id)).ai_units_used, 5);
    assert.equal((await member(service, bob.id)).ai_units_used, 0);
  });
  await check("disabling a member takes effect for existing tokens on rows, storage and quota", async () => {
    value(await admin.client.from("studio_members").update({ enabled: false }).eq("user_id", bob.id), "disable local member");
    assert.deepEqual(value(await bob.client.from("studio_settings").select("user_id"), "disabled profile rows"), []);
    assert.deepEqual(value(await bob.client.from("studio_voices").select("user_id"), "disabled voice rows"), []);
    assert.ok((await bob.client.from("studio_settings").upsert({ user_id: bob.id, profile_json: {} })).error);
    assert.ok((await bob.client.storage.from(bucket).download(ownPath(bob))).error);
    assert.ok((await bob.client.storage.from(bucket).createSignedUrl(ownPath(bob), 30)).error);
    const forbidden = `${bob.id}/integration/disabled-${runId}.wav`;
    mediaPaths.add(forbidden);
    assert.ok((await bob.client.storage.from(bucket).upload(forbidden, wav, { contentType: "audio/wav" })).error);
    const result = await bob.client.rpc("consume_studio_ai_units", { p_units: 1 });
    assert.ok(result.error?.message.includes("MEMBER_DISABLED"));
    assert.equal((await member(service, bob.id)).ai_units_used, 0);
  });
  await check("owner can delete own profile/voice/media without changing another member", async () => {
    const profiles = value(await alice.client.from("studio_settings").delete().eq("user_id", alice.id).select("user_id"), "own profile delete");
    assert.equal(profiles.length, 1);
    const voices = value(await alice.client.from("studio_voices").delete().eq("user_id", alice.id).select("user_id"), "own voice delete");
    assert.equal(voices.length, 1);
    value(await alice.client.storage.from(bucket).remove([ownPath(alice)]), "own media delete");
    assert.ok((await service.storage.from(bucket).download(ownPath(alice))).error);
    assert.equal(value(await service.from("studio_settings").select("user_id").eq("user_id", bob.id), "other profile remains").length, 1);
  });
  console.log(`${passed} real local Supabase integration checks passed.`);
} finally {
  // Storage objects must go first: Auth refuses deleting users who still own objects.
  const failures = [];
  if (mediaPaths.size) {
    const removed = await service.storage.from(bucket).remove([...mediaPaths]);
    if (removed.error) failures.push("temporary storage removal");
  }
  for (const user of users) {
    try { await user.client.auth.signOut(); } catch { /* deletion still attempted */ }
    const deleted = await service.auth.admin.deleteUser(user.id);
    if (deleted.error) failures.push(`temporary Auth identity ${user.id}`);
  }
  if (failures.length) throw new Error(`Local test cleanup failed: ${failures.join(", ")}.`);
  console.log(`CLEANUP removed ${users.length} temporary local Auth users and their test media.`);
}
