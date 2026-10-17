import { StudioError } from "./studio-contract";

// Parse the actual WAV chunks: providers may include LIST/JUNK chunks before data.
export function inspectWav(bytes: Uint8Array) {
  const fail = () => new StudioError("INVALID_AUDIO", "Tệp WAV chưa hợp lệ. Hãy thử lại hoặc chọn bản thu khác.", 422);
  if (bytes.length < 44) throw fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 > bytes.length) throw fail();
  let format: { encoding: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + length > bytes.length) throw fail();
    if (tag(offset) === "fmt ") {
      if (length < 16) throw fail();
      format = { encoding: view.getUint16(start, true), channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true), blockAlign: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    } else if (tag(offset) === "data") dataBytes += length;
    offset = start + length + (length % 2);
  }
  if (!format || ![1, 3].includes(format.encoding) || ![1, 2].includes(format.channels)
    || format.sampleRate < 8000 || format.sampleRate > 192000 || ![16, 24, 32].includes(format.bits)
    || format.blockAlign !== format.channels * format.bits / 8 || format.byteRate !== format.sampleRate * format.blockAlign
    || (format.encoding === 3 && format.bits !== 32) || !dataBytes || dataBytes % format.blockAlign) throw fail();
  return { ...format, duration: dataBytes / format.byteRate };
}
