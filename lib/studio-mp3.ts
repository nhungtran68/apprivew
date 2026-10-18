import { parseBuffer } from "music-metadata";
import { StudioError } from "./studio-contract";

const invalid = () => new StudioError("INVALID_AUDIO", "Tệp MP3 chưa hợp lệ. Hãy thử lại hoặc chọn bản thu khác.", 422);
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

// Validate complete Layer III frame boundaries before trusting a Xing/Info
// duration. Metadata parsers can otherwise accept a truncated file's old header.
// Frame fields follow music-metadata's pinned MpegFrameHeader implementation;
// playback duration, including VBR metadata, remains the library's responsibility.
function frameBounds(bytes: Uint8Array) {
  if (bytes.length < 32 || bytes.length > 12 * 1024 * 1024) throw invalid();
  let offset = 0, end = bytes.length;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const version = bytes[3], flags = bytes[5];
    if (![2, 3, 4].includes(version) || bytes[4] === 0xff || (flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f))
      || bytes.subarray(6, 10).some(byte => byte & 0x80)) throw invalid();
    const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    offset = 10 + size + (version === 4 && (flags & 0x10) ? 10 : 0);
    if (offset >= end) throw invalid();
    if (version === 4 && (flags & 0x10)) {
      const footer = offset - 10;
      if (bytes[footer] !== 0x33 || bytes[footer + 1] !== 0x44 || bytes[footer + 2] !== 0x49
        || bytes.subarray(3, 10).some((byte, index) => bytes[footer + 3 + index] !== byte)) throw invalid();
    }
  }
  // ID3v1 is a fixed-size trailer; arbitrary trailing bytes are not MPEG frames.
  if (end - offset >= 128 && bytes[end - 128] === 0x54 && bytes[end - 127] === 0x41 && bytes[end - 126] === 0x47) end -= 128;
  let sampleRate = 0, channels = 0, version = -1, samples = 0, frames = 0;
  while (offset < end) {
    if (offset + 4 > end || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) throw invalid();
    const b1 = bytes[offset + 1], b2 = bytes[offset + 2], b3 = bytes[offset + 3];
    const currentVersion = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, bitrateIndex = b2 >> 4, rateIndex = (b2 >> 2) & 3;
    if (currentVersion === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) throw invalid();
    const rate = [44100, 48000, 32000][rateIndex] / (currentVersion === 3 ? 1 : currentVersion === 2 ? 2 : 4);
    const count = (b3 >> 6) === 3 ? 1 : 2;
    if (frames && (currentVersion !== version || rate !== sampleRate || count !== channels)) throw invalid();
    version = currentVersion; sampleRate = rate; channels = count; samples = version === 3 ? 1152 : 576;
    const bitrate = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex];
    const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((b2 >> 1) & 1);
    if (length < 4 || offset + length > end) throw invalid();
    offset += length; frames++;
  }
  if (frames < 3) throw invalid();
  return { sampleRate, channels, frameSeconds: samples / sampleRate, streamSeconds: frames * samples / sampleRate };
}

export async function inspectMp3(bytes: Uint8Array) {
  try {
    const frames = frameBounds(bytes);
    const { format } = await parseBuffer(bytes, { mimeType: "audio/mpeg", size: bytes.length }, { duration: true, skipCovers: true });
    const duration = format.duration;
    if (format.container !== "MPEG" || !/^MPEG (?:1|2|2\.5) Layer 3$/.test(format.codec || "")
      || format.sampleRate !== frames.sampleRate || format.numberOfChannels !== frames.channels
      || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 180
      // Info/Xing frames and encoder padding can differ by a few frames.
      || Math.abs(duration - frames.streamSeconds) > frames.frameSeconds * 3 + 0.001) throw invalid();
    return { duration, sampleRate: frames.sampleRate, channels: frames.channels };
  } catch { throw invalid(); }
}
