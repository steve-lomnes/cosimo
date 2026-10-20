/**
 * Image handling for uploads and the MCP receipt preview (#89).
 *
 * iPhones save photos as HEIC, which browsers and assistants can't read, so an upload sniffed as
 * HEIC is converted to a full-resolution JPEG before it is stored (heic-convert: libheif compiled
 * to WASM, no native code). The assistant preview downscales a JPEG to a long edge of 1568 px so it
 * fits the image limits of assistant clients.
 *
 * Decoding a 12 MP photo takes a few seconds and a couple of hundred MB, so conversions and
 * previews run one at a time: a small instance (512 MB) survives several uploads at once.
 */
import convertHeic from "heic-convert";
import * as jpeg from "jpeg-js";
import { unprocessable } from "../http/errors.ts";
import { sniffType } from "./attachments.ts";

export interface UploadFile {
  filename: string;
  type: string;
  bytes: Uint8Array;
}

/** The longest edge, in pixels, of an image sent to an assistant. */
export const PREVIEW_MAX_EDGE = 1568;
/** Larger non-JPEG images are not sent to an assistant as they are (base64 grows them by a third). */
const PREVIEW_MAX_RAW_BYTES = 3_750_000;

let queue: Promise<unknown> = Promise.resolve();

/** Run image work one job at a time, in arrival order. */
function oneAtATime<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Replace a filename's extension (or add one). */
function withExtension(filename: string, ext: string) {
  const base = filename.replace(/\.[^./\\]{1,8}$/, "");
  return `${base || "image"}.${ext}`;
}

/**
 * Convert a HEIC upload to JPEG at full resolution, renaming it to `.jpg`; any other file passes
 * through unchanged. Call it outside the database transaction, before `storeBlob`.
 */
export async function normalizeUpload(file: UploadFile): Promise<UploadFile> {
  if (file.bytes.byteLength === 0 || sniffType(file.bytes, file.type) !== "image/heic") return file;
  let out: ArrayBuffer | Uint8Array;
  try {
    out = await oneAtATime(() => convertHeic({ buffer: file.bytes, format: "JPEG", quality: 0.92 }));
  } catch {
    throw unprocessable(
      "This HEIC image couldn't be converted. Save or export it as a JPEG and upload that instead.",
      "heic_unsupported",
    );
  }
  return {
    filename: withExtension(file.filename, "jpg"),
    type: "image/jpeg",
    bytes: out instanceof Uint8Array ? out : new Uint8Array(out),
  };
}

/** Shrink RGBA pixels so the long edge is at most `maxEdge`, averaging each source box. */
function downscale(src: { width: number; height: number; data: Uint8Array }, maxEdge: number) {
  const scale = maxEdge / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * src.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * An image as an assistant should receive it: a JPEG with a long edge of at most 1568 px, re-encoded
 * when it was larger. PNG, GIF and WebP are sent as they are when small enough. Null when the image
 * can't be sent (too large, or unreadable).
 */
export async function assistantImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  if (mime === "image/jpeg") return oneAtATime(() => previewJpeg(bytes));
  if (["image/png", "image/gif", "image/webp"].includes(mime) && bytes.byteLength <= PREVIEW_MAX_RAW_BYTES)
    return { data: bytes, mimeType: mime };
  return null;
}

function previewJpeg(bytes: Uint8Array): { data: Uint8Array; mimeType: string } | null {
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  } catch {
    return null;
  }
  if (Math.max(img.width, img.height) <= PREVIEW_MAX_EDGE) return { data: bytes, mimeType: "image/jpeg" };
  const small = downscale(img, PREVIEW_MAX_EDGE);
  return { data: new Uint8Array(jpeg.encode(small, 85).data), mimeType: "image/jpeg" };
}
