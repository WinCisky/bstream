/**
 * Playback for the test page, through libmedia.
 *
 * ma-stream lists every `.mp4`, `.m4v`, `.mkv` and `.avi` in a torrent and the page picks one, and
 * a torrent is under no obligation to hold something a browser can decode. Matroska and AVI play
 * natively nowhere, HEVC is
 * hardware- and platform-dependent, and AC-3 or DTS audio is common in releases and supported almost
 * nowhere. A black player for those reasons is a false negative — the page exists to show whether
 * the swarm, the peer wire and the range serving work, not whether the browser ships an AC-3
 * decoder.
 *
 * There is deliberately **no native `<video>` path**, even for files a browser could handle.
 * `canPlayType` answers per container rather than per track and cannot be trusted: Chrome says
 * "maybe" to `video/x-matroska`, then plays an HEVC file with `videoWidth === 0`, no `error` event
 * and audio only. The same trap exists in reverse for an AC-3 track in a file whose video is fine.
 * Every "yes" would have to be second-guessed after the fact, and libmedia covers the easy cases
 * anyway — it switches to MSE by itself when the codecs are natively supported.
 *
 * libmedia demuxes MP4, Matroska and AVI in WebAssembly and decodes through WebCodecs where the
 * browser has it and through the vendored ffmpeg wasm modules where it does not. It fetches the
 * source with Range, so the thing under test is still under test.
 */
(function () {
  /**
   * Written by `devstack/vendor.ts` at build time. Nothing here reaches the internet.
   *
   * Resolved against the document rather than hardcoded to the root, because the page is served at
   * the site root by the dev container and under `/<repo>/` when it is deployed to GitHub Pages.
   */
  const VENDOR = new URL("vendor/libmedia/", document.baseURI).href;
  const STATS_INTERVAL_MS = 1000;

  /** The AVPlayer instance, kept across plays — constructing it spins up workers. */
  let libmedia = null;
  /** Whether the window-resize handler that keeps its canvas in the card is installed. */
  let fitting = false;
  /** Handle of the stats poll, so a teardown does not leave it running against a stopped player. */
  let statsTimer = null;
  /** In-flight or settled script loads, so the bundle is fetched once. */
  const scripts = new Map();
  /** The last thing handed to `play`, so the info line can be redrawn without the page's help. */
  let current = null;

  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(
        src,
        new Promise((resolve, reject) => {
          const tag = document.createElement("script");
          tag.src = src;
          tag.onload = () => resolve();
          tag.onerror = () => reject(new Error(`failed to load ${src}`));
          document.head.appendChild(tag);
        }),
      );
    }
    return scripts.get(src);
  }

  /**
   * What sl-stream says the file is.
   *
   * Nothing depends on the answer any more — libmedia works it out from the bytes — but it is worth
   * showing, because a `content-type` that disagrees with what libmedia then demuxes is a bug in
   * sl-stream's container probe.
   */
  async function probe(url) {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!response.ok) throw new Error(`HEAD ${response.status}`);
    return {
      type: response.headers.get("content-type") ?? "",
      format: response.headers.get("x-sl-container") ?? "",
    };
  }

  /** Whether the machine has a WebGPU adapter at all. Nothing the page does can change this. */
  const webgpuAvailable = Boolean(globalThis.navigator && navigator.gpu);

  /**
   * What the page has asked for, as opposed to what the machine can do.
   *
   * The renderer is the one supported knob that changes how frames reach the screen: the default
   * path renders WebGL into an OffscreenCanvas owned by a worker, and a canvas composited on a
   * frame where its drawing buffer has been discarded shows through black. Being able to force
   * WebGL is what tells that failure apart from a decode or a range-serving one. libmedia falls
   * back to WebGL silently when a frame format is unsupported, so the page can only ever report
   * what it asked for.
   */
  const prefs = { captions: true, webgpu: webgpuAvailable };

  /** The renderer that will actually be asked for: a preference cannot conjure an adapter. */
  const wantWebGPU = () => prefs.webgpu && webgpuAvailable;

  async function teardown(view) {
    view.mount.hidden = true;
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    view.stats("");
    // AVPlayer's methods are asynchronous and must not overlap, so this is awaited rather than
    // fired off before the next load.
    if (libmedia) await libmedia.stop();
  }

  function describe(view) {
    const renderer = wantWebGPU() ? "webgpu requested" : "webgl";
    const captions = prefs.captions ? "captions on" : "captions off";
    const isolation = globalThis.crossOriginIsolated ? "threads" : "main thread";
    view.info(
      `${view.format || "?"} · ${view.type || "no content-type"} · libmedia · ` +
        `${renderer} · ${captions} · ${isolation}`,
    );
  }

  /**
   * One line of what the pipeline is actually doing, once a second.
   *
   * The picture dropping out for a frame or two has two very different causes — the pipeline losing
   * frames, or the compositor showing an empty canvas — and they are indistinguishable by eye. If a
   * glitch happens while every counter here sits still, it happened after libmedia was done.
   */
  function pollStats(view) {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (!libmedia) return;
      const s = libmedia.getStats();
      const n = (value) => Number(value);
      view.stats(
        `render ${n(s.videoRenderFramerate)}fps · decode ${n(s.videoDecodeFramerate)}fps · ` +
          `dropped ${n(s.videoFrameDropCount)} frames / ${n(s.videoDropPacketCount)} packets · ` +
          `decode errors ${n(s.videoDecodeErrorPacketCount)} · stutter ${n(s.videoStutter)} · ` +
          `keyframe every ${n(s.keyFrameInterval)}ms · ` +
          `slowest render ${n(s.videoFrameRenderIntervalMax)}ms`,
      );
    }, STATS_INTERVAL_MS);
  }

  function getWasm(view) {
    return function (type, codecId) {
      const map = globalThis.LIBMEDIA_WASM;
      const url = type === "decoder" ? map.decoder[codecId] : map[type];
      if (!url) {
        // Null makes libmedia report an unsupported codec, which is a legible failure. A guessed
        // module would not be.
        view.log(`no vendored wasm for ${type} ${codecId ?? ""} — codec unsupported`, "warn");
        return null;
      }
      view.log(`libmedia ${type}: ${url.slice(VENDOR.length)}`, "dim");
      return url;
    };
  }

  async function start(view) {
    const { log } = view;
    view.mount.hidden = false;
    describe(view);

    await loadScript(`${VENDOR}wasm-map.js`);
    await loadScript(`${VENDOR}avplayer.js`);

    if (!libmedia) {
      libmedia = new globalThis.AVPlayer({
        container: view.mount,
        getWasm: getWasm(view),
        enableHardware: true,
        enableWebCodecs: true,
        enableWebGPU: wantWebGPU(),
        // Without SharedArrayBuffer this is what keeps demuxing and decoding off the main thread.
        enableWorker: true,
      });
      libmedia.on("loaded", () => log("libmedia loaded the stream", "dim"));
      libmedia.on("played", () => {
        view.status("playing");
        log("libmedia is rendering — sl-stream is serving", "ok");
      });
      libmedia.on("ended", () => log("playback ended", "dim"));
      libmedia.on("error", (err) => {
        view.status("failed");
        log("libmedia error: " + (err && err.message ? err.message : err), "bad");
      });
    }

    await libmedia.load(view.url);
    // libmedia sizes its surface to the video, and positions it absolutely: without both of these
    // a 1080p file lays a 2000 px canvas over the top-left of the page. `#libmedia` is the
    // positioned ancestor (see the stylesheet); this makes it the size that matters.
    const fit = () => libmedia.resize(view.mount.clientWidth, view.mount.clientHeight);
    if (!fitting) {
      fitting = true;
      globalThis.addEventListener("resize", () => {
        if (libmedia && !view.mount.hidden) fit();
      });
    }
    await libmedia.play();
    // The subtitle pipeline is always started, so the toggle is a display switch either way and
    // needs no reload in either direction.
    libmedia.setSubtitleEnable(prefs.captions);
    if (prefs.captions && !libmedia.hasSubtitle()) {
      // Otherwise "captions on and nothing on screen" is indistinguishable from a broken toggle.
      log("captions are on, but this file has no subtitle track", "dim");
    }
    fit();
    pollStats(view);
  }

  /**
   * @param {{
   *   url: string,
   *   mount: HTMLDivElement,
   *   log: (message: string, kind?: string) => void,
   *   status: (text: string) => void,
   *   info: (text: string) => void,
   *   stats: (text: string) => void,
   * }} options
   */
  async function play(options) {
    const view = { ...options, type: "", format: "" };
    current = view;

    await teardown(view);
    view.status("loading…");
    view.log(`GET ${view.url}`, "dim");

    try {
      const probed = await probe(view.url);
      view.type = probed.type;
      view.format = probed.format;
    } catch (err) {
      // Not fatal: libmedia makes its own requests and fails visibly if this was real.
      view.log(`HEAD failed (${err.message})`, "warn");
    }

    await start(view);
  }

  /**
   * Show or hide subtitles, now.
   *
   * Nothing is torn down: the subtitle stream is demuxed and decoded either way, and only the
   * render is switched. Whatever is playing keeps playing.
   */
  function setCaptions(on) {
    prefs.captions = Boolean(on);
    if (libmedia) libmedia.setSubtitleEnable(prefs.captions);
    if (current) describe(current);
  }

  /**
   * Choose the renderer for the next player that gets built.
   *
   * `enableWebGPU` is a constructor option, and libmedia cannot be rebuilt inside a live page:
   * construct, `destroy()`, construct again, and the second instance's `options.container` is
   * never populated, so `play()` dies on `Cannot read properties of null (reading 'offsetWidth')`.
   * Reproduced against v1.3.1 with two bare `AVPlayer`s and nothing else on the page, so it is not
   * something this file is doing. That is why the page reloads to apply this rather than calling
   * back in — see `index.html`. Here it only records the intent.
   */
  function setWebGPU(on) {
    prefs.webgpu = Boolean(on);
    if (current) describe(current);
  }

  // `instance` is for the console: the player has no other handle to poke at from devtools.
  globalThis.CodecPlayer = {
    play,
    setCaptions,
    setWebGPU,
    webgpuAvailable: () => webgpuAvailable,
    instance: () => libmedia,
  };
})();
