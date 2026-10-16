// Opt-in real Next.js + local Supabase session test. Not part of `pnpm test`.
// Start the app against the disposable local Supabase stack, then run:
// node tests/studio-auth.integration.mjs --config /absolute/path/work/local-supabase.json
// Config: {apiUrl,publishableKey,serviceRoleKey}. The file must not be committed.
// Only localhost Supabase:55321 and the test app http://localhost:4320 are allowed.
// No AI provider is called. Recovery links are generated locally without sending mail.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) throw new Error("Pass --config with the explicit local test JSON inside a work directory.");
const configPath = resolve(process.argv[configIndex + 1]);
if (!configPath.split(/[\\/]/).includes("work") || extname(configPath) !== ".json") throw new Error("Local test credentials must be a .json file inside work.");
const configuration = JSON.parse(await readFile(configPath, "utf8"));
const api = new URL(configuration.apiUrl);
if (api.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(api.hostname) || api.port !== "55321"
  || api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw new Error("Refusing to run against anything except the disposable local Supabase port55321.");
for (const key of ["publishableKey", "serviceRoleKey"]) if (typeof configuration[key] !== "string" || !configuration[key].trim()) throw new Error(`Missing local ${key}.`);
// Next normalizes 127.* loopback URLs to localhost in NextRequest.url.
const appOrigin = "http://localhost:4320";
const localFetch = async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (![api.origin, appOrigin].includes(target.origin)) throw new Error("An integration request tried to leave the approved localhost test origins.");
  return fetch(input, { ...init, redirect: "manual", signal: init?.signal || AbortSignal.timeout(45000) });
};
const service = createClient(api.origin, configuration.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: localFetch },
});
const users = [], runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const password = `Local-only-${randomBytes(20).toString("base64url")}7!`;
const replacementPassword = `Local-replacement-${randomBytes(20).toString("base64url")}8!`;
let passed = 0;
function value(result, label) {
  if (result.error) throw new Error(`${label} rejected (${String(result.error.code || result.error.status || "error").replace(/[^a-zA-Z0-9_]/g, "")}).`);
  return result.data;
}
function session() { return { cookies: new Map() }; }
function acceptCookies(jar, headers) {
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0], equal = pair.indexOf("=");
    if (equal < 1) continue;
    const name = pair.slice(0, equal), contents = pair.slice(equal + 1);
    if (/;\s*max-age=0(?:;|$)/i.test(cookie) || contents === "") jar.cookies.delete(name);
    else jar.cookies.set(name, contents);
  }
}
async function request(jar, path, { method = "GET", body, headers = {} } = {}) {
  assert.ok(path.startsWith("/api/") || path.startsWith("/auth/confirm?"), "only app test endpoints are allowed");
  const target = new URL(path, appOrigin);
  assert.equal(target.origin, appOrigin);
  const requestHeaders = new Headers({ origin: appOrigin, ...headers });
  if (jar.cookies.size) requestHeaders.set("cookie", [...jar.cookies].map(([name, contents]) => `${name}=${contents}`).join("; "));
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const response = await localFetch(target, { method, headers: requestHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  acceptCookies(jar, response.headers);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!data) await response.body?.cancel();
  return { status: response.status, headers: response.headers, data };
}
function result(actual, status, code) {
  assert.equal(actual.status, status, `unexpected response status; code=${actual.data?.code || "none"}`);
  if (code) assert.equal(actual.data?.code, code);
  return actual.data;
}
async function check(label, test) { await test(); passed++; console.log(`PASS ${label}`); }
async function lookup(email) {
  const page = value(await service.auth.admin.listUsers({ page: 1, perPage: 1000 }), "list only local test Auth users");
  return page.users.find(user => user.email === email);
}
async function register(name) {
  const email = `apprivew-app-${name}-${runId}@example.invalid`;
  assert.ok(email.endsWith("@example.invalid"));
  const user = { name, email, jar: session(), id: null };
  users.push(user);
  const response = await request(user.jar, "/api/auth", { method: "POST", body: { action: "register", email, password, name } });
  const identity = await lookup(email);
  if (identity) user.id = identity.id;
  result(response, 200);
  assert.ok(user.id, "app signup must create the identity in the local Supabase stack");
  if (!identity.email_confirmed_at) value(await service.auth.admin.updateUserById(user.id, { email_confirm: true }), "confirm only a local test identity");
  result(await request(user.jar, "/api/auth", { method: "POST", body: { action: "signout" } }), 200);
  result(await request(user.jar, "/api/auth", { method: "POST", body: { action: "login", email, password } }), 200);
  assert.ok(user.jar.cookies.size > 0, "login must persist real Supabase session cookies");
  return user;
}

try {
  let alice, bob, admin;
  const anonymous = session();
  await check("Next config rejects anonymous and forged-identity headers without exposing configuration", async () => {
    const response = await request(anonymous, "/api/config", { headers: { "oai-authenticated-user-id": "11111111-1111-4111-8111-111111111111" } });
    result(response, 401, "SIGN_IN_REQUIRED");
    assert.ok(response.headers.get("cache-control")?.includes("no-store"));
    assert.equal(response.data.userId, undefined);
  });
  await check("three users register and log in through real Next routes with cookie sessions", async () => {
    alice = await register("alice"); bob = await register("bob"); admin = await register("admin");
    for (const user of users) {
      const row = value(await service.from("studio_members").select("role,enabled,ai_units_limit").eq("user_id", user.id).single(), "new member defaults");
      assert.equal(row.role, "member"); assert.equal(row.enabled, false); assert.equal(row.ai_units_limit, 0);
    }
  });
  await check("logged-in pending users cannot read config, save profile, or use admin APIs", async () => {
    result(await request(alice.jar, "/api/config"), 403, "MEMBER_DISABLED");
    result(await request(alice.jar, "/api/settings", { method: "POST", body: { profile: { name: "pending" } } }), 403, "MEMBER_DISABLED");
    result(await request(alice.jar, "/api/admin/members"), 403, "MEMBER_DISABLED");
  });
  await check("enabling members is reflected in existing real cookie sessions", async () => {
    value(await service.from("studio_members").update({ enabled: true, ai_units_limit: 20 }).in("user_id", [alice.id, bob.id]), "enable only local test members");
    value(await service.from("studio_members").update({ role: "admin", enabled: true, ai_units_limit: 100 }).eq("user_id", admin.id), "bootstrap only local test admin");
    const config = result(await request(alice.jar, "/api/config"), 200);
    assert.equal(config.userId, alice.id); assert.equal(config.isAdmin, false);
    assert.equal(config.quota.limit, 20); assert.equal(config.quota.used, 0);
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes(configuration.serviceRoleKey));
    for (const field of ["deepseekApiKey", "elevenApiKey", "serviceRoleKey", "apiKey"]) assert.equal(config[field], undefined);
  });
  await check("profile save persists and config displays the saved name without changing another account", async () => {
    const profile = { name: "Alice saved profile", audience: "Small test group", tone: "Natural", facts: "Integration fixture", cta: "", mode: "scenery" };
    const saved = result(await request(alice.jar, "/api/settings", { method: "POST", body: { profile } }), 200);
    assert.equal(saved.profile.name, profile.name); assert.equal(saved.memberName, profile.name);
    const config = result(await request(alice.jar, "/api/config"), 200);
    assert.equal(config.profile.name, profile.name); assert.equal(config.memberName, profile.name);
    const other = result(await request(bob.jar, "/api/config"), 200);
    assert.notEqual(other.profile.name, profile.name);
    assert.equal(value(await service.from("studio_settings").select("profile_json").eq("user_id", alice.id).single(), "persisted local profile").profile_json.name, profile.name);
  });
  await check("members cannot access admin APIs or save provider credentials", async () => {
    result(await request(alice.jar, "/api/admin/members"), 403, "ADMIN_REQUIRED");
    result(await request(alice.jar, "/api/admin/members", { method: "PATCH", body: { userId: alice.id, aiUnitsLimit: 1000 } }), 403, "ADMIN_REQUIRED");
    result(await request(alice.jar, "/api/settings", { method: "POST", body: { deepseekApiKey: "intentionally-not-a-real-key" } }), 403, "SHARED_KEYS_MANAGED");
  });
  await check("real admin route lists members and adjusts another member's allowance", async () => {
    const listed = result(await request(admin.jar, "/api/admin/members"), 200);
    for (const user of users) assert.ok(listed.members.some(row => row.user_id === user.id));
    const changed = result(await request(admin.jar, "/api/admin/members", { method: "PATCH", body: { userId: bob.id, aiUnitsLimit: 37, resetUsage: true } }), 200);
    assert.equal(changed.member.ai_units_limit, 37);
    assert.equal(result(await request(bob.jar, "/api/config"), 200).quota.limit, 37);
    const selfDisable = await request(admin.jar, "/api/admin/members", { method: "PATCH", body: { userId: admin.id, enabled: false } });
    assert.equal(selfDisable.data.code, "ADMIN_SELF_DISABLE"); assert.ok(selfDisable.status >= 400);
  });
  await check("cross-origin and cross-site writes are blocked before modifying state", async () => {
    const badOrigin = { origin: "https://untrusted.example.invalid" };
    result(await request(alice.jar, "/api/settings", { method: "POST", headers: badOrigin, body: { profile: { name: "CSRF replacement" } } }), 403, "INVALID_ORIGIN");
    result(await request(admin.jar, "/api/admin/members", { method: "PATCH", headers: badOrigin, body: { userId: bob.id, aiUnitsLimit: 999 } }), 403, "INVALID_ORIGIN");
    result(await request(alice.jar, "/api/auth", { method: "POST", headers: badOrigin, body: { action: "signout" } }), 403, "INVALID_ORIGIN");
    result(await request(alice.jar, "/api/auth", { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: { action: "signout" } }), 403, "INVALID_ORIGIN");
    assert.equal(result(await request(alice.jar, "/api/config"), 200).memberName, "Alice saved profile");
    assert.equal(result(await request(bob.jar, "/api/config"), 200).quota.limit, 37);
  });
  await check("disabled membership is enforced immediately despite a still-valid cookie session", async () => {
    result(await request(admin.jar, "/api/admin/members", { method: "PATCH", body: { userId: bob.id, enabled: false } }), 200);
    result(await request(bob.jar, "/api/config"), 403, "MEMBER_DISABLED");
    result(await request(bob.jar, "/api/settings", { method: "POST", body: { profile: { name: "disabled" } } }), 403, "MEMBER_DISABLED");
    result(await request(admin.jar, "/api/admin/members", { method: "PATCH", body: { userId: bob.id, enabled: true } }), 200);
    result(await request(bob.jar, "/api/config"), 200);
  });
  await check("local one-use recovery token creates a Next session and permits a password change", async () => {
    const link = value(await service.auth.admin.generateLink({ type: "recovery", email: alice.email, options: { redirectTo: `${appOrigin}/auth/confirm` } }), "generate local recovery token without sending email");
    assert.ok(link.properties?.hashed_token);
    const recovery = session();
    const path = `/auth/confirm?type=recovery&token_hash=${encodeURIComponent(link.properties.hashed_token)}`;
    const confirmed = await request(recovery, path);
    assert.ok([302, 303, 307, 308].includes(confirmed.status));
    assert.equal(new URL(confirmed.headers.get("location"), appOrigin).pathname, "/dat-mat-khau");
    assert.ok(recovery.cookies.size > 0);
    result(await request(recovery, "/api/auth", { method: "POST", body: { action: "update", password: replacementPassword } }), 200);
    const reused = await request(session(), path);
    assert.ok(new URL(reused.headers.get("location"), appOrigin).searchParams.get("error") === "link");
    result(await request(recovery, "/api/auth", { method: "POST", body: { action: "signout" } }), 200);
    alice.jar = session();
    result(await request(alice.jar, "/api/auth", { method: "POST", body: { action: "login", email: alice.email, password } }), 401, "LOGIN_FAILED");
    result(await request(alice.jar, "/api/auth", { method: "POST", body: { action: "login", email: alice.email, password: replacementPassword } }), 200);
    assert.equal(result(await request(alice.jar, "/api/config"), 200).userId, alice.id);
  });
  await check("signout alias clears the session and anonymous password update is denied", async () => {
    result(await request(alice.jar, "/api/auth/signout", { method: "POST", body: { action: "signout" } }), 200);
    result(await request(alice.jar, "/api/config"), 401, "SIGN_IN_REQUIRED");
    result(await request(session(), "/api/auth", { method: "POST", body: { action: "update", password: replacementPassword } }), 401, "SIGN_IN_REQUIRED");
  });
  console.log(`${passed} real Next/Supabase Auth integration checks passed.`);
  console.log("Recovery callback/token use was tested locally; SMTP delivery was not tested by this script.");
} finally {
  const failures = [];
  let removed = 0;
  for (const user of users) {
    try { await request(user.jar, "/api/auth", { method: "POST", body: { action: "signout" } }); } catch { /* Auth deletion still attempted */ }
    const id = user.id || (await lookup(user.email))?.id;
    if (id) {
      const deleted = await service.auth.admin.deleteUser(id);
      if (deleted.error) failures.push(id);
      else removed++;
    }
  }
  if (failures.length) throw new Error(`Could not remove temporary local Auth identities: ${failures.join(", ")}.`);
  console.log(`CLEANUP removed ${removed} temporary Next/Auth test users.`);
}
