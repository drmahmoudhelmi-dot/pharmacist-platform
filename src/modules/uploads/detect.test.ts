import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectImageType } from "./detect";

// Real files are generated at runtime with sharp; the rest are the first bytes
// of formats that must be refused.

const pixel = () =>
  sharp({
    create: { width: 4, height: 4, channels: 3, background: "#336699" },
  });

const text = (value: string) => new TextEncoder().encode(value);

describe("detectImageType: accepted formats", () => {
  it("detects JPEG", async () => {
    const bytes = new Uint8Array(await pixel().jpeg().toBuffer());
    expect(detectImageType(bytes)).toBe("image/jpeg");
  });

  it("detects PNG", async () => {
    const bytes = new Uint8Array(await pixel().png().toBuffer());
    expect(detectImageType(bytes)).toBe("image/png");
  });

  it("detects lossy and lossless WebP", async () => {
    const lossy = new Uint8Array(await pixel().webp().toBuffer());
    const lossless = new Uint8Array(
      await pixel().webp({ lossless: true }).toBuffer(),
    );
    expect(detectImageType(lossy)).toBe("image/webp");
    expect(detectImageType(lossless)).toBe("image/webp");
  });
});

describe("detectImageType: refused content", () => {
  it("refuses GIF", async () => {
    const bytes = new Uint8Array(await pixel().gif().toBuffer());
    expect(detectImageType(bytes)).toBeNull();
  });

  it("refuses TIFF and AVIF that sharp could otherwise decode", async () => {
    expect(
      detectImageType(new Uint8Array(await pixel().tiff().toBuffer())),
    ).toBeNull();
    expect(
      detectImageType(new Uint8Array(await pixel().avif().toBuffer())),
    ).toBeNull();
  });

  it.each([
    ["PDF", "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"],
    [
      "SVG",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
    [
      "XML-prefixed SVG",
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    ["HTML named .jpg", "<!doctype html><html><body><script>alert(1)</script>"],
    ["plain text", "just some text pretending to be a photo.jpg"],
  ])("refuses %s", (_label, content) => {
    expect(detectImageType(text(content))).toBeNull();
  });

  it("refuses ZIP and Office documents", () => {
    expect(
      detectImageType(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0)),
    ).toBeNull();
  });

  it("refuses a Windows executable", () => {
    expect(
      detectImageType(Uint8Array.of(0x4d, 0x5a, 0x90, 0x00, 0x03)),
    ).toBeNull();
  });

  it("refuses RIFF containers that are not WebP (WAV, AVI)", () => {
    const riff = (kind: string) =>
      Uint8Array.from([
        ...text("RIFF"),
        0x24,
        0,
        0,
        0,
        ...text(kind),
        ...text("fmt "),
      ]);
    expect(detectImageType(riff("WAVE"))).toBeNull();
    expect(detectImageType(riff("AVI "))).toBeNull();
  });

  it("refuses empty and truncated signatures", () => {
    expect(detectImageType(new Uint8Array())).toBeNull();
    expect(detectImageType(Uint8Array.of(0xff, 0xd8))).toBeNull();
    expect(detectImageType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(detectImageType(text("RIFF\0\0\0\0WEBP"))).toBeNull();
  });
});
