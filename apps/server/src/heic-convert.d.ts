/** heic-convert ships no types; this covers the one call Cosimo makes. */
declare module "heic-convert" {
  function convert(opts: {
    buffer: Uint8Array | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }): Promise<ArrayBuffer | Uint8Array>;
  export default convert;
}
