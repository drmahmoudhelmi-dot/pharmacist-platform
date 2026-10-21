import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import { user } from "@/modules/identity/schema";
import {
  exportOwnData,
  getProfileForViewer,
  upsertOwnProfile,
} from "@/modules/profiles/service";
import { processUpload } from "@/modules/uploads/processing";
import { upload } from "@/modules/uploads/schema";
import { createUpload, type UploadDeps } from "@/modules/uploads/service";
import { handleViewDocument } from "@/modules/verification/http";
import { expireVerifications } from "@/modules/verification/jobs";
import {
  loadNationalIdKeys,
  type NationalIdKeys,
} from "@/modules/verification/keys";
import { cairoToday } from "@/modules/verification/national-id";
import {
  documentAccessLog,
  verificationDecision,
  verificationDocument,
  verificationSubmission,
} from "@/modules/verification/schema";
import {
  decide,
  exportOwnVerification,
  getMyVerificationStatus,
  getSubmissionForReview,
  getVerificationBadge,
  listQueue,
  revealNationalId,
  submitVerification,
  type VerificationDeps,
  viewDocument,
} from "@/modules/verification/service";
import type { EmailMessage } from "@/shared/email/sender";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import { HANDLERS, type WorkerDeps } from "../../worker/handlers";
import {
  APP_URL,
  type CookieJar,
  type Harness,
  startHarness,
} from "./helpers/auth-harness";
import { type ObjectStorage, startObjectStorage } from "./helpers/services";
import { totpFromUri } from "./helpers/totp";

// Professional verification (ADR-004, 4b) against real PostgreSQL (with
// pg-boss) and MinIO. Users and reviewers are real Better Auth accounts; the
// reviewer's Actor comes from a session that passed TOTP. Uploads go through
// the real pipeline with a stub scanner (clamd is covered by uploads.test.ts).
// National ID numbers are synthetic, built from the documented structure.

const PASSWORD = "correct horse battery staple";
let h: Harness;
let storage: ObjectStorage;
let boss: PgBoss;
let keys: NationalIdKeys;
let encryptionKeyB64: string;
let hashKeyB64: string;
let deps: VerificationDeps;
let uploadDeps: UploadDeps;
let workerDeps: WorkerDeps;
const logLines: string[] = [];
const outbox: EmailMessage[] = [];
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
  [h, storage] = await Promise.all([startHarness(), startObjectStorage()]);
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  // Generated per run: no key-shaped literal lives in the repository.
  encryptionKeyB64 = randomBytes(32).toString("base64");
  hashKeyB64 = randomBytes(32).toString("base64");
  keys = loadNationalIdKeys({
    NATIONAL_ID_ENCRYPTION_KEY: encryptionKeyB64,
    NATIONAL_ID_HASH_KEY: hashKeyB64,
  });
  const store = { s3: storage.s3, bucket: storage.bucket };
  deps = { db: h.db, boss, logger, keys };
  uploadDeps = { db: h.db, store, boss, logger };
  workerDeps = {
    db: h.db,
    store,
    scan: async () => ({ infected: false }),
    emailSender: { send: async (m) => void outbox.push(m) },
    appUrl: APP_URL,
    logger,
  };
}, 300_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await Promise.all([h?.stop(), storage?.stop()]);
});

// --- people -------------------------------------------------------------------

async function sessionActor(jar: CookieJar): Promise<Actor> {
  const current = await h.call("/get-session", { jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  return actorFromSession(session, await listRoles(h.db, session.user.id));
}

async function member(label: string) {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const { jar } = await h.signIn(email, PASSWORD);
  return { actor: await sessionActor(jar), email, jar };
}

/** A verification reviewer: role granted by the operator path, TOTP passed. */
async function reviewer(label: string, withMfa = true) {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const granted = await changeRole(h.db, {
    email,
    role: "verification_reviewer",
    change: "grant",
  });
  expect(granted.status).toBe("granted");
  const { jar } = await h.signIn(email, PASSWORD);
  if (withMfa) {
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar,
    });
    const verify = await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(enable.json?.totpURI as string) },
      jar,
    });
    expect(verify.status).toBe(200);
  }
  const actor = await sessionActor(jar);
  expect(actor.mfaSatisfied).toBe(withMfa);
  return { actor, email };
}

// --- data ---------------------------------------------------------------------

let idCounter = 0;
/** A fresh synthetic national ID: born 15 March 1990 in Cairo, unique serial. */
function nationalId(): string {
  idCounter += 1;
  return `2900315${"01"}${String(10_000 + idCounter).slice(-4)}${idCounter % 10}`;
}

const jpeg = async () =>
  new Uint8Array(
    await sharp({
      create: {
        width: 64,
        height: 40,
        channels: 3,
        background: { r: counter % 255, g: 90, b: 80 },
      },
    })
      .jpeg()
      .toBuffer(),
  );

/** An upload through the real pipeline (stub scanner); `process: false` leaves it processing. */
async function uploadFor(actor: Actor, process = true): Promise<string> {
  const created = await createUpload(uploadDeps, actor, {
    purpose: "verification_document",
    bytes: await jpeg(),
  });
  if (!created.ok) throw new Error(created.error);
  if (process)
    expect(await processUpload(workerDeps, created.upload.id)).toBe("clean");
  return created.upload.id;
}

async function pharmacistForm(
  actor: Actor,
  over: Record<string, unknown> = {},
) {
  return {
    credentialType: "pharmacist",
    nationalId: nationalId(),
    syndicateNumber: "12345",
    consent: "on",
    national_id_front: await uploadFor(actor),
    national_id_back: await uploadFor(actor),
    syndicate_card: await uploadFor(actor),
    ...over,
  };
}

async function submitted(actor: Actor, over: Record<string, unknown> = {}) {
  const form = await pharmacistForm(actor, over);
  const result = await submitVerification(deps, actor, form);
  if (!result.ok) throw new Error(`submit failed: ${result.error}`);
  return { id: result.submission.id, form };
}

async function rowOf(id: string) {
  const [row] = await h.db
    .select()
    .from(verificationSubmission)
    .where(eq(verificationSubmission.id, id));
  return row;
}

async function accessLogFor(submissionId: string) {
  return h.db
    .select()
    .from(documentAccessLog)
    .where(eq(documentAccessLog.submissionId, submissionId));
}

async function documentsOf(submissionId: string) {
  return h.db
    .select()
    .from(verificationDocument)
    .where(eq(verificationDocument.submissionId, submissionId));
}

/** Runs queued notice jobs through the worker's handler, like the worker. */
async function drainNotices() {
  for (;;) {
    const jobs = await boss.fetch<{ submissionId: string; kind: string }>(
      "verification.notify",
      { batchSize: 20 },
    );
    if (jobs.length === 0) return;
    for (const job of jobs) {
      await HANDLERS["verification.notify"](workerDeps, job.data, job.id);
      await boss.complete("verification.notify", job.id);
    }
  }
}

/** `YYYY-MM-DD` plus n days (calendar arithmetic, no time zone involved). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const today = () => cairoToday(new Date());

/** The email to `to` with this subject (job order within a drain is not fixed). */
const mailTo = (to: string, subject: string) =>
  outbox.find((m) => m.to === to && m.subject === subject);

// --- submitting ----------------------------------------------------------------

describe("submitting", () => {
  it("stores a pending submission with an encrypted ID, its documents and a 'received' email", async () => {
    const { actor, email } = await member("submit");
    const expiry = addDays(today(), 400);
    const form = await pharmacistForm(actor, { cardExpiresOn: expiry });
    const result = await submitVerification(deps, actor, form, "ar");
    expect(result).toEqual({
      ok: true,
      submission: {
        id: expect.any(String),
        status: "pending",
        nationalIdMasked: `2**********${form.nationalId.slice(11)}`,
      },
    });
    if (!result.ok) return;
    const row = await rowOf(result.submission.id);
    expect(row).toMatchObject({
      userId: actor.userId,
      credentialType: "pharmacist",
      status: "pending",
      syndicateNumber: "12345",
      university: null,
      cardExpiresOn: expiry,
      nationalIdMasked: `2**********${form.nationalId.slice(11)}`,
      keyId: keys.encryption.current.id,
      consentVersion: "draft-pending-counsel",
      locale: "ar",
      decidedAt: null,
    });
    expect(row?.nationalIdCiphertext).toMatch(/^v1\./);
    expect(row?.nationalIdCiphertext).not.toContain(form.nationalId);
    expect(row?.nationalIdHash).toMatch(/^[0-9a-f]{64}$/);
    const docs = await documentsOf(result.submission.id);
    expect(docs.map((d) => d.kind).sort()).toEqual([
      "national_id_back",
      "national_id_front",
      "syndicate_card",
    ]);

    const status = await getMyVerificationStatus(h.db, actor);
    expect(status).toMatchObject({
      state: "pending",
      canSubmit: false,
      credentialType: "pharmacist",
      nationalIdMasked: `2**********${form.nationalId.slice(11)}`,
    });
    expect(JSON.stringify(status)).not.toContain(row!.nationalIdCiphertext);

    await drainNotices();
    const mail = mailTo(email, "استلمنا طلب التوثيق - منصة الصيادلة");
    expect(mail?.language).toBe("ar");
    expect(mail?.text).toContain(`${APP_URL}/verification`);
    expect(mail?.text).not.toContain(form.nationalId);
    expect(mail?.html).not.toContain(form.nationalId);
  });

  it("accepts a student with Arabic digits and sends English email when submitted in English", async () => {
    const { actor, email } = await member("student");
    const id = nationalId();
    const arabic = id.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
    const result = await submitVerification(
      deps,
      actor,
      {
        credentialType: "student",
        nationalId: arabic,
        university: "جامعة عين شمس",
        consent: "on",
        national_id_front: await uploadFor(actor),
        national_id_back: await uploadFor(actor),
        student_card: await uploadFor(actor),
      },
      "en",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.nationalIdMasked).toBe(
      `2**********${id.slice(11)}`,
    );
    await drainNotices();
    const mail = mailTo(
      email,
      "Verification request received - Pharmacist Platform",
    );
    expect(mail?.language).toBe("en");
    expect(mail?.text).toContain(`${APP_URL}/en/verification`);
  });

  it("requires every document kind for the credential type", async () => {
    const { actor } = await member("missing-doc");
    const form = await pharmacistForm(actor);
    const { syndicate_card: _omit, ...withoutCard } = form;
    void _omit;
    expect(await submitVerification(deps, actor, withoutCard)).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { syndicate_card: "required" },
    });
    // A student card does not stand in for a syndicate card.
    expect(
      await submitVerification(deps, actor, {
        ...withoutCard,
        student_card: form.syndicate_card,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { syndicate_card: "required" } });
  });

  it("refuses someone else's upload, a processing one, a rejected one and a reused one", async () => {
    const { actor } = await member("docs-owner");
    const { actor: other } = await member("docs-other");
    const foreign = await uploadFor(other);
    expect(
      await submitVerification(
        deps,
        actor,
        await pharmacistForm(actor, { national_id_front: foreign }),
      ),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { national_id_front: "documentNotFound" },
    });

    const processing = await uploadFor(actor, false);
    expect(
      await submitVerification(
        deps,
        actor,
        await pharmacistForm(actor, { national_id_back: processing }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { national_id_back: "documentProcessing" },
    });

    const rejected = await uploadFor(actor, false);
    await h.db
      .update(upload)
      .set({ status: "rejected", rejectReason: "infected" })
      .where(eq(upload.id, rejected));
    expect(
      await submitVerification(
        deps,
        actor,
        await pharmacistForm(actor, { syndicate_card: rejected }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { syndicate_card: "documentRejected" },
    });

    const same = await uploadFor(actor);
    expect(
      await submitVerification(
        deps,
        actor,
        await pharmacistForm(actor, {
          national_id_front: same,
          national_id_back: same,
        }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { national_id_back: "documentInUse" },
    });
    // Nothing was stored by any of these.
    expect(
      await h.db
        .select()
        .from(verificationSubmission)
        .where(eq(verificationSubmission.userId, actor.userId)),
    ).toHaveLength(0);
  });

  it("refuses an unverified email, an invalid ID and missing consent", async () => {
    const { actor } = await member("invalid");
    const form = await pharmacistForm(actor);
    expect(
      await submitVerification(deps, { ...actor, emailVerified: false }, form),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await submitVerification(deps, actor, {
        ...form,
        nationalId: "29013150112345",
        consent: "",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: {
        nationalId: "invalidBirthDate",
        consent: "consentRequired",
      },
    });
  });

  it("allows one pending submission per user, also under concurrent submits", async () => {
    const { actor } = await member("one-pending");
    const [a, b] = await Promise.all([
      pharmacistForm(actor),
      pharmacistForm(actor),
    ]);
    const results = await Promise.all([
      submitVerification(deps, actor, a),
      submitVerification(deps, actor, b),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({
      ok: false,
      error: "already_pending",
    });
    expect(
      await submitVerification(deps, actor, await pharmacistForm(actor)),
    ).toEqual({ ok: false, error: "already_pending" });
  });
});

// --- national ID uniqueness -------------------------------------------------------

describe("national ID uniqueness", () => {
  it("blocks another account while the first is pending or verified; frees it after rejection", async () => {
    const { actor: first } = await member("dup-first");
    const { actor: second } = await member("dup-second");
    const { actor: rev } = await reviewer("dup-reviewer");
    const shared = nationalId();

    const a = await submitted(first, { nationalId: shared });
    const blocked = await submitVerification(
      deps,
      second,
      await pharmacistForm(second, { nationalId: shared }),
    );
    // Nothing more than "in use": no hint of who or which state.
    expect(blocked).toEqual({ ok: false, error: "national_id_in_use" });

    // Verified: still blocked.
    expect(
      await decide(deps, rev, a.id, {
        decision: "verified",
        reasonCode: "documents_match",
      }),
    ).toEqual({ ok: true, status: "verified" });
    expect(
      await submitVerification(
        deps,
        second,
        await pharmacistForm(second, { nationalId: shared }),
      ),
    ).toEqual({ ok: false, error: "national_id_in_use" });
    // A verified user cannot submit again.
    expect(
      await submitVerification(deps, first, await pharmacistForm(first)),
    ).toEqual({ ok: false, error: "already_verified" });

    // A third account whose first claim is rejected frees the number for its owner and others.
    const { actor: third } = await member("dup-third");
    const other = nationalId();
    const rejected = await submitted(third, { nationalId: other });
    await decide(deps, rev, rejected.id, {
      decision: "rejected",
      reasonCode: "document_unreadable",
    });
    // Same user, same ID, after rejection: allowed.
    const again = await submitVerification(
      deps,
      third,
      await pharmacistForm(third, { nationalId: other }),
    );
    expect(again.ok).toBe(true);
  });

  it("is enforced by the database too", async () => {
    const { actor: first } = await member("dup-db-1");
    const { actor: second } = await member("dup-db-2");
    const a = await submitted(first);
    const row = await rowOf(a.id);
    await expect(
      h.pool.query(
        `insert into verification_submission
           (user_id, credential_type, syndicate_number, national_id_ciphertext,
            national_id_hash, national_id_masked, key_id, consent_version)
         values ($1, 'pharmacist', '1', $2, $3, $4, $5, 'x')`,
        [
          second.userId,
          row!.nationalIdCiphertext,
          row!.nationalIdHash,
          row!.nationalIdMasked,
          row!.keyId,
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "verification_submission_national_id_active_idx",
    });
  });
});

// --- secrecy ----------------------------------------------------------------------

describe("national ID secrecy", () => {
  it("stores no plaintext anywhere in the database and none in logs or user-facing results", async () => {
    const { actor, jar } = await member("secrecy");
    const id = nationalId();
    const { id: submissionId } = await submitted(actor, { nationalId: id });
    const row = await rowOf(submissionId);
    await drainNotices();

    // A full dump of every table in every application schema.
    const tables = await h.pool.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name
         from information_schema.tables
        where table_schema in ('public', 'pgboss', 'drizzle')
          and table_type = 'BASE TABLE'`,
    );
    expect(tables.rows.length).toBeGreaterThan(10);
    let dump = "";
    for (const t of tables.rows) {
      const rows = await h.pool.query(
        `select row_to_json(x)::text as j from "${t.schema}"."${t.name}" x`,
      );
      dump += rows.rows.map((r: { j: string }) => r.j).join("\n");
    }
    expect(dump).toContain(row!.nationalIdHash);
    expect(dump).not.toContain(id);

    // User-facing results: status, export, profile view.
    const status = await getMyVerificationStatus(h.db, actor);
    await upsertOwnProfile(h.db, actor, {
      displayName: "Secrecy Test",
      careerStage: "pharmacist",
      yearsExperience: "1",
      visibility: "members",
    });
    const exported = await exportOwnData(h.db, actor);
    for (const value of [status, exported]) {
      const json = JSON.stringify(value);
      expect(json).not.toContain(id);
      expect(json).not.toContain(row!.nationalIdCiphertext);
      expect(json).not.toContain(row!.nationalIdHash);
      expect(json).not.toContain(row!.keyId);
    }
    expect(exported?.verification).toEqual([
      expect.objectContaining({
        status: "pending",
        nationalIdMasked: `2**********${id.slice(11)}`,
        credentialType: "pharmacist",
        documents: ["national_id_back", "national_id_front", "syndicate_card"],
        decision: null,
      }),
    ]);
    expect(Object.keys(exported!.verification[0]!).sort()).toEqual([
      "cardExpiresOn",
      "consentVersion",
      "credentialType",
      "decidedAt",
      "decision",
      "documents",
      "expiredAt",
      "nationalIdMasked",
      "status",
      "submittedAt",
      "syndicateNumber",
      "university",
    ]);
    void jar;

    // Logs (every line written so far, including reveals below).
    const { actor: rev } = await reviewer("secrecy-rev");
    const revealed = await revealNationalId(
      deps,
      rev,
      submissionId,
      "203.0.113.9",
    );
    expect(revealed).toEqual({ ok: true, nationalId: id });
    const logs = logLines.join("\n");
    expect(logs).not.toContain(id);
    expect(logs).not.toContain(row!.nationalIdCiphertext);
    expect(logs).not.toContain(row!.nationalIdHash);
    expect(logs).not.toContain(encryptionKeyB64);
    expect(logs).not.toContain(hashKeyB64);
    expect(logs).toContain("verification.national_id_revealed");
  });
});

// --- reviewing ----------------------------------------------------------------------

describe("review access", () => {
  it("lists the queue oldest first with masked IDs, for reviewers with MFA only", async () => {
    const { actor: rev } = await reviewer("queue-rev");
    const { actor: noMfa } = await reviewer("queue-nomfa", false);
    const { actor: a } = await member("queue-a");
    const { actor: b } = await member("queue-b");
    const first = await submitted(a);
    const second = await submitted(b);

    const queue = await listQueue(h.db, rev, 1);
    const ids = queue!.items.map((i) => i.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    const item = queue!.items.find((i) => i.id === first.id)!;
    expect(Object.keys(item).sort()).toEqual([
      "credentialType",
      "id",
      "nationalIdMasked",
      "submittedAt",
    ]);
    expect(item.nationalIdMasked).toMatch(/^2\*{10}\d{3}$/);

    expect(await listQueue(h.db, noMfa, 1)).toBeNull();
    expect(await listQueue(h.db, a, 1)).toBeNull();
    expect(await getSubmissionForReview(h.db, noMfa, first.id)).toBeNull();
    expect(await getSubmissionForReview(h.db, b, first.id)).toBeNull();
    expect(
      await decide(deps, noMfa, first.id, {
        decision: "verified",
        reasonCode: "documents_match",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await revealNationalId(deps, noMfa, first.id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    const [doc] = await documentsOf(first.id);
    expect(await viewDocument(uploadDeps, noMfa, doc!.id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await accessLogFor(first.id)).toHaveLength(0);

    const details = await getSubmissionForReview(h.db, rev, first.id);
    expect(details).toMatchObject({
      id: first.id,
      status: "pending",
      credentialType: "pharmacist",
      syndicateNumber: "12345",
      decision: null,
    });
    expect(details?.documents.map((d) => d.kind)).toEqual([
      "national_id_front",
      "national_id_back",
      "syndicate_card",
    ]);
    expect(JSON.stringify(details)).not.toContain(first.form.nationalId);
  });

  it("never lets a reviewer review their own submission", async () => {
    const { actor: rev } = await reviewer("self-rev");
    const own = await submitted(rev);
    expect(
      (await listQueue(h.db, rev, 1))!.items.map((i) => i.id),
    ).not.toContain(own.id);
    expect(await getSubmissionForReview(h.db, rev, own.id)).toBeNull();
    expect(await revealNationalId(deps, rev, own.id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    const [doc] = await documentsOf(own.id);
    expect(await viewDocument(uploadDeps, rev, doc!.id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await decide(deps, rev, own.id, {
        decision: "verified",
        reasonCode: "documents_match",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect((await rowOf(own.id))?.status).toBe("pending");
  });

  it("logs every document view and reveal, and serves documents only through the reviewer path", async () => {
    const { actor: rev } = await reviewer("view-rev");
    const { actor: owner } = await member("view-owner");
    const { actor: stranger } = await member("view-stranger");
    const { id } = await submitted(owner);
    const docs = await documentsOf(id);

    const first = await viewDocument(
      uploadDeps,
      rev,
      docs[0]!.id,
      "203.0.113.7",
    );
    expect(first).toMatchObject({ ok: true, expiresInSeconds: 300 });
    if (!first.ok) return;
    const fetched = await fetch(first.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/jpeg");
    await viewDocument(uploadDeps, rev, docs[0]!.id, null);
    await viewDocument(uploadDeps, rev, docs[1]!.id, "not an ip");
    await revealNationalId(deps, rev, id, "2001:db8::1");

    const log = await accessLogFor(id);
    expect(log).toHaveLength(4);
    expect(log.every((r) => r.actorId === rev.userId)).toBe(true);
    expect(
      log
        .filter((r) => r.action === "view")
        .map((r) => r.documentId)
        .sort(),
    ).toEqual([docs[0]!.id, docs[0]!.id, docs[1]!.id].sort());
    expect(log.map((r) => r.ip).sort()).toEqual(
      ["203.0.113.7", "2001:db8::1", null, null].sort(),
    );
    expect(
      log.find((r) => r.action === "reveal_national_id")?.documentId,
    ).toBeNull();

    // Owner, stranger, unknown and malformed ids: no URL and no log row.
    for (const [actor, docId] of [
      [owner, docs[0]!.id],
      [stranger, docs[0]!.id],
      [rev, "00000000-0000-4000-8000-000000000000"],
      [rev, "../etc/passwd"],
    ] as const)
      expect(await viewDocument(uploadDeps, actor, docId, null)).toEqual({
        ok: false,
        error: "not_found",
      });
    expect(await revealNationalId(deps, owner, id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await accessLogFor(id)).toHaveLength(4);

    // Through the HTTP handler: 303 to the signed URL, never cached, no referrer.
    const request = (headers: Record<string, string> = {}) =>
      new Request(`${APP_URL}/api/verification/documents/${docs[2]!.id}`, {
        headers: {
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": "198.51.100.4",
          ...headers,
        },
      });
    const response = await handleViewDocument(
      uploadDeps,
      rev,
      docs[2]!.id,
      request(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("location")).toMatch(/X-Amz-Signature=/);
    expect(
      (await handleViewDocument(uploadDeps, null, docs[2]!.id, request()))
        .status,
    ).toBe(401);
    expect(
      (
        await handleViewDocument(
          uploadDeps,
          rev,
          docs[2]!.id,
          request({ "sec-fetch-site": "cross-site" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleViewDocument(uploadDeps, owner, docs[2]!.id, request()))
        .status,
    ).toBe(404);
    const after = await accessLogFor(id);
    expect(after).toHaveLength(5);
    expect(
      after.some(
        (r) => r.documentId === docs[2]!.id && r.ip === "198.51.100.4",
      ),
    ).toBe(true);

    // Once decided, documents and the ID are closed even to reviewers.
    await decide(deps, rev, id, { decision: "rejected", reasonCode: "other" });
    expect(await viewDocument(uploadDeps, rev, docs[0]!.id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await revealNationalId(deps, rev, id, null)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await accessLogFor(id)).toHaveLength(5);
  });
});

describe("decisions", () => {
  it("rejects with a localized reason the user sees, by email too", async () => {
    const { actor: rev } = await reviewer("reject-rev");
    const { actor, email } = await member("rejected");
    const { id } = await submitted(actor);
    expect(
      await decide(deps, rev, id, {
        decision: "rejected",
        reasonCode: "details_mismatch",
        note: "  الاسم لا يطابق البطاقة  ",
      }),
    ).toEqual({ ok: true, status: "rejected" });

    const [decision] = await h.db
      .select()
      .from(verificationDecision)
      .where(eq(verificationDecision.submissionId, id));
    expect(decision).toMatchObject({
      reviewerId: rev.userId,
      decision: "rejected",
      reasonCode: "details_mismatch",
      note: "الاسم لا يطابق البطاقة",
    });
    const row = await rowOf(id);
    expect(row?.status).toBe("rejected");
    expect(row?.decidedAt).toEqual(decision?.decidedAt);

    const status = await getMyVerificationStatus(h.db, actor);
    expect(status).toMatchObject({
      state: "rejected",
      canSubmit: true,
      rejectionReason: "details_mismatch",
    });
    // The internal note never reaches the user.
    expect(JSON.stringify(status)).not.toContain("الاسم");
    expect(
      JSON.stringify(await exportOwnVerification(h.db, actor)),
    ).not.toContain("الاسم");

    await drainNotices();
    const mail = mailTo(
      email,
      "لم تتم الموافقة على طلب التوثيق - منصة الصيادلة",
    );
    expect(mail).toBeDefined();
    expect(mail?.text).toContain(
      "السبب: البيانات المكتوبة لا تطابق المستندات.",
    );
    expect(mail?.text).not.toContain("الاسم لا يطابق");
    expect(await getVerificationBadge(h.db, actor.userId)).toBeNull();
  });

  it("decides only pending submissions, with a reason that fits the decision", async () => {
    const { actor: rev } = await reviewer("pending-rev");
    const { actor } = await member("pending-only");
    const { id } = await submitted(actor);
    expect(
      await decide(deps, rev, id, {
        decision: "verified",
        reasonCode: "card_expired",
      }),
    ).toMatchObject({
      ok: false,
      error: "validation",
      fieldErrors: { reasonCode: "invalidChoice" },
    });
    expect(
      await decide(deps, rev, "00000000-0000-4000-8000-000000000000", {
        decision: "verified",
        reasonCode: "documents_match",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await decide(deps, rev, id, {
        decision: "verified",
        reasonCode: "documents_match",
      }),
    ).toEqual({ ok: true, status: "verified" });
    expect(
      await decide(deps, rev, id, {
        decision: "rejected",
        reasonCode: "other",
      }),
    ).toEqual({ ok: false, error: "not_pending" });
    expect((await rowOf(id))?.status).toBe("verified");
  });

  it("lets exactly one of two concurrent reviewers win", async () => {
    const { actor: r1 } = await reviewer("race-1");
    const { actor: r2 } = await reviewer("race-2");
    const { actor } = await member("race-owner");
    const { id } = await submitted(actor);
    const results = await Promise.all([
      decide(deps, r1, id, {
        decision: "verified",
        reasonCode: "documents_match",
      }),
      decide(deps, r2, id, {
        decision: "rejected",
        reasonCode: "document_unreadable",
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "not_pending" },
    ]);
    const decisions = await h.db
      .select()
      .from(verificationDecision)
      .where(eq(verificationDecision.submissionId, id));
    expect(decisions).toHaveLength(1);
    const winner = results.find((r) => r.ok) as { status: string };
    expect((await rowOf(id))?.status).toBe(winner.status);
    expect(decisions[0]?.decision).toBe(winner.status);
  });

  it("approves: the badge appears on the profile, the user is emailed", async () => {
    const { actor: rev } = await reviewer("approve-rev");
    const { actor, email } = await member("approved");
    const { actor: viewer } = await member("approved-viewer");
    await upsertOwnProfile(h.db, actor, {
      displayName: "Badge Test",
      careerStage: "pharmacist",
      yearsExperience: "3",
      visibility: "members",
    });
    const [profileRow] = await h.pool
      .query<{ id: string }>("select id from profile where user_id = $1", [
        actor.userId,
      ])
      .then((r) => r.rows);
    const { id } = await submitted(actor);
    // Submission is not proof.
    expect(await getVerificationBadge(h.db, actor.userId)).toBeNull();
    expect(
      (await getProfileForViewer(h.db, viewer, profileRow!.id))?.verified,
    ).toBe(false);

    await decide(deps, rev, id, {
      decision: "verified",
      reasonCode: "documents_match",
    });
    expect(await getVerificationBadge(h.db, actor.userId)).toBe("verified");
    expect(
      (await getProfileForViewer(h.db, viewer, profileRow!.id))?.verified,
    ).toBe(true);
    expect((await getMyVerificationStatus(h.db, actor))?.state).toBe(
      "verified",
    );
    await drainNotices();
    expect(mailTo(email, "تم توثيق حسابك - منصة الصيادلة")).toBeDefined();
  });
});

describe("expiry job", () => {
  it("expires verified submissions whose card date has passed in Cairo, and only those", async () => {
    const { actor: rev } = await reviewer("expiry-rev");
    const { actor: expiring } = await member("expiring");
    const { actor: lasting } = await member("lasting");
    const { actor: noDate } = await member("no-date");
    const lastDay = addDays(today(), 30);
    const a = await submitted(expiring, { cardExpiresOn: lastDay });
    const b = await submitted(lasting, { cardExpiresOn: addDays(lastDay, 1) });
    const c = await submitted(noDate);
    for (const s of [a, b, c])
      await decide(deps, rev, s.id, {
        decision: "verified",
        reasonCode: "documents_match",
      });

    // The day after the card's last day, 00:30 in Cairo: 21:30 or 22:30 UTC
    // the evening before, depending on DST. Before that, nothing expires.
    const before = new Date(`${lastDay}T20:00:00Z`);
    expect(cairoToday(before)).toBe(lastDay);
    expect(await expireVerifications({ db: h.db, logger }, before)).toBe(0);
    const now = new Date(`${lastDay}T22:30:00Z`);
    expect(cairoToday(now)).toBe(addDays(lastDay, 1));
    const changed = await expireVerifications({ db: h.db, logger }, now);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect((await rowOf(a.id))?.status).toBe("expired");
    expect((await rowOf(a.id))?.expiredAt).toEqual(now);
    expect((await rowOf(b.id))?.status).toBe("verified");
    expect((await rowOf(c.id))?.status).toBe("verified");
    expect(await getVerificationBadge(h.db, expiring.userId)).toBeNull();
    expect(await getMyVerificationStatus(h.db, expiring)).toMatchObject({
      state: "expired",
      canSubmit: true,
    });
    // Idempotent.
    expect(await expireVerifications({ db: h.db, logger }, now)).toBe(0);
    // The job handler runs the same function.
    await HANDLERS["verification.expire"](workerDeps, {}, "job-1");
  });
});

describe("database guarantees", () => {
  it("keeps decisions and access logs append-only, but lets account deletion cascade", async () => {
    const { actor: rev } = await reviewer("append-rev");
    const { actor } = await member("append-owner");
    const { id } = await submitted(actor);
    const [doc] = await documentsOf(id);
    await viewDocument(uploadDeps, rev, doc!.id, null);
    await decide(deps, rev, id, {
      decision: "verified",
      reasonCode: "documents_match",
    });

    for (const statement of [
      "update verification_decision set reason_code = 'other', decision = 'rejected' where submission_id = $1",
      "delete from verification_decision where submission_id = $1",
      "update document_access_log set ip = '10.0.0.1' where submission_id = $1",
      "delete from document_access_log where submission_id = $1",
      "update document_access_log set actor_id = null where submission_id = $1",
    ])
      await expect(h.pool.query(statement, [id])).rejects.toThrow(
        /append-only/,
      );
    await expect(h.pool.query("truncate document_access_log")).rejects.toThrow(
      /append-only/,
    );
    // Forbidden status transitions and changes to the stored ID.
    await expect(
      h.pool.query(
        "update verification_submission set status = 'pending', decided_at = null where id = $1",
        [id],
      ),
    ).rejects.toThrow(/transition verified -> pending/);
    await expect(
      h.pool.query(
        "update verification_submission set national_id_masked = '2**********000' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/immutable/);

    // Deleting the reviewer keeps the decision and log rows, without the person.
    await h.db.delete(user).where(eq(user.id, rev.userId));
    const [kept] = await h.db
      .select()
      .from(verificationDecision)
      .where(eq(verificationDecision.submissionId, id));
    expect(kept).toMatchObject({ reviewerId: null, decision: "verified" });
    expect((await accessLogFor(id)).map((r) => r.actorId)).toEqual([null]);

    // Deleting the owner removes the submission, documents, decision, log and uploads.
    const uploadIds = (await documentsOf(id)).map((d) => d.uploadId);
    await h.db.delete(user).where(eq(user.id, actor.userId));
    expect(await rowOf(id)).toBeUndefined();
    expect(await documentsOf(id)).toHaveLength(0);
    expect(await accessLogFor(id)).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(verificationDecision)
        .where(eq(verificationDecision.submissionId, id)),
    ).toHaveLength(0);
    for (const uploadId of uploadIds)
      expect(
        await h.db
          .select()
          .from(upload)
          .where(and(eq(upload.id, uploadId))),
      ).toHaveLength(0);
  });

  it("refuses to delete an upload that a submission still uses", async () => {
    const { actor } = await member("upload-fk");
    const { id } = await submitted(actor);
    const [doc] = await documentsOf(id);
    await expect(
      h.pool.query("delete from upload where id = $1", [doc!.uploadId]),
    ).rejects.toMatchObject({
      constraint: "verification_document_upload_id_upload_id_fk",
    });
  });
});
