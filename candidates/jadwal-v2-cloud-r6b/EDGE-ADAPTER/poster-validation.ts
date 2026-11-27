const MAX_POSTER_BYTES = 2 * 1024 * 1024;
export type PosterType = "image/jpeg" | "image/png" | "image/webp";

export function detectPosterType(bytes: Uint8Array): PosterType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function validatePoster(bytes: Uint8Array, declaredType: string): { contentType: PosterType; objectKey: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_POSTER_BYTES) throw Object.assign(new Error("invalid_poster_size"), { code: "invalid_poster_size" });
  const contentType = detectPosterType(bytes);
  if (!contentType || contentType !== declaredType.toLowerCase()) throw Object.assign(new Error("invalid_poster_type"), { code: "invalid_poster_type" });
  // Random key is generated here; client filenames and paths are never inputs.
  return { contentType, objectKey: `${crypto.randomUUID()}.${contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp"}` };
}
