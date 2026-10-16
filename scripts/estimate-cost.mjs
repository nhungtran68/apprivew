#!/usr/bin/env node
// Offline planning calculator. It never calls providers or reads credentials.
// Prices checked 2026-10-16; edit the declared rates after rechecking official sources.
const HELP = `Usage: node scripts/estimate-cost.mjs [options]

  --duration SECONDS       Clip duration, 2-90 (default: 30).
  --videos COUNT           Videos per month, positive integer (default: 1000).
  --characters COUNT       Narration characters per video (default: ceil(15 * duration)).
  --retry-factor FACTOR    TTS-only planning multiplier, at least 1 (default: 1.5).
  --peak                  Apply DeepSeek peak prices (default: off-peak).
  --v4                    Estimate ElevenLabs eleven_v4 instead of eleven_flash_v2_5.
  --help                  Show this help.

Example:
  node scripts/estimate-cost.mjs --duration 30 --videos 1000 --retry-factor 1.5

Output is a JSON estimate, never an actual invoice. Retries multiply TTS only;
extra DeepSeek shortening calls, subscriptions, cloning and hosting are excluded.
`;

function parseArguments(args) {
  const values = { duration: 30, videos: 1000, characters: undefined, retryFactor: 1.5, peak: false, v4: false };
  const seen = new Set();
  const numeric = new Map([["duration", "duration"], ["videos", "videos"], ["characters", "characters"], ["retry-factor", "retryFactor"]]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument: ${argument}`);
    const equal = argument.indexOf("=");
    const name = argument.slice(2, equal < 0 ? undefined : equal);
    if (seen.has(name)) throw new Error(`Option --${name} was provided more than once.`);
    seen.add(name);
    if (name === "peak" || name === "v4") {
      if (equal >= 0) throw new Error(`--${name} is a flag; omit a value.`);
      values[name] = true;
      continue;
    }
    if (!numeric.has(name)) throw new Error(`Unknown option: --${name}`);
    const raw = equal < 0 ? args[++index] : argument.slice(equal + 1);
    if (raw === undefined || raw.startsWith("--") || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`--${name} requires a finite non-negative number.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be finite.`);
    values[numeric.get(name)] = value;
  }
  if (values.duration < 2 || values.duration > 90) throw new Error("--duration must be between 2 and 90 seconds.");
  if (!Number.isSafeInteger(values.videos) || values.videos < 1) throw new Error("--videos must be a positive safe integer.");
  if (values.characters !== undefined && (!Number.isSafeInteger(values.characters) || values.characters < 1)) throw new Error("--characters must be a positive safe integer.");
  if (values.retryFactor < 1) throw new Error("--retry-factor must be at least 1.");
  values.characters ??= Math.ceil(15 * values.duration);
  return values;
}

function round(value) {
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) throw new Error("Inputs produce an estimate too large to represent safely.");
  return Math.round(value * 1e8) / 1e8;
}

function estimate(options) {
  const { duration, videos, characters, retryFactor, peak, v4 } = options;
  const rateMultiplier = peak ? 2 : 1;
  const flashInput = 0.15 * rateMultiplier, flashOutput = 0.60 * rateMultiplier;
  const ttsRate = v4 ? 0.08 : 0.04;
  const frames = Math.min(16, Math.max(4, Math.ceil(duration / 2) + 1));
  const textInput = 3000, analysisOutput = 800, scriptOutput = 150 + 6 * duration;
  const ttsSinglePass = characters * ttsRate / 1000, ttsWithRetries = ttsSinglePass * retryFactor;
  function scenario(imageTokensPerFrame) {
    const imageInput = frames * imageTokensPerFrame;
    const deepseek = ((textInput + imageInput) * flashInput + (analysisOutput + scriptOutput) * flashOutput) / 1e6;
    return {
      imageTokensPerFrame,
      estimatedImageInputTokens: imageInput,
      perVideo: { deepseekUsd: round(deepseek), ttsSinglePassUsd: round(ttsSinglePass), ttsWithRetryBudgetUsd: round(ttsWithRetries), totalSinglePassUsd: round(deepseek + ttsSinglePass), totalWithRetryBudgetUsd: round(deepseek + ttsWithRetries) },
      perMonth: { videos, deepseekUsd: round(deepseek * videos), ttsSinglePassUsd: round(ttsSinglePass * videos), ttsWithRetryBudgetUsd: round(ttsWithRetries * videos), totalSinglePassUsd: round((deepseek + ttsSinglePass) * videos), totalWithRetryBudgetUsd: round((deepseek + ttsWithRetries) * videos) },
    };
  }
  return {
    kind: "planning_estimate_not_invoice",
    currency: "USD",
    measuredProviderUsage: false,
    pricesAsOf: "2026-10-16",
    inputs: { durationSeconds: duration, videosPerMonth: videos, charactersPerVideo: characters, ttsRetryFactor: retryFactor, deepseekPriceWindow: peak ? "peak" : "off_peak", elevenLabsModel: v4 ? "eleven_v4" : "eleven_flash_v2_5" },
    rates: { deepseekModel: "deepseek-flash", thinking: "disabled", inputCacheMissUsdPerMillionTokens: flashInput, outputUsdPerMillionTokens: flashOutput, elevenLabsUsdPerThousandCharacters: ttsRate },
    assumptions: {
      deepseekCallsPerVideo: 2,
      framesPerVideo: frames,
      imageDetail: "low",
      imageDetailExplanation: "low means 512x512 pixels, not 512 tokens. 200 tokens/image is an estimate, not a guaranteed billed count; 1024 is the documented image-token cap.",
      totalTextInputTokens: textInput,
      analysisOutputTokens: analysisOutput,
      scriptOutputTokens: scriptOutput,
      cacheSavingsIncluded: false,
      charactersDefault: "ceil(15 * durationSeconds), unless --characters is provided",
      retryFactorAppliesTo: "TTS characters only; no multiplier on the two baseline DeepSeek calls",
      charactersPerMonthSinglePass: round(characters * videos),
      charactersPerMonthWithRetryBudget: round(characters * videos * retryFactor),
    },
    estimates: { typicalImageAssumption: scenario(200), conservativeImageCap: scenario(1024) },
    exclusions: ["Extra DeepSeek calls to shorten or rewrite narration", "Voice cloning and voice-slot limits", "Subscription minimums, included credit allocation, overage rules and discounts", "Supabase, Vercel, SMTP, domain, taxes and payment fees"],
    billingNotes: ["These are estimated API usage values, not invoice totals or per-video price guarantees.", "Do not add the full TTS usage value on top of a subscription fee when that usage is already included in the plan.", "The conservative image scenario is not a total-cost ceiling: actual text, outputs, retries and provider usage can differ.", "Use returned DeepSeek usage and actual generated ElevenLabs characters to reconcile real costs."],
    sources: { deepseekPricing: "https://api-docs.deepseek.com/quick_start/pricing/", imageAccounting: "https://api-docs.deepseek.com/guides/vision/", imageCalculator: "https://api-docs.deepseek.com/quick_start/token_usage/", elevenLabsPricing: "https://elevenlabs.io/pricing/api" },
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else process.stdout.write(`${JSON.stringify(estimate(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "Invalid calculator inputs", usage: "node scripts/estimate-cost.mjs --help" })}\n`);
  process.exitCode = 1;
}
