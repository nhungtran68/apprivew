export type TimedWord = { text: string; start: number; end: number };
export type AudioScene = { text: string; startFraction: number; endFraction: number };

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Keep scene boundaries near the spoken words while leaving the source audio untouched. */
export function audioSceneDurations(scenes: AudioScene[], words: TimedWord[], duration: number): number[] {
  if (!scenes.length || !Number.isFinite(duration) || duration <= 0) return [];
  const counts = scenes.map(scene => Math.max(1, wordCount(scene.text)));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const validWords = words.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end)
    && word.start >= 0 && word.end >= word.start && word.end <= duration + 1);
  const useWords = validWords.length >= 2 && validWords.length >= total * 0.7 && validWords.length <= total * 1.3;
  const boundaries = [0];
  let elapsedWords = 0;
  for (let index = 0; index < scenes.length - 1; index++) {
    elapsedWords += counts[index];
    let boundary: number;
    if (useWords) {
      const next = Math.max(1, Math.min(validWords.length - 1, Math.round(elapsedWords / total * validWords.length)));
      boundary = (validWords[next - 1].end + validWords[next].start) / 2;
    } else {
      const fraction = Number(scenes[index].endFraction);
      boundary = Number.isFinite(fraction) ? fraction * duration : elapsedWords / total * duration;
    }
    const min = boundaries[index] + 0.05;
    const max = duration - (scenes.length - index - 1) * 0.05;
    boundaries.push(Math.max(min, Math.min(max, boundary)));
  }
  boundaries.push(duration);
  return scenes.map((_, index) => boundaries[index + 1] - boundaries[index]);
}
