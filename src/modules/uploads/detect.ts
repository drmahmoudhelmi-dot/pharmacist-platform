import type { AcceptedType } from "./constants";

// Content-based type detection for uploads (ADR-004, 4a). The allow-list is
// three formats, so this checks their signatures directly instead of adding a
// general detector such as `file-type` (which recognises hundreds of formats we
// would reject anyway). Anything that does not start with one of these
// signatures is refused. This is only the first gate: the worker fully decodes
// and re-encodes the image, which rejects files that merely start right.
//
// The file name and the client's Content-Type are never consulted.

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

/** The accepted image type these bytes are, or null for anything else. */
export function detectImageType(bytes: Uint8Array): AcceptedType | null {
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  // RIFF container: "RIFF" <4-byte size> "WEBP" <chunk "VP8 " | "VP8L" | "VP8X">
  if (
    startsWith(bytes, RIFF) &&
    startsWith(bytes, WEBP, 8) &&
    bytes.length >= 16 &&
    bytes[12] === 0x56 && // "V"
    bytes[13] === 0x50 && // "P"
    bytes[14] === 0x38 // "8"
  )
    return "image/webp";
  return null;
}
