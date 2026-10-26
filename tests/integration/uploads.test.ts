import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { listRoles } from "@/modules/identity/roles-service";
import { user } from "@/modules/identity/schema";
import {
  SIGNED_URL_TTL_SECONDS,
  UPLOAD_LIMITS,
} from "@/modules/uploads/constants";
import {
  handleCreateUpload,
  handleGetUploadStatus,
} from "@/modules/uploads/http";
import {
  failUpload,
  outputKeyFor,
  processUpload,
  reencodeImage,
} from "@/modules/uploads/processing";
import { upload } from "@/modules/uploads/schema";
import {
  createUpload,
  issueSignedUrl,
  ownerMayView,
  type UploadDeps,
  type ViewAuthorizer,
} from "@/modules/uploads/service";
import { scanBuffer } from "@/shared/av/clamd";
import {
  createClientBoss,
  createWorkerBoss,
  type PgBoss,
} from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import {
  getObjectBytes,
  objectExists,
  presignGet,
  putObject,
} from "@/shared/storage/objects";
import {
  HANDLERS,
  registerHandlers,
  type WorkerDeps,
} from "../../worker/handlers";
import { APP_URL, type Harness, startHarness } from "./helpers/auth-harness";
import {
  type Clamd,
  eicar,
  type ObjectStorage,
  startClamd,
  startObjectStorage,
} from "./helpers/services";

// The private upload pipeline (ADR-004, 4a) against real PostgreSQL (with
// pg-boss), MinIO and clamd. Requests go through the same handlers the routes
// use, with an Actor built from a real Better Auth session.

const PASSWORD = "correct horse battery staple";
let h: Harness;
let storage: ObjectStorage;
let clamd: Clamd;
let boss: PgBoss;
let deps: UploadDeps;
let workerDeps: WorkerDeps;
const logLines: string[] = [];
let counter = 0;

const logger = createLogger(
  { level: "debug" },
  new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  }),
);

beforeAll(async () => {
  [h, storage, clamd] = await Promise.all([
    startHarness(),
    startObjectStorage(),
    startClamd(),
  ]);
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  const store = { s3: storage.s3, bucket: storage.bucket };
  deps = { db: h.db, store, boss, logger };
  workerDeps = {
    db: h.db,
    boss,
    store,
    scan: (bytes) => scanBuffer(clamd.config, bytes),
    emailSender: { send: async () => {} },
    appUrl: APP_URL,
    logger,
  };
}, 360_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await Promise.all([h?.stop(), storage?.stop(), clamd?.stop()]);
});

/** A real verified user, signed in; the Actor is built from its session. */
async function member(label: string): Promise<Actor> {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const signedIn = await h.signIn(email, PASSWORD);
  const current = await h.call("/get-session", { jar: signedIn.jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  return actorFromSession(session, await listRoles(h.db, session.user.id));
}

// --- request helpers --------------------------------------------------------

function uploadRequest(
  bytes: Uint8Array,
  options: {
    filename?: string;
    type?: string;
    purpose?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const form = new FormData();
  form.append("purpose", options.purpose ?? "verification_document");
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: options.type ?? "image/jpeg" }),
    options.filename ?? "photo.jpg",
  );
  return new Request(`${APP_URL}/api/uploads`, {
    method: "POST",
    headers: { origin: APP_URL, ...options.headers },
    body: form,
  });
}

async function post(actor: Actor | null, request: Request) {
  const response = await handleCreateUpload(deps, actor, request, APP_URL);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: JSON.parse(text) as Record<string, unknown>,
  };
}

async function uploadOk(actor: Actor, bytes: Uint8Array) {
  const result = await post(actor, uploadRequest(bytes));
  expect(result.status).toBe(202);
  return result.json.id as string;
}

async function statusOf(actor: Actor | null, id: string) {
  const response = await handleGetUploadStatus(deps, actor, id);
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function rowOf(id: string) {
  const [row] = await h.db.select().from(upload).where(eq(upload.id, id));
  return row;
}

/** Runs queued `upload.process` jobs through the worker's handler, like the worker does. */
async function drainQueue() {
  for (;;) {
    const jobs = await boss.fetch<{ uploadId: string }>("upload.process", {
      batchSize: 20,
    });
    if (jobs.length === 0) return;
    for (const job of jobs) {
      await HANDLERS["upload.process"](workerDeps, job.data, job.id);
      await boss.complete("upload.process", job.id);
    }
  }
}

// --- fixtures (generated at runtime) ----------------------------------------

const GPS = {
  IFD0: { Make: "FixtureCam", Model: "GPS-1", Software: "fixture" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "30/1 2/1 4/1",
    GPSLongitudeRef: "E",
    GPSLongitude: "31/1 14/1 9/1",
  },
};

async function jpegWithGps(width = 320, height = 200) {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#2d6a4f" },
    })
      .jpeg({ quality: 90 })
      .withExif(GPS)
      .toBuffer(),
  );
}

async function image(format: "png" | "webp", width = 50, height = 40) {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 4, background: "#ff000080" },
    })
      .toFormat(format)
      .toBuffer(),
  );
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// --- tests -------------------------------------------------------------------

describe("upload → processing → clean", () => {
  it("accepts a JPEG with GPS EXIF, processes it and serves it without metadata", async () => {
    const owner = await member("owner");
    const input = await jpegWithGps(3000, 2000);
    expect((await sharp(input).metadata()).exif).toBeDefined();
    expect(Buffer.from(input).includes("FixtureCam")).toBe(true);

    const created = await post(owner, uploadRequest(input));
    expect(created.status).toBe(202);
    expect(Object.keys(created.json).sort()).toEqual(["id", "status"]);
    expect(created.json.status).toBe("processing");
    const id = created.json.id as string;
    expect(created.headers.get("location")).toBe(`/api/uploads/${id}`);
    expect(created.headers.get("cache-control")).toBe("no-store");

    // Row, quarantine object and job, created together.
    const row = await rowOf(id);
    expect(row).toMatchObject({
      userId: owner.userId,
      purpose: "verification_document",
      status: "processing",
      contentType: "image/jpeg",
      byteSize: input.byteLength,
      objectKey: null,
      sha256: null,
    });
    expect(row?.quarantineKey).toMatch(/^quarantine\/[0-9a-f-]{36}$/);
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(true);
    const jobs = await boss.findJobs("upload.process", {
      data: { uploadId: id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ uploadId: id });

    expect(await statusOf(owner, id)).toEqual({
      status: 200,
      json: { id, status: "processing", rejectReason: null },
    });

    await drainQueue();

    expect((await statusOf(owner, id)).json).toEqual({
      id,
      status: "clean",
      rejectReason: null,
    });
    const clean = await rowOf(id);
    expect(clean?.objectKey).toBe(outputKeyFor(row!.quarantineKey));
    expect(clean?.contentType).toBe("image/jpeg");
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(false);

    // Viewed through a fresh 5-minute presigned URL.
    const signed = await issueSignedUrl(deps, owner, {
      uploadId: id,
      purpose: "verification_document",
      authorize: ownerMayView,
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.expiresInSeconds).toBe(300);
    const url = new URL(signed.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(SIGNED_URL_TTL_SECONDS),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await fetch(signed.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/jpeg");
    expect(fetched.headers.get("cache-control")).toBe("private, no-store");
    const output = new Uint8Array(await fetched.arrayBuffer());
    expect(sha256(output)).toBe(clean?.sha256);
    expect(output.byteLength).toBe(clean?.byteSize);

    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(
      UPLOAD_LIMITS.maxLongSide,
    );
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(Buffer.from(output).includes("FixtureCam")).toBe(false);
    expect(Buffer.from(output).includes("Exif")).toBe(false);

    // The object itself is private: no signature, no access.
    const unsigned = await fetch(
      `${storage.endpoint}/${storage.bucket}/${clean!.objectKey}`,
    );
    expect(unsigned.status).toBe(403);
  });

  it.each(["png", "webp"] as const)("re-encodes %s to JPEG", async (format) => {
    const owner = await member(format);
    const id = await uploadOk(owner, await image(format));
    expect((await rowOf(id))?.contentType).toBe(`image/${format}`);
    await drainQueue();
    const row = await rowOf(id);
    expect(row?.status).toBe("clean");
    expect(row?.contentType).toBe("image/jpeg");
    const bytes = await getObjectBytes(
      deps.store,
      row!.objectKey!,
      UPLOAD_LIMITS.maxBytes,
    );
    expect((await sharp(bytes!).metadata()).format).toBe("jpeg");
  });

  it("runs end to end in the real worker process wiring", async () => {
    const owner = await member("worker");
    const worker = createWorkerBoss(h.url, logger);
    await worker.start();
    try {
      await registerHandlers(worker, workerDeps);
      const id = await uploadOk(owner, await jpegWithGps());
      let status: unknown = "processing";
      for (let i = 0; i < 60 && status === "processing"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = (await statusOf(owner, id)).json.status;
      }
      expect(status).toBe("clean");
    } finally {
      await worker.stop({ graceful: true, timeout: 5000 });
    }
  });
});

describe("rejections", () => {
  it("refuses garbage bytes named .jpg with image/jpeg at upload, storing nothing", async () => {
    const owner = await member("garbage");
    const garbage = new TextEncoder().encode(
      "<html><script>alert(1)</script></html>",
    );
    const result = await post(
      owner,
      uploadRequest(garbage, { filename: "cv.jpg", type: "image/jpeg" }),
    );
    expect(result).toMatchObject({
      status: 415,
      json: { error: "unsupported_type" },
    });
    const rows = await h.db
      .select()
      .from(upload)
      .where(eq(upload.userId, owner.userId));
    expect(rows).toHaveLength(0);
  });

  it("refuses the EICAR file at upload: it is not an image", async () => {
    const owner = await member("eicar-direct");
    const result = await post(
      owner,
      uploadRequest(eicar(), { filename: "id.jpg" }),
    );
    expect(result.status).toBe(415);
  });

  it("refuses a file over 8 MiB with 413", async () => {
    const owner = await member("big");
    const big = new Uint8Array(UPLOAD_LIMITS.maxBytes + 1);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    const result = await post(owner, uploadRequest(big));
    expect(result).toMatchObject({ status: 413, json: { error: "too_large" } });
  });

  it("rejects an infected file found by clamd and deletes it", async () => {
    const owner = await member("infected");
    const id = await uploadOk(owner, await jpegWithGps());
    const row = await rowOf(id);
    // Simulates malware that passed the signature gate: the quarantined bytes
    // are replaced with the EICAR test file before the worker scans them.
    await putObject(
      deps.store,
      row!.quarantineKey,
      eicar(),
      "application/octet-stream",
    );

    expect(await processUpload(workerDeps, id)).toBe("rejected");
    expect((await statusOf(owner, id)).json).toEqual({
      id,
      status: "rejected",
      rejectReason: "infected",
    });
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(false);
    expect(
      await objectExists(deps.store, outputKeyFor(row!.quarantineKey)),
    ).toBe(false);
    expect(logLines.some((l) => l.includes("Eicar") && l.includes(id))).toBe(
      true,
    );
    const url = await issueSignedUrl(deps, owner, {
      uploadId: id,
      purpose: "verification_document",
      authorize: ownerMayView,
    });
    expect(url).toEqual({ ok: false, error: "not_found" });
  });

  it("rejects a file that starts like a JPEG but does not decode", async () => {
    const owner = await member("undecodable");
    const fake = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...new Uint8Array(5000).fill(0x42),
    ]);
    const id = await uploadOk(owner, fake);
    const row = await rowOf(id);
    expect(await processUpload(workerDeps, id)).toBe("rejected");
    expect((await rowOf(id))?.rejectReason).toBe("undecodable");
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(false);
  });

  it("rejects a decompression bomb (too many pixels) as undecodable", async () => {
    const owner = await member("bomb");
    const bomb = new Uint8Array(
      await sharp({
        create: {
          width: 10_000,
          height: 6_000,
          channels: 3,
          background: "#000",
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
    expect(bomb.byteLength).toBeLessThan(UPLOAD_LIMITS.maxBytes);
    const id = await uploadOk(owner, bomb);
    expect(await processUpload(workerDeps, id)).toBe("rejected");
    expect((await rowOf(id))?.rejectReason).toBe("undecodable");
  });
});

describe("authorization", () => {
  it("answers 401 without a session and 403 for a cross-site request or unverified email", async () => {
    const owner = await member("authz");
    const jpeg = await jpegWithGps();
    expect((await post(null, uploadRequest(jpeg))).status).toBe(401);
    expect(
      (
        await post(
          owner,
          uploadRequest(jpeg, { headers: { origin: "http://evil.test" } }),
        )
      ).json,
    ).toEqual({ error: "forbidden" });
    expect(
      (await post({ ...owner, emailVerified: false }, uploadRequest(jpeg)))
        .status,
    ).toBe(403);
    expect(
      (await post(owner, uploadRequest(jpeg, { purpose: "avatar" }))).json,
    ).toEqual({
      error: "invalid_request",
    });
  });

  it("hides another user's upload: status 404, no signed URL", async () => {
    const owner = await member("mine");
    const other = await member("theirs");
    const id = await uploadOk(owner, await jpegWithGps());
    await drainQueue();
    expect((await statusOf(owner, id)).json.status).toBe("clean");

    expect(await statusOf(other, id)).toEqual({
      status: 404,
      json: { error: "not_found" },
    });
    expect((await statusOf(null, id)).status).toBe(401);
    expect(
      await issueSignedUrl(deps, other, {
        uploadId: id,
        purpose: "verification_document",
        authorize: ownerMayView,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    // Staff roles do not widen the owner rule.
    const staff = {
      ...other,
      roles: ["verification_reviewer" as const],
      mfaSatisfied: true,
    };
    expect(
      (
        await issueSignedUrl(deps, staff, {
          uploadId: id,
          purpose: "verification_document",
          authorize: ownerMayView,
        })
      ).ok,
    ).toBe(false);
  });

  it("answers 404 for unknown and malformed ids", async () => {
    const owner = await member("ids");
    expect(
      (await statusOf(owner, "6f1c9a52-3d4e-4b8a-9c1d-2e3f4a5b6c7d")).status,
    ).toBe(404);
    expect((await statusOf(owner, "../../etc/passwd")).status).toBe(404);
  });

  it("lets a caller-supplied authorizer decide, after the upload is found clean", async () => {
    const owner = await member("authorizer");
    const reviewer = await member("reviewer");
    const id = await uploadOk(owner, await jpegWithGps());

    const calls: string[] = [];
    const allowReviewer: ViewAuthorizer = (actor, request) => {
      calls.push(
        `${actor.userId}:${request.uploadId}:${request.ownerId}:${request.purpose}`,
      );
      return actor.userId === reviewer.userId;
    };
    const ask = (actor: Actor) =>
      issueSignedUrl(deps, actor, {
        uploadId: id,
        purpose: "verification_document",
        authorize: allowReviewer,
      });

    // Not clean yet: refused without asking the authorizer (nothing is logged as viewed).
    expect((await ask(reviewer)).ok).toBe(false);
    expect(calls).toHaveLength(0);

    await drainQueue();
    expect((await ask(reviewer)).ok).toBe(true);
    expect((await ask(owner)).ok).toBe(false);
    expect(calls).toEqual([
      `${reviewer.userId}:${id}:${owner.userId}:verification_document`,
      `${owner.userId}:${id}:${owner.userId}:verification_document`,
    ]);
  });

  it("refuses URLs once expired and storage enforces the expiry", async () => {
    const owner = await member("expiry");
    const id = await uploadOk(owner, await jpegWithGps());
    await drainQueue();
    const key = (await rowOf(id))!.objectKey!;
    const stale = await presignGet(
      deps.store,
      key,
      SIGNED_URL_TTL_SECONDS,
      "image/jpeg",
      new Date(Date.now() - (SIGNED_URL_TTL_SECONDS + 5) * 1000),
    );
    expect((await fetch(stale)).status).toBe(403);
    const fresh = await presignGet(
      deps.store,
      key,
      SIGNED_URL_TTL_SECONDS,
      "image/jpeg",
    );
    expect((await fetch(fresh)).status).toBe(200);
  });
});

describe("job idempotency and failure handling", () => {
  it("does nothing when the job runs again after success", async () => {
    const owner = await member("twice");
    const id = await uploadOk(owner, await jpegWithGps());
    expect(await processUpload(workerDeps, id)).toBe("clean");
    const first = await rowOf(id);
    expect(await processUpload(workerDeps, id)).toBe("skipped");
    expect(await rowOf(id)).toEqual(first);
    expect(await objectExists(deps.store, first!.objectKey!)).toBe(true);
  });

  it("finishes a run that stored the output and deleted quarantine but crashed before marking clean", async () => {
    const owner = await member("crash-late");
    const input = await jpegWithGps();
    const id = await uploadOk(owner, input);
    const row = await rowOf(id);
    const output = await reencodeImage(input);
    await putObject(
      deps.store,
      outputKeyFor(row!.quarantineKey),
      output,
      "image/jpeg",
    );
    await deps.store.s3.send(
      new DeleteObjectCommand({
        Bucket: deps.store.bucket,
        Key: row!.quarantineKey,
      }),
    );
    expect(await processUpload(workerDeps, id)).toBe("clean");
    expect((await rowOf(id))?.sha256).toBe(sha256(output));
  });

  it("redoes a run that crashed after storing the output but before deleting quarantine", async () => {
    const owner = await member("crash-mid");
    const id = await uploadOk(owner, await jpegWithGps());
    const row = await rowOf(id);
    await putObject(
      deps.store,
      outputKeyFor(row!.quarantineKey),
      Uint8Array.of(1, 2, 3),
      "image/jpeg",
    );
    expect(await processUpload(workerDeps, id)).toBe("clean");
    const done = await rowOf(id);
    const stored = await getObjectBytes(
      deps.store,
      done!.objectKey!,
      UPLOAD_LIMITS.maxBytes,
    );
    expect(sha256(stored!)).toBe(done?.sha256);
    expect(stored!.byteLength).toBeGreaterThan(3);
  });

  it("two concurrent runs of the same job leave exactly one clean object", async () => {
    const owner = await member("concurrent-job");
    const id = await uploadOk(owner, await jpegWithGps());
    const outcomes = await Promise.all([
      processUpload(workerDeps, id),
      processUpload(workerDeps, id),
    ]);
    expect(outcomes.filter((o) => o === "clean")).toHaveLength(1);
    const row = await rowOf(id);
    expect(row?.status).toBe("clean");
    expect(await objectExists(deps.store, row!.objectKey!)).toBe(true);
  });

  it("throws, leaving the upload processing, when clamd is unreachable (so pg-boss retries)", async () => {
    const owner = await member("clamd-down");
    const id = await uploadOk(owner, await jpegWithGps());
    const down = {
      ...workerDeps,
      scan: (b: Uint8Array) =>
        scanBuffer({ host: "127.0.0.1", port: 1, timeoutMs: 1000 }, b),
    };
    await expect(processUpload(down, id)).rejects.toThrow(/clamd/);
    const row = await rowOf(id);
    expect(row?.status).toBe("processing");
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(true);
    // A later attempt with clamd back succeeds.
    expect(await processUpload(workerDeps, id)).toBe("clean");
  });

  it("dead-letter handling rejects the upload and deletes both objects", async () => {
    const owner = await member("dead");
    const id = await uploadOk(owner, await jpegWithGps());
    const row = await rowOf(id);
    await putObject(
      deps.store,
      outputKeyFor(row!.quarantineKey),
      Uint8Array.of(1),
      "image/jpeg",
    );
    expect(await failUpload(workerDeps, id)).toBe("rejected");
    expect((await statusOf(owner, id)).json.rejectReason).toBe(
      "processing_failed",
    );
    expect(await objectExists(deps.store, row!.quarantineKey)).toBe(false);
    expect(
      await objectExists(deps.store, outputKeyFor(row!.quarantineKey)),
    ).toBe(false);
    expect(await failUpload(workerDeps, id)).toBe("skipped");
  });

  it("skips jobs whose upload no longer exists (account deleted)", async () => {
    const owner = await member("gone");
    const id = await uploadOk(owner, await jpegWithGps());
    await h.db.delete(user).where(eq(user.id, owner.userId));
    expect(await rowOf(id)).toBeUndefined();
    expect(await processUpload(workerDeps, id)).toBe("skipped");
  });

  it("completes, without retrying, a job whose payload is invalid", async () => {
    await expect(
      HANDLERS["upload.process"](workerDeps, { uploadId: "nope" }, "job-1"),
    ).resolves.toBeUndefined();
    expect(logLines.some((l) => l.includes("job.invalid_payload"))).toBe(true);
  });
});

describe("limits", () => {
  it(`caps uploads waiting in processing at ${UPLOAD_LIMITS.maxProcessingPerUser} per user`, async () => {
    const owner = await member("cap");
    const jpeg = await jpegWithGps(16, 16);
    for (let i = 0; i < UPLOAD_LIMITS.maxProcessingPerUser; i++)
      await uploadOk(owner, jpeg);
    expect((await post(owner, uploadRequest(jpeg))).json).toEqual({
      error: "too_many_pending",
    });
    // Another user is unaffected.
    await uploadOk(await member("cap-other"), jpeg);
    // Once processed, the user can upload again.
    await drainQueue();
    await uploadOk(owner, jpeg);
  });

  it("holds the processing cap under concurrent uploads", async () => {
    const owner = await member("cap-race");
    const jpeg = await jpegWithGps(16, 16);
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        createUpload(deps, owner, {
          purpose: "verification_document",
          bytes: jpeg,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(
      UPLOAD_LIMITS.maxProcessingPerUser,
    );
    expect(
      results.filter((r) => !r.ok && r.error === "too_many_pending"),
    ).toHaveLength(5);
    const rows = await h.db
      .select()
      .from(upload)
      .where(eq(upload.userId, owner.userId));
    expect(rows).toHaveLength(UPLOAD_LIMITS.maxProcessingPerUser);
    // Refused attempts leave no quarantine object behind.
    const listed = await deps.store.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.store.bucket,
        Prefix: "quarantine/",
      }),
    );
    const keys = new Set((listed.Contents ?? []).map((o) => o.Key));
    for (const row of rows) expect(keys.has(row.quarantineKey)).toBe(true);
    await drainQueue();
  });

  it(`limits each user to ${UPLOAD_LIMITS.hourly.max} attempts per hour, counting refused ones`, async () => {
    const owner = await member("rate");
    const garbage = new TextEncoder().encode("not an image");
    for (let i = 0; i < UPLOAD_LIMITS.hourly.max; i++)
      expect((await post(owner, uploadRequest(garbage))).status).toBe(415);
    const limited = await post(owner, uploadRequest(await jpegWithGps(16, 16)));
    expect(limited).toMatchObject({
      status: 429,
      json: { error: "rate_limited" },
    });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Per user, not global.
    await uploadOk(await member("rate-other"), await jpegWithGps(16, 16));
  });
});

describe("privacy of responses and logs", () => {
  it("never returns or logs object keys, URLs or email addresses", async () => {
    const owner = await member("privacy");
    const created = await post(owner, uploadRequest(await jpegWithGps()));
    await drainQueue();
    const status = await statusOf(owner, created.json.id as string);
    for (const body of [created.text, JSON.stringify(status.json)]) {
      expect(body).not.toMatch(/quarantine\/|documents\/|X-Amz|http/);
    }
    const logs = logLines.join("\n");
    expect(logs).not.toMatch(
      /quarantine\/[0-9a-f]|documents\/[0-9a-f]|X-Amz-Signature/,
    );
    expect(logs).not.toMatch(/@example\.test/);
  });
});
