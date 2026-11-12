/** Delivery policy for stored artifacts, including legacy and agent-created rows. */
export function artifactResponseHeaders(name: string, mime: unknown, binary: Buffer | null): Record<string, string> {
  // MIME metadata is not an authorization to execute content on the application's origin.
  const raster = binary && (
    (mime === "image/png" && binary.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    ((mime === "image/jpeg" || mime === "image/jpg") && binary.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
    (mime === "image/gif" && ["GIF87a", "GIF89a"].includes(binary.subarray(0, 6).toString("latin1"))) ||
    (mime === "image/webp" && binary.length >= 12 && binary.subarray(0, 4).toString("latin1") === "RIFF" && binary.subarray(8, 12).toString("latin1") === "WEBP")
  );
  const filename = String(name).replace(/[^\x20-\x7e]|["\\/]/g, "_").slice(0, 120) || "artifact";
  return {
    "Content-Type": binary ? (raster ? (mime === "image/jpg" ? "image/jpeg" : String(mime)) : "application/octet-stream") : "text/plain; charset=utf-8",
    "Content-Disposition": `${binary && !raster ? "attachment" : "inline"}; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  };
}
