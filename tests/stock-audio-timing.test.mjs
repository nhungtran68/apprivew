import assert from "node:assert/strict";
import { alignSceneWeightsToSamples } from "../lib/stock-audio-timing.ts";

const rate = 1000;
const samples = new Float32Array(rate * 4);
samples.fill(0.25);
samples.fill(0, Math.round(rate * 1.94), Math.round(rate * 2.12));

const aligned = alignSceneWeightsToSamples([samples], rate, 4, [1.8, 2.2]);
assert.equal(aligned.silenceAligned, true);
assert.ok(aligned.boundaries[1] >= 1.92 && aligned.boundaries[1] <= 2.14);
assert.equal(aligned.durations.reduce((sum, value) => sum + value, 0), 4);

const continuous = new Float32Array(rate * 4).fill(0.25);
const unchanged = alignSceneWeightsToSamples([continuous], rate, 4, [1.8, 2.2]);
assert.equal(unchanged.silenceAligned, false);
assert.ok(Math.abs(unchanged.boundaries[1] - 1.8) < 0.0001);

const short = alignSceneWeightsToSamples([samples], rate, 4, [0.1, 0.1, 3.8]);
assert.ok(short.durations.every(duration => duration > 0));
assert.equal(short.durations.reduce((sum, value) => sum + value, 0), 4);

console.log("Stock audio pause alignment passed.");
