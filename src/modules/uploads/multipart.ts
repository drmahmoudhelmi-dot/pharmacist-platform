import { UPLOAD_LIMITS } from "./constants";

// Reads the upload form (one `file` part, one `purpose` field) from a request
// without ever holding more than the size limit plus multipart overhead in
// memory. A declared Content-Length over the limit is refused before reading;
// a body that grows past it while streaming is cut off at that point.

export type UploadForm = { purpose: string; bytes: Uint8Array };

export type ReadFormResult =
  | { ok: true; form: UploadForm }
  | { ok: false; error: "too_large" | "invalid_request" };

const ALLOWED_FIELDS = new Set(["file", "purpose"]);

export async function readUploadForm(
  request: Request,
  maxFileBytes: number = UPLOAD_LIMITS.maxBytes,
): Promise<ReadFormResult> {
  const invalid = { ok: false, error: "invalid_request" } as const;
  const tooLarge = { ok: false, error: "too_large" } as const;
  const maxBodyBytes = maxFileBytes + UPLOAD_LIMITS.multipartOverheadBytes;

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType))
    return invalid;

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return invalid;
    if (Number(declared) > maxBodyBytes) return tooLarge;
  }
  if (!request.body) return invalid;

  let received = 0;
  let exceeded = false;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBodyBytes) {
          exceeded = true;
          // Errors the parser and cancels the rest of the request body.
          controller.error(new Error("body too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  let data: FormData;
  try {
    data = await new Response(limited, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    return exceeded ? tooLarge : invalid;
  }

  const keys = [...data.keys()];
  if (keys.some((key) => !ALLOWED_FIELDS.has(key))) return invalid;
  const files = data.getAll("file");
  const purposes = data.getAll("purpose");
  const file = files[0];
  const purpose = purposes[0];
  if (files.length !== 1 || !(file instanceof File)) return invalid;
  if (purposes.length !== 1 || typeof purpose !== "string") return invalid;
  if (file.size > maxFileBytes) return tooLarge;
  if (file.size === 0) return invalid;

  // The part's filename and Content-Type are ignored on purpose.
  return {
    ok: true,
    form: { purpose, bytes: new Uint8Array(await file.arrayBuffer()) },
  };
}
