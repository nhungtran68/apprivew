import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const old = new Date(Date.now() - 10 * 60_000).toISOString();
const fresh = new Date().toISOString();
const rows = [
  { request_id: "1", order_code: 101, price_vnd: 50_000, provider_payment_link_id: "link_101", status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "2", order_code: 102, price_vnd: 50_000, provider_payment_link_id: "link_102", status: "expired", created_at: old, last_reconciled_at: null },
  { request_id: "3", order_code: 103, price_vnd: 50_000, provider_payment_link_id: "link_103", status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "4", order_code: 104, price_vnd: 50_000, provider_payment_link_id: "link_104", status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "5", order_code: 105, price_vnd: 50_000, provider_payment_link_id: "link_105", status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "6", order_code: 106, price_vnd: 50_000, provider_payment_link_id: "link_106", status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "7", order_code: 107, price_vnd: 50_000, provider_payment_link_id: "link_107", status: "pending", created_at: fresh, last_reconciled_at: null },
  { request_id: "8", order_code: 108, price_vnd: 50_000, provider_payment_link_id: null, status: "pending", created_at: old, last_reconciled_at: null },
  { request_id: "9", order_code: 109, price_vnd: 50_000, provider_payment_link_id: "link_109", status: "paid", created_at: old, last_reconciled_at: null },
  { request_id: "10", order_code: 110, price_vnd: 50_000, provider_payment_link_id: "link_110", status: "expired", created_at: old, last_reconciled_at: null },
];
for (const row of rows) row.provider = "payos";
const provider = new Map([
  [101, { orderCode: 101, amount: 50_000, amountPaid: 50_000, id: "link_101", status: "PAID" }],
  [102, { orderCode: 102, amount: 50_000, amountPaid: 50_000, id: "link_102", status: "PAID" }],
  [103, { orderCode: 103, amount: 50_000, amountPaid: 0, id: "link_103", status: "EXPIRED" }],
  [104, { orderCode: 104, amount: 50_000, amountPaid: 10_000, id: "link_104", status: "UNDERPAID" }],
  [105, { orderCode: 105, amount: 50_000, amountPaid: 10_000, id: "link_105", status: "CANCELLED" }],
  [106, { orderCode: 106, amount: 50_000, amountPaid: 50_000, id: "wrong_link", status: "PAID" }],
  [110, { orderCode: 110, amount: 50_000, amountPaid: 10_000, id: "link_110", status: "EXPIRED" }],
]);
const calls = { db: 0, get: [], paid: [], closed: [] };
let balance = 0;

function query() {
  const conditions = [];
  const sorts = [];
  let update = null;
  return {
    select() { return this; },
    update(values) { update = values; return this; },
    eq(key, value) { conditions.push(row => row[key] === value); return this; },
    neq(key, value) { conditions.push(row => row[key] !== value); return this; },
    in(key, values) { conditions.push(row => values.includes(row[key])); return this; },
    not(key, operation, value) {
      assert.equal(operation, "is");
      assert.equal(value, null);
      conditions.push(row => row[key] !== null);
      return this;
    },
    lte(key, value) { conditions.push(row => row[key] <= value); return this; },
    gte(key, value) { conditions.push(row => row[key] >= value); return this; },
    order(key, options) { sorts.push([key, options]); return this; },
    async limit(count) {
      const selected = rows.filter(row => conditions.every(test => test(row)));
      selected.sort((a, b) => {
        for (const [key, options] of sorts) {
          const av = a[key], bv = b[key];
          if (av === bv) continue;
          if (av === null) return options.nullsFirst ? -1 : 1;
          if (bv === null) return options.nullsFirst ? 1 : -1;
          return (av < bv ? -1 : 1) * (options.ascending ? 1 : -1);
        }
        return 0;
      });
      return { data: selected.slice(0, count).map(row => ({ ...row })), error: null };
    },
    then(resolve, reject) {
      assert.ok(update, "only updates are awaited without limit");
      for (const row of rows.filter(row => conditions.every(test => test(row)))) Object.assign(row, update);
      return Promise.resolve({ error: null }).then(resolve, reject);
    },
  };
}

class StudioError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const mocks = new Map([
  ["server-only", {}],
  ["node:crypto", { timingSafeEqual }],
  ["@supabase/supabase-js", { createClient: () => { calls.db++; return { from: query }; } }],
  [path.join(root, "lib/studio-contract.ts"), { StudioError }],
  [path.join(root, "lib/studio-payments.ts"), {
    parseOrderCode(value) { return Number(value); },
    payos() { return { paymentRequests: { async get(code) {
      calls.get.push(code);
      if (!provider.has(code)) throw new Error("Missing provider order");
      return provider.get(code);
    } } }; },
    async markPaymentPaid(code, amount, linkId) {
      calls.paid.push(code);
      const row = rows.find(item => item.order_code === code);
      assert.equal(row.price_vnd, amount);
      assert.equal(row.provider_payment_link_id, linkId);
      const created = row.status !== "paid";
      if (created) { row.status = "paid"; balance += 500; }
      return { credited: true, created };
    },
    async markPaymentClosed(code, status) {
      calls.closed.push(code);
      const row = rows.find(item => item.order_code === code);
      if (row.status === "pending") row.status = status;
      return { credited: row.status === "paid" };
    },
  }],
  [path.join(root, "lib/studio-server.ts"), {
    json: (value, status = 200) => Response.json(value, { status }),
    apiError: error => Response.json({ code: error.code ?? "INTERNAL_ERROR" }, { status: error.status ?? 500 }),
  }],
]);

const logs = [];
const context = vm.createContext({
  Buffer, Request, Response,
  console: { error: (...args) => logs.push(args) },
  process: { env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://db.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "offline-service-key",
    CRON_SECRET: "a-random-test-secret-over-24-chars",
  } },
});
const modules = new Map(), synthetics = new Map();
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  const source = await fs.readFile(file, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = new vm.SourceTextModule(code, { context, identifier: file });
  modules.set(file, module);
  return module;
}
async function linker(specifier, parent) {
  const file = mocks.has(specifier) ? specifier : specifier.startsWith("@/")
    ? `${path.join(root, specifier.slice(2))}.ts`
    : `${path.resolve(path.dirname(parent.identifier), specifier)}.ts`;
  if (mocks.has(file)) {
    if (synthetics.has(file)) return synthetics.get(file);
    const exports = mocks.get(file);
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
    synthetics.set(file, module);
    return module;
  }
  return load(file);
}
const route = await load(path.join(root, "app/api/payments/payos/scheduled/route.ts"));
await route.link(linker);
await route.evaluate();
const { GET } = route.namespace;
const request = authorization => new Request("https://apprivew.vercel.app/api/payments/payos/scheduled", {
  headers: authorization ? { authorization } : {},
});

const config = JSON.parse(await fs.readFile(path.join(root, "vercel.json"), "utf8"));
assert.ok(config.crons.some(job => job.path === "/api/payments/payos/scheduled" && job.schedule === "30 3 * * *"));
assert.equal((await GET(request())).status, 403);
assert.equal((await GET(request("Bearer wrong"))).status, 403);
assert.equal(calls.db, 0, "unauthorized requests must not reach the database");
context.process.env.CRON_SECRET = "short";
assert.equal((await GET(request("Bearer short"))).status, 503);
assert.equal(calls.db, 0, "misconfigured cron must not reconcile");
context.process.env.CRON_SECRET = "a-random-test-secret-over-24-chars";

const response = await GET(request(`Bearer ${context.process.env.CRON_SECRET}`));
assert.equal(response.status, 503, "identity mismatch and partial closed payments must be surfaced");
assert.deepEqual(await response.json(), {
  scanned: 7, credited: 2, closed: 1, pending: 1, unchanged: 0, failed: 3,
});
assert.equal(balance, 1_000);
assert.deepEqual(calls.paid.sort(), [101, 102]);
assert.deepEqual(calls.closed, [103]);
assert.equal(rows.find(row => row.order_code === 105).status, "pending", "partial closed payment needs review");
assert.equal(rows.find(row => row.order_code === 110).status, "expired", "previously closed partial payment needs review");
assert.equal(rows.find(row => row.order_code === 106).status, "pending", "wrong link cannot credit");
assert.ok(!calls.get.includes(107) && !calls.get.includes(108) && !calls.get.includes(109));

provider.set(104, { ...provider.get(104), status: "PAID", amountPaid: 50_000 });
await GET(request(`Bearer ${context.process.env.CRON_SECRET}`));
assert.equal(balance, 1_500, "a subsequent full payment is credited once");
await GET(request(`Bearer ${context.process.env.CRON_SECRET}`));
assert.equal(balance, 1_500, "repeated cron delivery cannot credit again");
assert.ok(logs.some(parts => String(parts[0]).includes("reconciliation failed")));

console.log("payOS scheduled reconciliation tests passed");
