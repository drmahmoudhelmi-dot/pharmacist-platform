import { describe, expect, it } from "vitest";
import { UPLOAD_LIMITS } from "./constants";
import { readUploadForm } from "./multipart";

const URL_ = "http://localhost:3000/api/uploads";
const MAX = 1024; // a small limit keeps the tests fast; the logic is the same

function form(entries: [string, string | Blob, string?][]) {
  const data = new FormData();
  for (const [key, value, filename] of entries) {
    if (typeof value === "string") data.append(key, value);
    else data.append(key, value, filename);
  }
  return data;
}

const file = (size: number, type = "image/jpeg") =>
  new Blob([new Uint8Array(size).fill(7)], { type });

/** A request with a known Content-Length, as browsers send. */
const request = (data: FormData) =>
  new Request(URL_, { method: "POST", body: data });

/** The same body streamed in small chunks without Content-Length. */
async function streamed(data: FormData, chunk = 100) {
  const encoded = request(data);
  const contentType = encoded.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  let offset = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      pulled += 1;
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
  const req = new Request(URL_, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    duplex: "half",
  } as RequestInit);
  return { req, total: bytes.length, pulledBytes: () => pulled * chunk };
}

describe("readUploadForm", () => {
  it("reads one file and its purpose, ignoring the client's name and type", async () => {
    const data = form([
      ["purpose", "verification_document"],
      ["file", file(MAX, "text/html"), "evil.html"],
    ]);
    const result = await readUploadForm(request(data), MAX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.purpose).toBe("verification_document");
    expect(result.form.bytes.byteLength).toBe(MAX);
    expect(Object.keys(result.form).sort()).toEqual(["bytes", "purpose"]);
  });

  it("accepts a file of exactly the limit and refuses one byte more with too_large", async () => {
    const ok = form([
      ["purpose", "x"],
      ["file", file(MAX), "a.jpg"],
    ]);
    expect((await readUploadForm(request(ok), MAX)).ok).toBe(true);
    const over = form([
      ["purpose", "x"],
      ["file", file(MAX + 1), "a.jpg"],
    ]);
    expect(await readUploadForm(request(over), MAX)).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("refuses a declared Content-Length over the limit before reading the body", async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(
          MAX + UPLOAD_LIMITS.multipartOverheadBytes + 1,
        ),
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(await readUploadForm(req, MAX)).toEqual({
      ok: false,
      error: "too_large",
    });
    expect(read).toBe(false);
  });

  it("stops reading a streamed body as soon as it passes the limit", async () => {
    const big = MAX + UPLOAD_LIMITS.multipartOverheadBytes + 50_000;
    const { req, total, pulledBytes } = await streamed(
      form([
        ["purpose", "x"],
        ["file", file(big), "a.jpg"],
      ]),
      1000,
    );
    expect(await readUploadForm(req, MAX)).toEqual({
      ok: false,
      error: "too_large",
    });
    // Cut off near the limit, not after reading everything.
    expect(pulledBytes()).toBeLessThan(
      MAX + UPLOAD_LIMITS.multipartOverheadBytes + 5000,
    );
    expect(pulledBytes()).toBeLessThan(total);
  });

  it("reads a streamed body under the limit", async () => {
    const { req } = await streamed(
      form([
        ["purpose", "x"],
        ["file", file(500), "a.jpg"],
      ]),
    );
    const result = await readUploadForm(req, MAX);
    expect(result.ok && result.form.bytes.byteLength).toBe(500);
  });

  it.each([
    ["no file", [["purpose", "x"]]],
    ["no purpose", [["file", file(10), "a.jpg"]]],
    [
      "two files",
      [
        ["purpose", "x"],
        ["file", file(10), "a.jpg"],
        ["file", file(10), "b.jpg"],
      ],
    ],
    [
      "two purposes",
      [
        ["purpose", "x"],
        ["purpose", "y"],
        ["file", file(10), "a.jpg"],
      ],
    ],
    [
      "an extra field",
      [
        ["purpose", "x"],
        ["file", file(10), "a.jpg"],
        ["userId", "someone"],
      ],
    ],
    [
      "the file as a text field",
      [
        ["purpose", "x"],
        ["file", "not a file"],
      ],
    ],
    [
      "an empty file",
      [
        ["purpose", "x"],
        ["file", file(0), "a.jpg"],
      ],
    ],
  ] as [string, [string, string | Blob, string?][]][])(
    "refuses %s with invalid_request",
    async (_label, entries) => {
      expect(await readUploadForm(request(form(entries)), MAX)).toEqual({
        ok: false,
        error: "invalid_request",
      });
    },
  );

  it("refuses bodies that are not multipart", async () => {
    const json = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await readUploadForm(json, MAX)).toEqual({
      ok: false,
      error: "invalid_request",
    });
    const raw = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([0xff, 0xd8, 0xff]),
    });
    expect((await readUploadForm(raw, MAX)).ok).toBe(false);
  });

  it("refuses a malformed multipart body", async () => {
    const req = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      body: "this is not multipart",
    });
    expect(await readUploadForm(req, MAX)).toEqual({
      ok: false,
      error: "invalid_request",
    });
  });

  it("uses the 8 MiB limit by default", () => {
    expect(UPLOAD_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
  });
});
