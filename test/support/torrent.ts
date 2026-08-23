/** Synthetic torrent metadata, so the wire tests need no fixture and no network. */

import { type Encodable, encode } from "../../src/bencode/encode.ts";
import { sha1 } from "../../src/bytes.ts";

export interface FakeTorrent {
  readonly infoBytes: Uint8Array;
  readonly infoHash: Uint8Array;
  readonly pieceLength: number;
  readonly pieceCount: number;
  readonly totalLength: number;
}

export interface FakeFile {
  readonly path: string[];
  readonly length: number;
  /** BEP-47 padding: occupies bytes in the layout but is never selectable. */
  readonly padding?: boolean;
}

/**
 * Builds a valid info dict. `pieces` is sized to exactly `ceil(total / pieceLength) * 20`, which is
 * the invariant sl-stream's `validateLayout` re-derives and rejects the record over.
 */
export async function makeTorrent(
  files: FakeFile[],
  pieceLength = 16 * 1024,
  name = "Test.Release.1080p",
): Promise<FakeTorrent> {
  let totalLength = 0;
  for (const file of files) totalLength += file.length;
  const pieceCount = Math.ceil(totalLength / pieceLength);

  const pieces = new Uint8Array(pieceCount * 20);
  // Deterministic filler: real digests are irrelevant, only the length is checked.
  for (let i = 0; i < pieces.length; i++) pieces[i] = (i * 31 + 7) & 0xff;

  const single = files.length === 1 && !files[0]!.padding;
  const info: Record<string, Encodable> = single
    ? {
      name: files[0]!.path.join("/"),
      "piece length": pieceLength,
      pieces,
      length: files[0]!.length,
    }
    : {
      name,
      "piece length": pieceLength,
      pieces,
      files: files.map((file) => ({
        length: file.length,
        path: file.path,
        ...(file.padding ? { attr: "p" } : {}),
      })),
    };

  const infoBytes = encode(info);
  return {
    infoBytes,
    infoHash: await sha1(infoBytes),
    pieceLength,
    pieceCount,
    totalLength,
  };
}
