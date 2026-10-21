import assert from "node:assert/strict";
import { planStockClipQualities, STOCK_PREFLIGHT_BUDGET_BYTES } from "../lib/stock-preflight.ts";

const MiB = 1024 * 1024;
const quotes = [
  { id: 1, medium: 40 * MiB, small: 20 * MiB, tiny: 5 * MiB },
  { id: 2, medium: 40 * MiB, small: 20 * MiB, tiny: 5 * MiB },
  { id: 3, medium: 40 * MiB, small: 20 * MiB, tiny: 5 * MiB },
];
const planned = planStockClipQualities(quotes);
assert.ok(planned.reduce((sum, clip) => sum + clip.quotedBytes, 0) <= STOCK_PREFLIGHT_BUDGET_BYTES);
assert.ok(planned.some(clip => clip.quality !== "medium"));
assert.deepEqual(planStockClipQualities([{ id: 4, medium: 8 * MiB, small: 3 * MiB, tiny: null }]), [
  { id: 4, quality: "medium", quotedBytes: 8 * MiB },
]);
assert.equal(planStockClipQualities([{ id: 4, medium: 8 * MiB, small: 3 * MiB, tiny: null }], new Map([["4:small", 3 * MiB]]))[0].quality, "small");
assert.throws(() => planStockClipQualities([{ id: 5, medium: 65 * MiB, small: null, tiny: null }]), /thay cảnh/i);
assert.throws(() => planStockClipQualities([
  { id: 6, medium: 50 * MiB, small: 45 * MiB, tiny: 44 * MiB },
  { id: 7, medium: 50 * MiB, small: 45 * MiB, tiny: 44 * MiB },
]), /vượt giới hạn/i);
assert.throws(() => planStockClipQualities([quotes[0], quotes[0]]), /không hợp lệ/i);
console.log("Stock clip preflight tests passed.");
