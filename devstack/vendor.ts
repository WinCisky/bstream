/**
 * Vendor the fallback player into `public/vendor/`.
 *
 * The test page plays whatever the swarm hands it, and most of that is not something a browser can
 * decode: no browser plays Matroska at all, and HEVC, AC-3 and DTS are unsupported or
 * platform-dependent inside an mp4. The fallback is [libmedia](https://github.com/zhaohappy/libmedia),
 * which demuxes in WebAssembly and decodes through WebCodecs where the browser has it and through
 * per-codec ffmpeg wasm modules where it does not.
 *
 * This runs at image build time rather than from the page, so a running container fetches nothing
 * from the internet to play a video and the version is pinned rather than "whatever the CDN has
 * today". It is idempotent: anything already on disk is left alone, so a rebuild after a source
 * edit does not re-download ~14 MiB.
 *
 *   deno run -A devstack/vendor.ts [--force]
 */

const VERSION = "1.3.1";

/** UMD build of the player *with* its UI — controls matter, since seeking is what tests ranges. */
const PLAYER_PACKAGE = "@libmedia/avplayer-ui";
/** The `AVCodecID` numbers live here, and only in the type declarations. See `codecIds` below. */
const CODEC_PACKAGE = "@libmedia/avutil";
/** The wasm modules are published in the git repository, not on npm. */
const WASM_BASE = `https://raw.githubusercontent.com/zhaohappy/libmedia/v${VERSION}/dist`;

const OUT = new URL("./public/vendor/libmedia/", import.meta.url).pathname;
/**
 * Where the same directory appears to the browser, relative to the page.
 *
 * The wasm urls are handed to libmedia, which fetches them from inside a worker, so they are
 * resolved against the worker rather than against the map that declares them — they have to be
 * absolute by the time libmedia sees them. They are absolutised at load time rather than here,
 * against `document.baseURI`, because the same directory is served at the site root in the dev
 * container and under a repository subpath on GitHub Pages.
 */
const PUBLIC_PATH = "vendor/libmedia/";

/**
 * Which `AV_CODEC_ID_*` each decoder module serves.
 *
 * Only exact, certain mappings: a codec left out here makes libmedia report "unsupported", which is
 * a legible failure, where pointing it at the wrong module is not. Regular expressions cover the
 * families whose ids run to dozens of variants.
 */
const DECODERS: Record<string, ReadonlyArray<string | RegExp>> = {
  // Video.
  h264: ["H264"],
  hevc: ["HEVC"],
  vvc: ["VVC"],
  av1: ["AV1"],
  vp8: ["VP8"],
  vp9: ["VP9"],
  mpeg4: ["MPEG4"],
  mpeg2video: ["MPEG2VIDEO"],
  msmpeg4: ["MSMPEG4V1", "MSMPEG4V2", "MSMPEG4V3"],
  wmv: ["WMV1", "WMV2", "WMV3"],
  h263: ["H263", "H263P"],
  theora: ["THEORA"],
  // Audio.
  aac: ["AAC"],
  ac3: ["AC3"],
  eac3: ["EAC3"],
  dca: ["DTS"],
  mp3: ["MP3"],
  flac: ["FLAC"],
  opus: ["OPUS"],
  vorbis: ["VORBIS"],
  speex: ["SPEEX"],
  wma: ["WMAV1", "WMAV2"],
  pcm: [/^PCM_/],
  adpcm: [/^ADPCM_/],
};

/** Not decoders, but AVPlayer asks for them through the same `getWasm` hook. */
const HELPERS: Record<string, string> = {
  resampler: "resample/resample-simd.wasm",
  stretchpitcher: "stretchpitch/stretchpitch-simd.wasm",
};

const force = Deno.args.includes("--force");
let downloaded = 0;
let skipped = 0;

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `devstack.vendor.${event}`, ...detail }));
}

async function get(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    // A half-vendored directory produces a player that 404s mid-decode, which is far harder to
    // diagnose than a build that stopped.
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Fetch `url` into `OUT + relative`, unless it is already there. */
async function vendor(url: string, relative: string): Promise<void> {
  const path = `${OUT}${relative}`;
  if (!force && await exists(path)) {
    skipped++;
    return;
  }
  const body = await get(url);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(path, body);
  downloaded++;
  log("wrote", { file: relative, bytes: body.byteLength });
}

/** Every file a package publishes, from jsDelivr's metadata API. */
async function packageFiles(name: string): Promise<string[]> {
  const url = `https://data.jsdelivr.com/v1/packages/npm/${name}@${VERSION}?structure=flat`;
  const meta = JSON.parse(new TextDecoder().decode(await get(url))) as {
    files: Array<{ name: string }>;
  };
  return meta.files.map((file) => file.name);
}

/**
 * `AVCodecID` is a TypeScript `const enum`, so the numbers are inlined at compile time and are
 * absent from the shipped JavaScript — there is nothing to read at runtime. The declarations still
 * carry them, so parse those and bake the result into a lookup table the page can use.
 */
async function codecIds(): Promise<Map<string, number>> {
  const url = `https://cdn.jsdelivr.net/npm/${CODEC_PACKAGE}@${VERSION}/dist/esm/codec.d.ts`;
  const source = new TextDecoder().decode(await get(url));
  const ids = new Map<string, number>();
  for (const match of source.matchAll(/AV_CODEC_ID_([A-Z0-9_]+) = (\d+)/g)) {
    ids.set(match[1]!, Number(match[2]));
  }
  if (ids.size === 0) throw new Error(`no AV_CODEC_ID_* found in ${url}`);
  return ids;
}

/** `{ decoder: { <codec id>: url }, resampler: url, stretchpitcher: url }`, as a plain script. */
async function wasmMap(ids: Map<string, number>): Promise<void> {
  const decoder: Record<number, string> = {};

  for (const [module, codecs] of Object.entries(DECODERS)) {
    await vendor(`${WASM_BASE}/decode/${module}-simd.wasm`, `wasm/${module}-simd.wasm`);
    const url = `${PUBLIC_PATH}wasm/${module}-simd.wasm`;

    for (const codec of codecs) {
      if (typeof codec === "string") {
        const id = ids.get(codec);
        // An upstream rename must fail the build rather than silently drop a codec.
        if (id === undefined) throw new Error(`AV_CODEC_ID_${codec} is not in ${CODEC_PACKAGE}`);
        decoder[id] = url;
        continue;
      }
      for (const [name, id] of ids) {
        if (codec.test(name)) decoder[id] = url;
      }
    }
  }

  const helpers: Record<string, string> = {};
  for (const [role, path] of Object.entries(HELPERS)) {
    const file = `wasm/${path.slice(path.lastIndexOf("/") + 1)}`;
    await vendor(`${WASM_BASE}/${path}`, file);
    helpers[role] = `${PUBLIC_PATH}${file}`;
  }

  // Paths are stored relative and resolved against the document at load time: the same directory is
  // served at the site root by the dev container and under `/<repo>/` on GitHub Pages.
  const script = `// Generated by devstack/vendor.ts — libmedia v${VERSION}. Do not edit.
globalThis.LIBMEDIA_WASM = (function () {
  const relative = ${JSON.stringify({ decoder, ...helpers }, null, 2)};
  const absolute = (path) => new URL(path, document.baseURI).href;
  const map = { decoder: {} };
  for (const [id, path] of Object.entries(relative.decoder)) map.decoder[id] = absolute(path);
  for (const [role, path] of Object.entries(relative)) {
    if (role !== "decoder") map[role] = absolute(path);
  }
  return map;
})();
`;
  await Deno.writeTextFile(`${OUT}wasm-map.js`, script);
  log("wrote", { file: "wasm-map.js", codecs: Object.keys(decoder).length });
}

async function main(): Promise<void> {
  log("start", { version: VERSION, out: OUT });

  const files = await packageFiles(PLAYER_PACKAGE);
  // The entry loads its chunks by a path relative to itself, so they all have to land together.
  const umd = files.filter((file) => file.startsWith("/dist/umd/") && file.endsWith(".js"));
  if (!umd.includes("/dist/umd/avplayer.js")) {
    throw new Error(`${PLAYER_PACKAGE}@${VERSION} has no dist/umd/avplayer.js`);
  }
  for (const file of [...umd, "/COPYING.LGPLv3"]) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    await vendor(`https://cdn.jsdelivr.net/npm/${PLAYER_PACKAGE}@${VERSION}${file}`, name);
  }

  await wasmMap(await codecIds());

  log("done", { downloaded, skipped });
}

if (import.meta.main) {
  await main();
}
