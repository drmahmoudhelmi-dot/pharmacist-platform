import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { outputKeyFor, reencodeImage } from "./processing";

// Unit tests for the re-encode step; the full job (scan, storage, database)
// is covered by tests/integration/uploads.test.ts.

/** A JPEG carrying EXIF with GPS coordinates, camera data and an orientation. */
async function photoWithGps(width: number, height: number, orientation = 1) {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#4a7f3c" },
    })
      .jpeg()
      .withMetadata({ orientation })
      .withExif({
        IFD0: { Make: "TestCam", Model: "Unit 1" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "30/1 2/1 4/1",
          GPSLongitudeRef: "E",
          GPSLongitude: "31/1 14/1 9/1",
        },
      })
      .toBuffer(),
  );
}

describe("reencodeImage", () => {
  it("produces a JPEG with no EXIF, GPS, ICC or XMP metadata", async () => {
    const input = await photoWithGps(64, 48);
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(Buffer.from(input).includes("TestCam")).toBe(true);

    const output = await reencodeImage(input);
    const after = await sharp(output).metadata();
    expect(after.format).toBe("jpeg");
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    const raw = Buffer.from(output);
    expect(raw.includes("Exif")).toBe(false);
    expect(raw.includes("TestCam")).toBe(false);
  });

  it("applies the EXIF orientation to the pixels", async () => {
    // Orientation 6: stored landscape, displayed rotated 90° (portrait).
    const output = await reencodeImage(await photoWithGps(80, 40, 6));
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height]).toEqual([40, 80]);
    expect(meta.orientation).toBeUndefined();
  });

  it("limits the long side to 2,400 px and never enlarges", async () => {
    const big = new Uint8Array(
      await sharp({
        create: { width: 3000, height: 1500, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
    );
    const out = await sharp(await reencodeImage(big)).metadata();
    expect([out.width, out.height]).toEqual([2400, 1200]);

    const small = await sharp(
      await reencodeImage(await photoWithGps(300, 200)),
    ).metadata();
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it("flattens transparent PNG and WebP onto white", async () => {
    for (const format of ["png", "webp"] as const) {
      const input = new Uint8Array(
        await sharp({
          create: {
            width: 8,
            height: 8,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .toFormat(format)
          .toBuffer(),
      );
      const { data, info } = await sharp(await reencodeImage(input))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(3);
      expect(data[0]).toBeGreaterThan(240);
    }
  });

  it("throws on bytes that only look like an image", async () => {
    const fake = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...new Uint8Array(200).fill(0x41),
    ]);
    await expect(reencodeImage(fake)).rejects.toThrow();
  });

  it("throws on a truncated JPEG", async () => {
    const full = await photoWithGps(200, 200);
    await expect(
      reencodeImage(full.subarray(0, full.length / 2)),
    ).rejects.toThrow();
  });
});

describe("outputKeyFor", () => {
  it("derives the document key from the quarantine key", () => {
    const id = "0b9f3a1c-6d2e-4f80-9a7b-1c2d3e4f5a6b";
    expect(outputKeyFor(`quarantine/${id}`)).toBe(`documents/${id}.jpg`);
  });

  it("refuses anything outside the quarantine prefix", () => {
    expect(() => outputKeyFor("documents/x")).toThrow();
  });
});
