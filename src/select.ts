/**
 * Pick the video file a torrent is really about.
 *
 * Largest wins, because in any release the feature dwarfs the sample, the trailer and the extras.
 * Padding files are excluded — they hold no content, only alignment.
 */

import type { TorrentFile, TorrentInfo } from "./meta/info.ts";

export class SelectError extends Error {
  override readonly name = "SelectError";
}

/** The containers sl-stream can probe. `.m4v` is an mp4 in all but name. */
const VIDEO_TYPES: ReadonlyArray<readonly [string, string]> = [
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".avi", "video/x-msvideo"],
];

export interface FileSelection {
  readonly index: number;
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly mime: string;
}

/**
 * The content type for a path, or null when it is not a video we can serve.
 *
 * Exported because the chunk record and the resolve response both label every file in the torrent,
 * not just the selected one — and a second copy of this table would drift from this one.
 */
export function mimeForPath(path: string): string | null {
  const lower = path.toLowerCase();
  for (const [extension, mime] of VIDEO_TYPES) {
    if (lower.endsWith(extension)) return mime;
  }
  return null;
}

export function selectVideoFile(info: TorrentInfo): FileSelection {
  let best: { file: TorrentFile; index: number; mime: string } | null = null;

  for (let index = 0; index < info.files.length; index++) {
    const file = info.files[index]!;
    if (file.padding || file.length === 0) continue;
    const mime = mimeForPath(file.path);
    if (!mime) continue;
    if (!best || file.length > best.file.length) best = { file, index, mime };
  }

  if (!best) {
    const extensions = VIDEO_TYPES.map(([extension]) => extension).join(", ");
    throw new SelectError(`torrent contains no ${extensions} file`);
  }

  return {
    index: best.index,
    path: best.file.path,
    offset: best.file.offset,
    length: best.file.length,
    mime: best.mime,
  };
}
