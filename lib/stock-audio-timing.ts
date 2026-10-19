/**
 * An optional local timing hint for stock-video scenes. This finds nearby
 * low-energy pauses in decoded audio; it does not recognize words or perform
 * forced alignment. The MP4 exporter still measures the audio independently.
 */
export type StockAudioTiming = {
  durations: number[];
  boundaries: number[];
  totalDuration: number;
  silenceAligned: boolean;
};

const MAX_SHIFT_SECONDS = 0.6;
const SAMPLE_STEP_SECONDS = 0.02;
const ENERGY_WINDOW_SECONDS = 0.03;

function validWeights(weights: number[]): boolean {
  return Array.isArray(weights) && weights.length > 0 && weights.length <= 24
    && weights.every(weight => typeof weight === "number" && Number.isFinite(weight) && weight > 0);
}

function proportionalBoundaries(weights: number[], duration: number): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const result = [0];
  let cumulative = 0;
  for (let index = 0; index < weights.length - 1; index++) {
    cumulative += weights[index];
    result.push(duration * cumulative / total);
  }
  result.push(duration);
  return result;
}

function asTiming(boundaries: number[], silenceAligned: boolean): StockAudioTiming {
  return {
    boundaries,
    durations: boundaries.slice(1).map((end, index) => end - boundaries[index]),
    totalDuration: boundaries[boundaries.length - 1],
    silenceAligned,
  };
}

function rmsAt(channels: readonly Float32Array[], sampleRate: number, seconds: number): number {
  const center = Math.round(seconds * sampleRate);
  const radius = Math.max(4, Math.round(sampleRate * ENERGY_WINDOW_SECONDS / 2));
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    const start = Math.max(0, center - radius);
    const end = Math.min(channel.length, center + radius);
    for (let index = start; index < end; index++) {
      sum += channel[index] * channel[index];
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : Infinity;
}

/** Select a nearby genuine pause, or return the expected cut when none exists. */
export function nearestQuietBoundary(channels: readonly Float32Array[], sampleRate: number,
  expected: number, lower: number, upper: number, maxShift = MAX_SHIFT_SECONDS): number {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate < 1000 || !Number.isFinite(expected)
    || !Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) return expected;
  const start = Math.max(lower, expected - maxShift);
  const end = Math.min(upper, expected + maxShift);
  if (end <= start) return Math.min(upper, Math.max(lower, expected));
  const candidates: { time: number; energy: number }[] = [];
  for (let time = start; time <= end + 0.000001; time += SAMPLE_STEP_SECONDS) {
    candidates.push({ time: Math.min(time, end), energy: rmsAt(channels, sampleRate, Math.min(time, end)) });
  }
  if (candidates.at(-1)!.time < end - SAMPLE_STEP_SECONDS / 2)
    candidates.push({ time: end, energy: rmsAt(channels, sampleRate, end) });
  const energies = candidates.map(candidate => candidate.energy).filter(Number.isFinite);
  if (!energies.length) return expected;
  const minimum = Math.min(...energies), peak = Math.max(...energies);
  // A small dip in continuous speech or music is not a reliable scene cut.
  if (minimum > 0.04 || (peak > 0.005 && minimum > peak * 0.45)) return expected;
  const quietThreshold = Math.min(0.04, minimum * 1.5 + 0.002, peak * 0.25 + 0.002);
  const pauses = candidates.filter(candidate => candidate.energy <= quietThreshold);
  if (!pauses.length) return expected;
  pauses.sort((a, b) => Math.abs(a.time - expected) - Math.abs(b.time - expected) || a.energy - b.energy);
  return pauses[0].time;
}

/** Pure algorithm, also usable with synthetic PCM in tests. */
export function alignSceneWeightsToSamples(channels: readonly Float32Array[], sampleRate: number,
  duration: number, weights: number[]): StockAudioTiming {
  if (!validWeights(weights) || !Number.isFinite(duration) || duration <= 0)
    throw new Error("Thời lượng hoặc danh sách phân cảnh không hợp lệ.");
  const base = proportionalBoundaries(weights, duration);
  if (weights.length === 1 || !channels.length) return asTiming(base, false);
  const boundaries = [0];
  const minimumScene = Math.min(0.2, duration / (weights.length * 2));
  let moved = false;
  for (let index = 1; index < weights.length; index++) {
    const lower = boundaries[index - 1] + minimumScene;
    const upper = duration - (weights.length - index) * minimumScene;
    const expected = Math.min(upper, Math.max(lower, base[index]));
    const selected = nearestQuietBoundary(channels, sampleRate, expected, lower, upper);
    boundaries.push(selected);
    if (Math.abs(selected - expected) > SAMPLE_STEP_SECONDS) moved = true;
  }
  boundaries.push(duration);
  return asTiming(boundaries, moved);
}

/**
 * Decode locally through Web Audio. Decode failures and unsupported browsers
 * retain the proportional timing, so users can still export their video.
 */
export async function alignStockSceneDurations(audio: Blob, weights: number[], fallbackDuration: number): Promise<StockAudioTiming> {
  if (!validWeights(weights) || !Number.isFinite(fallbackDuration) || fallbackDuration <= 0)
    throw new Error("Thời lượng hoặc danh sách phân cảnh không hợp lệ.");
  const fallback = asTiming(proportionalBoundaries(weights, fallbackDuration), false);
  if (typeof window === "undefined" || !(audio instanceof Blob) || !audio.size || audio.size > 32 * 1024 * 1024) return fallback;
  const browser = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextType = browser.AudioContext ?? browser.webkitAudioContext;
  if (!AudioContextType) return fallback;
  let context: AudioContext | undefined;
  try {
    context = new AudioContextType();
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 90.5
      || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate < 1000
      || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) return fallback;
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    return alignSceneWeightsToSamples(channels, decoded.sampleRate, decoded.duration, weights);
  } catch { return fallback; }
  finally { await context?.close().catch(() => {}); }
}
