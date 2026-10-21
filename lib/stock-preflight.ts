export type StockQuality = "medium" | "small" | "tiny";
export type StockClipQuote = {
  id: number;
  medium: number | null;
  small: number | null;
  tiny: number | null;
};
export type PlannedStockClip = { id: number; quality: StockQuality; quotedBytes: number };

// The existing exporter accepts at most 90 MiB of stock video. Reserve 6 MiB
// for small differences between provider metadata and downloaded media.
export const STOCK_PREFLIGHT_BUDGET_BYTES = 84 * 1024 * 1024;
const MAX_CLIP_BYTES = 60 * 1024 * 1024;
const QUALITIES: StockQuality[] = ["medium", "small", "tiny"];

function usableBytes(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_CLIP_BYTES;
}

/** Choose the best available renditions before any paid clip download starts. */
export function planStockClipQualities(
  quotes: StockClipQuote[],
  cached?: ReadonlyMap<string, number>,
): PlannedStockClip[] {
  if (!quotes.length || quotes.length > 12 || new Set(quotes.map(quote => quote.id)).size !== quotes.length)
    throw new Error("Danh sách video không hợp lệ. Hãy chọn lại các cảnh.");
  const plan = quotes.map(quote => {
    const available = QUALITIES.filter(quality => usableBytes(quote[quality]));
    if (!available.length) throw new Error(`Cảnh #${quote.id} không còn bản video phù hợp. Hãy thay cảnh này.`);
    // Prefer a rendition already downloaded in this session when it remains
    // usable. The user is not charged again merely for reordering scenes.
    const cachedQuality = available.find(quality => cached?.has(`${quote.id}:${quality}`));
    const quality = cachedQuality || available[0];
    return { id: quote.id, quality, quotedBytes: quote[quality]! };
  });
  let total = plan.reduce((sum, clip) => sum + clip.quotedBytes, 0);
  while (total > STOCK_PREFLIGHT_BUDGET_BYTES) {
    let bestIndex = -1;
    let nextQuality: StockQuality | undefined;
    let bestSavings = 0;
    for (let index = 0; index < plan.length; index++) {
      const current = plan[index];
      const quote = quotes[index];
      for (const quality of QUALITIES.slice(QUALITIES.indexOf(current.quality) + 1)) {
        if (!usableBytes(quote[quality])) continue;
        const savings = current.quotedBytes - quote[quality]!;
        if (savings > bestSavings) { bestIndex = index; nextQuality = quality; bestSavings = savings; }
      }
    }
    if (bestIndex < 0 || !nextQuality)
      throw new Error("Tư liệu đã chọn vượt giới hạn ghép 90 MB ngay cả ở bản nhỏ. Hãy thay một vài cảnh ngắn hơn.");
    const quote = quotes[bestIndex];
    total -= bestSavings;
    plan[bestIndex] = { id: quote.id, quality: nextQuality, quotedBytes: quote[nextQuality]! };
  }
  return plan;
}
