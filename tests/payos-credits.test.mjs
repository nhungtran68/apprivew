import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { PayOS } from "@payos/node";
import ts from "typescript";

// Offline contract tests. The real payOS SDK checks webhook HMACs; all API and
// database traffic is local, so this suite never creates a payable order.
const root = process.cwd();
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checksumKey = "offline-checksum-key";
const linkIdFor = code => `plink_${code}`;
const packs = new Map([["pack_500", { id: "pack_500", name: "500 credit", credits: 500, price_vnd: 50_000, enabled: true }]]);
const gatewayState = { provider: "payos", webhook_url: null, webhook_confirmed_at: null, credential_fingerprint: null };
const orders = new Map();
const provider = new Map();
const calls = { create: [], get: [], cancel: [], beginReconcile: [], markPaid: [], markClosed: [] };
const wallet = new Map([[alice, 0], [bob, 0]]);

function jsonOrder(order) {
  return {
    orderId: order.request_id, userId: order.user_id, orderCode: order.order_code,
    packId: order.pack_id, credits: order.credits, priceVnd: order.price_vnd,
    status: order.status, checkoutUrl: order.checkout_url,
    paymentLinkId: order.provider_payment_link_id,
  };
}

function query(table) {
  const filters = [];
  let update = null;
  const builder = {
    select() { return this; },
    update(values) { update = values; return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    order() { return this; },
    async limit() { return { data: [...packs.values()].filter(row => row.enabled), error: null }; },
    async maybeSingle() {
      const source = table === "studio_payment_packs" ? packs.values()
        : table === "studio_payment_gateway" ? [gatewayState] : orders.values();
      const data = [...source].find(row => filters.every(([key, value]) => row[key] === value));
      if (data && update) Object.assign(data, update);
      return { data: data ?? null, error: null };
    },
  };
  return builder;
}

const db = {
  from: query,
  async rpc(name, args) {
    if (name === "studio_payment_begin_reconcile") {
      calls.beginReconcile.push(args);
      const order = [...orders.values()].find(item => item.order_code === args.p_order_code && item.user_id === args.p_user_id);
      const now = Date.now();
      if (!order || order.status === "paid" || (order.last_reconciled_at && now - order.last_reconciled_at < 15_000))
        return { data: false, error: null };
      order.last_reconciled_at = now;
      return { data: true, error: null };
    }
    if (name === "studio_payment_create") {
      const existing = orders.get(args.p_request_id);
      if (existing) return { data: { ...jsonOrder(existing), created: false }, error: null };
      const pack = packs.get(args.p_pack_id);
      if (!pack || !pack.enabled || pack.credits !== args.p_credits || pack.price_vnd !== args.p_price_vnd)
        return { data: null, error: { message: "PAYMENT_PACK_MISMATCH" } };
      const order = {
        request_id: args.p_request_id, user_id: args.p_user_id, order_code: args.p_order_code,
        pack_id: args.p_pack_id, credits: pack.credits, price_vnd: pack.price_vnd,
        status: "pending", checkout_url: null, provider_payment_link_id: null,
        updated_at: new Date().toISOString(),
      };
      orders.set(args.p_request_id, order);
      return { data: { ...jsonOrder(order), created: true }, error: null };
    }
    const order = name === "studio_payment_set_link" ? orders.get(args.p_request_id)
      : [...orders.values()].find(item => item.order_code === args.p_order_code);
    if (!order) return { data: null, error: { message: "PAYMENT_ORDER_MISSING" } };
    if (name === "studio_payment_set_link") {
      order.checkout_url = args.p_checkout_url;
      order.provider_payment_link_id = args.p_payment_link_id;
      order.updated_at = new Date().toISOString();
    } else if (name === "studio_payment_mark_paid") {
      calls.markPaid.push(args);
      if (args.p_amount_vnd !== order.price_vnd || args.p_reference !== order.provider_payment_link_id)
        return { data: null, error: { message: "PAYMENT_AMOUNT_MISMATCH" } };
      if (order.status !== "paid") {
        order.status = "paid";
        wallet.set(order.user_id, wallet.get(order.user_id) + order.credits);
      }
    } else if (name === "studio_payment_mark_closed") {
      calls.markClosed.push(args);
      if (order.status !== "paid") order.status = args.p_status;
    } else throw new Error(`Unexpected RPC ${name}`);
    return { data: jsonOrder(order), error: null };
  },
};

class FakePayOS {
  constructor(options) {
    this.webhooks = new PayOS(options).webhooks;
    this.paymentRequests = {
      create: async payload => {
        calls.create.push(payload);
        const linkId = linkIdFor(payload.orderCode);
        const result = {
          orderCode: payload.orderCode, amount: payload.amount, paymentLinkId: linkId,
          checkoutUrl: `https://pay.payos.vn/web/${linkId}`, currency: "VND",
        };
        provider.set(payload.orderCode, {
          orderCode: payload.orderCode, amount: payload.amount, amountPaid: 0,
          id: linkId, status: "PENDING",
        });
        return result;
      },
      get: async code => {
        calls.get.push(code);
        const result = provider.get(code);
        if (!result) throw new Error("Provider order missing");
        return result;
      },
      cancel: async linkId => {
        calls.cancel.push(linkId);
        const result = [...provider.values()].find(item => item.id === linkId);
        if (!result) throw new Error("Provider order missing");
        if (result.status === "PENDING") result.status = "CANCELLED";
        return result;
      },
    };
  }
}

const context = vm.createContext({
  console, URL, Request, Response, Headers, TextEncoder, TextDecoder,
  process: { env: {
    PAYOS_CLIENT_ID: "offline-client", PAYOS_API_KEY: "offline-api-key",
    PAYOS_CHECKSUM_KEY: checksumKey, NEXT_PUBLIC_SUPABASE_URL: "https://db.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
  } },
});
const modules = new Map(), synthetics = new Map();
const server = {
  limitedJson: async request => request.json(),
  json: (value, status = 200) => Response.json(value, { status }),
  apiError: error => Response.json({ code: error.code || "INTERNAL_ERROR" }, { status: error.status || 500 }),
};
const mocks = new Map([
  ["server-only", {}],
  ["node:crypto", { createHash }],
  ["@payos/node", { PayOS: FakePayOS }],
  ["@supabase/supabase-js", { createClient: () => db }],
  [path.join(root, "lib/studio-supabase.ts"), { createStudioSupabaseServer: async () => db }],
  [path.join(root, "lib/studio-server.ts"), server],
]);

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
async function entry(file) {
  const module = await load(path.join(root, file));
  if (module.status === "unlinked") await module.link(linker);
  if (module.status !== "evaluated") await module.evaluate();
  return module.namespace;
}

const payments = await entry("lib/studio-payments.ts");
const webhook = await entry("app/api/payments/payos/webhook/route.ts");
assert.equal(await payments.paymentReady(), false);
await assert.rejects(payments.createPaymentOrder(alice, "pack_500", requestId, "https://apprivew.vercel.app"), { code: "PAYMENT_NOT_READY" });
assert.equal(orders.size, 0, "no payable order before webhook registration");
await payments.recordWebhookConfirmation(payments.PAYOS_PRODUCTION_WEBHOOK);
assert.equal(await payments.paymentReady(), true);
assert.match(gatewayState.credential_fingerprint, /^[a-f0-9]{64}$/);
context.process.env.PAYOS_CHECKSUM_KEY = "rotated-offline-key";
assert.equal(await payments.paymentReady(), false, "rotating payOS keys invalidates prior webhook confirmation");
await assert.rejects(payments.createPaymentOrder(alice, "pack_500", requestId, "https://apprivew.vercel.app"), { code: "PAYMENT_NOT_READY" });
assert.equal(orders.size, 0);
context.process.env.PAYOS_CHECKSUM_KEY = checksumKey;
assert.equal(await payments.paymentReady(), true);
assert.equal(payments.paymentOrderCode(requestId), payments.paymentOrderCode(requestId.toUpperCase()));
assert.ok(payments.paymentOrderCode(requestId) <= Number.MAX_SAFE_INTEGER);
assert.throws(() => payments.parseOrderCode("1e5"), { code: "INVALID_ORDER_CODE" });
assert.throws(() => payments.paymentOrderCode("not-a-uuid"), { code: "INVALID_PAYMENT_REQUEST" });

const created = await payments.createPaymentOrder(alice, "pack_500", requestId, "https://apprivew.vercel.app");
assert.equal(created.priceVnd, 50_000);
assert.equal(created.credits, 500);
assert.equal(created.credited, false);
assert.equal(wallet.get(alice), 0);
assert.equal(calls.create.length, 1);
assert.equal(calls.create[0].description.length <= 9, true);
assert.equal(calls.create[0].returnUrl, `https://apprivew.vercel.app/nap-credit?orderCode=${created.orderCode}`);
assert.equal(calls.create[0].amount, 50_000);
assert.equal(calls.create[0].items[0].price, 50_000);
assert.equal(created.checkoutUrl, `https://pay.payos.vn/web/${linkIdFor(Number(created.orderCode))}`);

packs.get("pack_500").price_vnd = 60_000; // Price changes after order creation.
const repeated = await payments.createPaymentOrder(alice, "pack_500", requestId, "https://apprivew.vercel.app");
assert.equal(repeated.priceVnd, 50_000);
assert.equal(calls.create.length, 1, "same request must reuse the existing provider link");
assert.equal(calls.get.length, 1, "retry must verify that the provider link still works");
await assert.rejects(payments.createPaymentOrder(alice, "pack_other", requestId, "https://apprivew.vercel.app"), { code: "PAYMENT_ORDER_CONFLICT" });
await assert.rejects(payments.createPaymentOrder(bob, "pack_500", requestId, "https://apprivew.vercel.app"), { code: "PAYMENT_ORDER_CONFLICT" });

// payOS webhook signatures cover the data object, independent of the request
// success flag. The payload below uses the documented sorted-key HMAC format.
function signedBody(data) {
  const query = Object.keys(data).sort().map(key => `${key}=${data[key]}`).join("&");
  const signature = createHmac("sha256", checksumKey).update(query).digest("hex");
  return { code: "00", success: true, data, signature };
}
function webhookRequest(body) {
  return new Request("https://apprivew.vercel.app/api/payments/payos/webhook", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const webhookData = {
  amount: 50_000, code: "00", currency: "VND", orderCode: Number(created.orderCode),
  paymentLinkId: linkIdFor(Number(created.orderCode)), reference: "bank_ref_123", desc: "success",
};
const invalid = signedBody(webhookData);
invalid.data = { ...webhookData, amount: 1 };
const invalidResponse = await webhook.POST(webhookRequest(invalid));
assert.equal(invalidResponse.status, 400);
assert.equal(wallet.get(alice), 0);
assert.equal(calls.markPaid.length, 0);

const wrongAmountResponse = await webhook.POST(webhookRequest(signedBody({ ...webhookData, amount: 49_999 })));
assert.equal(wrongAmountResponse.status, 409);
assert.equal(wallet.get(alice), 0);
assert.equal(calls.markPaid.length, 0);

const wrongLinkResponse = await webhook.POST(webhookRequest(signedBody({ ...webhookData, paymentLinkId: "plink_999999999999999" })));
assert.equal(wrongLinkResponse.status, 409);
assert.equal(wallet.get(alice), 0);

const success = signedBody(webhookData);
assert.equal((await webhook.POST(webhookRequest(success))).status, 200);
assert.equal(wallet.get(alice), 500);
assert.equal((await webhook.POST(webhookRequest(success))).status, 200);
assert.equal(wallet.get(alice), 500, "duplicate payOS delivery must not top up twice");
assert.equal((await payments.getPaymentOrderForUser(alice, Number(created.orderCode))).credited, true);
assert.equal((await payments.reconcilePaymentOrder(alice, Number(created.orderCode))).credited, true);
assert.equal(calls.get.length, 1, "credited orders do not need another provider lookup");
assert.equal((await webhook.POST(webhookRequest(signedBody({ ...webhookData, orderCode: 987654321 })))).status, 200);
assert.equal(wallet.get(alice), 500, "signed webhook registration sample cannot grant credits");

// The browser return URL is never proof of payment. Reconciliation consults
// payOS and requires the full amount to have actually been received.
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const second = await payments.createPaymentOrder(bob, "pack_500", secondId, "https://apprivew.vercel.app");
assert.equal(wallet.get(bob), 0);
assert.equal((await payments.getPaymentOrderForUser(bob, Number(second.orderCode))).credited, false);
const lookupsBeforePending = calls.get.length;
assert.equal((await payments.reconcilePaymentOrder(bob, Number(second.orderCode))).credited, false);
assert.equal((await payments.reconcilePaymentOrder(bob, Number(second.orderCode))).credited, false);
assert.equal(calls.get.length - lookupsBeforePending, 1, "repeated immediate reconcile must not query payOS twice");
orders.get(secondId).last_reconciled_at = Date.now() - 16_000;
const remote = provider.get(Number(second.orderCode));
remote.status = "PAID";
remote.amountPaid = 59_000;
await assert.rejects(payments.reconcilePaymentOrder(bob, Number(second.orderCode)), { code: "PAYMENT_MISMATCH" });
assert.equal(wallet.get(bob), 0);
orders.get(secondId).last_reconciled_at = Date.now() - 16_000;
remote.amountPaid = 60_000;
assert.equal((await payments.reconcilePaymentOrder(bob, Number(second.orderCode))).credited, true);
assert.equal(wallet.get(bob), 500);
assert.equal((await payments.reconcilePaymentOrder(bob, Number(second.orderCode))).credited, true);
assert.equal(wallet.get(bob), 500);

// A stored link is never reused once payOS reports it expired, even if the
// local webhook was missed. No new payable link or credit is created here.
const expiredId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const expired = await payments.createPaymentOrder(bob, "pack_500", expiredId);
provider.get(Number(expired.orderCode)).status = "EXPIRED";
const createCountBeforeExpiry = calls.create.length;
const expiredRetry = await payments.createPaymentOrder(bob, "pack_500", expiredId);
assert.equal(expiredRetry.status, "expired");
assert.equal(calls.create.length, createCountBeforeExpiry);
assert.equal(wallet.get(bob), 500);

// If the provider still says PENDING after the 15-minute link lifetime, close
// that provider link first. This prevents two simultaneously payable orders.
const staleId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const stale = await payments.createPaymentOrder(bob, "pack_500", staleId);
orders.get(staleId).updated_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
const cancelledBefore = calls.cancel.length;
const staleRetry = await payments.createPaymentOrder(bob, "pack_500", staleId);
assert.equal(staleRetry.status, "cancelled");
assert.equal(calls.cancel.length, cancelledBefore + 1);
assert.equal(provider.get(Number(stale.orderCode)).status, "CANCELLED");
assert.equal(wallet.get(bob), 500);

// An underpaid order must never be cancelled automatically just because its
// original checkout window elapsed: the customer's partial money needs review.
const partialId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const partial = await payments.createPaymentOrder(bob, "pack_500", partialId);
orders.get(partialId).updated_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
const partialProvider = provider.get(Number(partial.orderCode));
partialProvider.status = "UNDERPAID";
partialProvider.amountPaid = 20_000;
const cancelsBeforePartial = calls.cancel.length;
await assert.rejects(payments.createPaymentOrder(bob, "pack_500", partialId), { code: "PAYMENT_IN_PROGRESS" });
assert.equal(calls.cancel.length, cancelsBeforePartial);
assert.equal(wallet.get(bob), 500);
partialProvider.status = "EXPIRED";
await assert.rejects(payments.createPaymentOrder(bob, "pack_500", partialId), { code: "PAYMENT_UNDERPAID" });
await assert.rejects(payments.reconcilePaymentOrder(bob, Number(partial.orderCode)), { code: "PAYMENT_UNDERPAID" });
assert.equal(orders.get(partialId).status, "pending", "partial transfer needs manual review, not a clean expiry");
assert.equal(wallet.get(bob), 500);

// A late PAID status is verified and credited exactly once instead of sending
// the customer back to an already completed checkout page.
const latePaidId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const latePaid = await payments.createPaymentOrder(bob, "pack_500", latePaidId);
const paidProvider = provider.get(Number(latePaid.orderCode));
paidProvider.status = "PAID";
paidProvider.amountPaid = latePaid.priceVnd;
assert.equal((await payments.createPaymentOrder(bob, "pack_500", latePaidId)).credited, true);
assert.equal((await payments.createPaymentOrder(bob, "pack_500", latePaidId)).credited, true);
assert.equal(wallet.get(bob), 1_000);

console.log("PASS payOS order idempotency, price snapshot, signed webhook validation, reconciliation and single credit grant");
