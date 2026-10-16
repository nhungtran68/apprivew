import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the worker, its ES modules and the WASM core on the application's origin.
// This avoids CDN CORS and Vite's rewriting of the FFmpeg worker URL.
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));

async function packageRoot(name) {
  let directory = dirname(require.resolve(name));
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name === name) return { directory, metadata };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`Không tìm thấy ${name}. Hãy cài các thư viện trước khi tạo bản dựng.`);
}

const wrapper = await packageRoot("@ffmpeg/ffmpeg");
const core = await packageRoot("@ffmpeg/core");
const destination = join(project, "public", "ffmpeg");
const wrapperDestination = join(destination, "ffmpeg");
const coreDestination = join(destination, "core");
await mkdir(wrapperDestination, { recursive: true });
await mkdir(coreDestination, { recursive: true });

for (const entry of await readdir(join(wrapper.directory, "dist", "esm"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    await cp(join(wrapper.directory, "dist", "esm", entry.name), join(wrapperDestination, entry.name));
  }
}
await cp(join(core.directory, "dist", "esm", "ffmpeg-core.js"), join(coreDestination, "ffmpeg-core.js"));
// Workers Static Assets caps each file at 25 MiB. The unmodified FFmpeg WASM is
// approximately 31 MiB, so serve binary parts and reassemble them in the browser.
// Never place the full binary in public/, including after a repeated build.
for (const entry of await readdir(coreDestination)) {
  if (entry === "ffmpeg-core.wasm" || /^ffmpeg-core\.\d+\.wasm\.part$/.test(entry)) {
    await rm(join(coreDestination, entry));
  }
}
const wasm = await readFile(join(core.directory, "dist", "esm", "ffmpeg-core.wasm"));
const partSize = 16 * 1024 * 1024;
const parts = [];
for (let offset = 0; offset < wasm.byteLength; offset += partSize) {
  const name = `ffmpeg-core.${parts.length}.wasm.part`;
  await writeFile(join(coreDestination, name), wasm.subarray(offset, offset + partSize));
  parts.push(name);
}
await writeFile(join(coreDestination, "wasm-parts.json"), JSON.stringify({ parts, byteLength: wasm.byteLength }) + "\n");
for (const [dependency, target] of [[wrapper, wrapperDestination], [core, coreDestination]]) {
  for (const license of ["LICENSE", "LICENSE.md", "COPYING.GPLv2"]) {
    try {
      await cp(join(dependency.directory, license), join(target, license));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await writeFile(join(destination, "versions.json"), JSON.stringify({
  ffmpeg: wrapper.metadata.version,
  core: core.metadata.version,
  license: "FFmpeg core includes GPL codecs; see https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/core",
}, null, 2) + "\n");
console.log(`Đã chuẩn bị bộ xuất MP4: FFmpeg ${wrapper.metadata.version}, core ${core.metadata.version}.`);
