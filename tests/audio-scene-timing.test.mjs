import assert from "node:assert/strict";
import { audioSceneDurations } from "../lib/audio-scene-timing.ts";

const scenes = [
  { text: "Mở đầu câu chuyện", startFraction: 0, endFraction: 0.5 },
  { text: "Rồi đến phần sau", startFraction: 0.5, endFraction: 1 },
];
const words = [
  { text: "Mở", start: 1, end: 1.3 },
  { text: "đầu", start: 1.3, end: 1.6 },
  { text: "câu", start: 1.6, end: 1.9 },
  { text: "chuyện", start: 1.9, end: 2.2 },
  { text: "Rồi", start: 6, end: 6.2 },
  { text: "đến", start: 6.2, end: 6.4 },
  { text: "phần", start: 6.4, end: 6.6 },
  { text: "sau", start: 6.6, end: 7 },
];
const timed = audioSceneDurations(scenes, words, 8);
assert.deepEqual(timed, [4.1, 3.9000000000000004]);
assert.equal(timed.reduce((sum, value) => sum + value, 0), 8);

const fallback = audioSceneDurations(scenes, [], 8);
assert.deepEqual(fallback, [4, 4]);
assert.deepEqual(audioSceneDurations([], words, 8), []);
console.log("Audio scene timing tests passed.");
