import { Writable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { listRoles } from "@/modules/identity/roles-service";
import { user } from "@/modules/identity/schema";
import { LIMITS } from "@/modules/organizations/constants";
import { sendInvitationNotice } from "@/modules/organizations/jobs";
import {
  organization,
  organizationAudit,
  organizationInvitation,
  organizationMember,
} from "@/modules/organizations/schema";
import {
  changeMemberRole,
  createOrganization,
  exportOwnOrganizations,
  getOrganizationForMember,
  inviteMember,
  leaveOrganization,
  listMembers,
  listMyInvitations,
  listMyOrganizations,
  listPendingInvitations,
  type OrganizationDeps,
  removeMember,
  respondToInvitation,
  revokeInvitation,
  updateOrganization,
} from "@/modules/organizations/service";
import { exportOwnData } from "@/modules/profiles/service";
import type { EmailMessage } from "@/shared/email/sender";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import { HANDLERS, type WorkerDeps } from "../../worker/handlers";
import { APP_URL, type Harness, startHarness } from "./helpers/auth-harness";

// Organizations and membership (ADR-005) against real PostgreSQL with
// pg-boss. Members are real Better Auth accounts; each Actor comes from a
// real session. Every protected operation is also tried from another
// organization and by a non-member.

const PASSWORD = "correct horse battery staple";
let h: Harness;
let boss: PgBoss;
let deps: OrganizationDeps;
let workerDeps: WorkerDeps;
const outbox: EmailMessage[] = [];
const logLines: string[] = [];
const logger = createLogger(
  { level: "debug" },
  new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  }),
);
let counter = 0;

type Member = { email: string; actor: Actor };

async function person(label: string): Promise<Member> {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const signedIn = await h.signIn(email, PASSWORD);
  const current = await h.call("/get-session", { jar: signedIn.jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  return {
    email,
    actor: actorFromSession(session, await listRoles(h.db, session.user.id)),
  };
}

const orgForm = {
  kind: "pharmacy",
  name: "صيدلية النور",
  governorateId: "1",
  addressLine: "١٢ شارع التحرير",
};

async function newOrganization(owner: Member, form = orgForm) {
  const result = await createOrganization(deps, owner.actor, form);
  if (!result.ok) throw new Error(`create: ${result.error}`);
  return result.organizationId;
}

async function invite(
  by: Member,
  organizationId: string,
  email: string,
  role: string,
) {
  return inviteMember(deps, by.actor, organizationId, { email, role });
}

/** Invites and accepts; returns the new membership id. */
async function join(
  owner: Member,
  organizationId: string,
  who: Member,
  role: string,
) {
  const sent = await invite(owner, organizationId, who.email, role);
  if (!sent.ok) throw new Error(`invite: ${sent.error}`);
  const accepted = await respondToInvitation(
    deps,
    who.actor,
    sent.invitationId,
    "accept",
  );
  if (!accepted.ok) throw new Error(`accept: ${accepted.error}`);
  return memberIdOf(organizationId, who);
}

async function memberIdOf(organizationId: string, who: Member) {
  const [row] = await h.db
    .select({ id: organizationMember.id })
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.organizationId, organizationId),
        eq(organizationMember.userId, who.actor.userId),
      ),
    );
  if (!row) throw new Error("no membership");
  return row.id;
}

async function auditOf(organizationId: string) {
  return h.db
    .select({
      action: organizationAudit.action,
      actorId: organizationAudit.actorId,
      role: organizationAudit.role,
      previousRole: organizationAudit.previousRole,
    })
    .from(organizationAudit)
    .where(eq(organizationAudit.organizationId, organizationId))
    .orderBy(organizationAudit.createdAt);
}

/** Runs queued invitation emails through the worker's handler. */
async function drainInvitationEmails() {
  for (;;) {
    const jobs = await boss.fetch<{ invitationId: string }>(
      "organization.notify",
      { batchSize: 20 },
    );
    if (jobs.length === 0) return;
    for (const job of jobs) {
      await HANDLERS["organization.notify"](workerDeps, job.data, job.id);
      await boss.complete("organization.notify", job.id);
    }
  }
}

beforeAll(async () => {
  h = await startHarness();
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  deps = { db: h.db, boss };
  workerDeps = {
    db: h.db,
    boss,
    store: { s3: {} as never, bucket: "unused" },
    scan: async () => ({ infected: false }),
    emailSender: { send: async (m) => void outbox.push(m) },
    appUrl: APP_URL,
    logger,
  };
}, 300_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

describe("creating and reading", () => {
  it("makes the creator the owner and lists the organization", async () => {
    const owner = await person("owner");
    expect(await listMyOrganizations(h.db, owner.actor)).toEqual([]);
    const id = await newOrganization(owner);

    expect(await listMyOrganizations(h.db, owner.actor)).toEqual([
      { id, name: "صيدلية النور", kind: "pharmacy", role: "owner" },
    ]);
    const view = await getOrganizationForMember(h.db, owner.actor, id);
    expect(view).toMatchObject({
      id,
      name: "صيدلية النور",
      kind: "pharmacy",
      governorateId: 1,
      governorate: { code: "EG-C", nameAr: "القاهرة", nameEn: "Cairo" },
      addressLine: "١٢ شارع التحرير",
      myRole: "owner",
    });
    expect(await auditOf(id)).toEqual([
      {
        action: "organization.created",
        actorId: owner.actor.userId,
        role: "owner",
        previousRole: null,
      },
    ]);
  });

  it("validates input and the governorate against the reference table", async () => {
    const owner = await person("validate");
    expect(
      await createOrganization(deps, owner.actor, {
        ...orgForm,
        name: "",
        kind: "clinic",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { name: "required", kind: "invalidChoice" },
    });
    expect(
      await createOrganization(deps, owner.actor, {
        ...orgForm,
        governorateId: "99",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { governorateId: "invalidChoice" },
    });
  });

  it("limits organizations per creator, also under concurrent requests", async () => {
    const owner = await person("many");
    const results = await Promise.all(
      Array.from({ length: LIMITS.createdPerUser + 3 }, (_, i) =>
        createOrganization(deps, owner.actor, {
          ...orgForm,
          name: `صيدلية رقم ${i + 1}`,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(LIMITS.createdPerUser);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 3 }, () => ({
        ok: false,
        error: "limitReached",
      })),
    );
  });

  it("hides an organization from non-members and malformed ids alike", async () => {
    const owner = await person("hide-owner");
    const stranger = await person("stranger");
    const id = await newOrganization(owner);
    for (const target of [id, "not-a-uuid", crypto.randomUUID()]) {
      expect(
        await getOrganizationForMember(h.db, stranger.actor, target),
      ).toBeNull();
      expect(await listMembers(h.db, stranger.actor, target)).toEqual([]);
      expect(
        await listPendingInvitations(h.db, stranger.actor, target),
      ).toEqual([]);
    }
    expect(
      await updateOrganization(deps, stranger.actor, id, {
        ...orgForm,
        name: "سرقة",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await leaveOrganization(deps, stranger.actor, id)).toEqual({
      ok: false,
      error: "notFound",
    });
  });

  it("refuses an unverified email", async () => {
    const owner = await person("unverified");
    const actor = { ...owner.actor, emailVerified: false };
    expect(await createOrganization(deps, actor, orgForm)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listMyOrganizations(h.db, actor)).toEqual([]);
  });
});

describe("editing", () => {
  it("lets owners edit, not recruiters", async () => {
    const owner = await person("edit-owner");
    const recruiter = await person("edit-recruiter");
    const id = await newOrganization(owner);
    await join(owner, id, recruiter, "recruiter");

    expect(
      await updateOrganization(deps, owner.actor, id, {
        kind: "chain",
        name: "صيدليات النور",
        governorateId: "2",
        addressLine: "",
      }),
    ).toEqual({ ok: true });
    expect(
      await getOrganizationForMember(h.db, recruiter.actor, id),
    ).toMatchObject({
      kind: "chain",
      name: "صيدليات النور",
      governorateId: 2,
      addressLine: null,
      myRole: "recruiter",
    });
    expect(
      await updateOrganization(deps, recruiter.actor, id, orgForm),
    ).toEqual({ ok: false, error: "forbidden" });
    // A recruiter sees no member list or invitations.
    expect(await listMembers(h.db, recruiter.actor, id)).toEqual([]);
    expect(await listPendingInvitations(h.db, recruiter.actor, id)).toEqual([]);
  });

  it("cannot edit another organization with its own role", async () => {
    const a = await person("org-a");
    const b = await person("org-b");
    const orgA = await newOrganization(a);
    const orgB = await newOrganization(b, {
      ...orgForm,
      name: "صيدلية الشفاء",
    });
    expect(
      await updateOrganization(deps, a.actor, orgB, {
        ...orgForm,
        name: "مخترقة",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    const [row] = await h.db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, orgB));
    expect(row?.name).toBe("صيدلية الشفاء");
    expect(orgA).not.toBe(orgB);
  });
});

describe("invitations", () => {
  it("binds the invitation to the address: only that verified user sees and accepts it", async () => {
    const owner = await person("inv-owner");
    const invitee = await person("invitee");
    const other = await person("other");
    const id = await newOrganization(owner);

    const sent = await invite(
      owner,
      id,
      `  ${invitee.email.toUpperCase()} `,
      "recruiter",
    );
    expect(sent).toMatchObject({ ok: true });
    if (!sent.ok) return;

    expect(await listMyInvitations(h.db, other.actor)).toEqual([]);
    expect(
      await respondToInvitation(deps, other.actor, sent.invitationId, "accept"),
    ).toEqual({ ok: false, error: "notFound" });

    const mine = await listMyInvitations(h.db, invitee.actor);
    expect(mine).toEqual([
      expect.objectContaining({
        id: sent.invitationId,
        organizationName: "صيدلية النور",
        kind: "pharmacy",
        role: "recruiter",
      }),
    ]);
    expect(await listPendingInvitations(h.db, owner.actor, id)).toEqual([
      expect.objectContaining({
        id: sent.invitationId,
        email: invitee.email,
        role: "recruiter",
      }),
    ]);

    expect(
      await respondToInvitation(
        deps,
        invitee.actor,
        sent.invitationId,
        "accept",
      ),
    ).toEqual({ ok: true, organizationId: id });
    expect(await listMyOrganizations(h.db, invitee.actor)).toEqual([
      { id, name: "صيدلية النور", kind: "pharmacy", role: "recruiter" },
    ]);
    // Answered once: a second answer finds it closed.
    expect(
      await respondToInvitation(
        deps,
        invitee.actor,
        sent.invitationId,
        "decline",
      ),
    ).toEqual({ ok: false, error: "invitationClosed" });
    expect(await listMyInvitations(h.db, invitee.actor)).toEqual([]);

    const members = await listMembers(h.db, owner.actor, id);
    expect(members.map((m) => [m.email, m.role, m.isSelf])).toEqual([
      [owner.email, "owner", true],
      [invitee.email, "recruiter", false],
    ]);
    expect((await auditOf(id)).map((a) => a.action)).toEqual([
      "organization.created",
      "invitation.created",
      "invitation.accepted",
    ]);
  });

  it("answers the same whether or not the address has an account, and emails it", async () => {
    const owner = await person("mail-owner");
    const id = await newOrganization(owner);
    const nobody = `nobody-${Date.now()}@example.test`;
    const sent = await invite(owner, id, nobody, "owner");
    expect(sent).toMatchObject({ ok: true });

    outbox.length = 0;
    await drainInvitationEmails();
    expect(outbox).toHaveLength(1);
    const message = outbox[0];
    expect(message?.to).toBe(nobody);
    expect(message?.subject).toContain("صيدلية النور");
    expect(message?.text).toContain("مالك");
    expect(message?.text).toContain(`${APP_URL}/organizations`);
    expect(message?.language).toBe("ar");
    // Logs carry ids only.
    const logs = logLines.join("\n");
    expect(logs).not.toContain(nobody);
    expect(logs).not.toContain("صيدلية النور");
  });

  it("does not email a revoked invitation and renders English for English inviters", async () => {
    const owner = await person("revoke-owner");
    const id = await newOrganization(owner);
    const english = await inviteMember(
      deps,
      owner.actor,
      id,
      { email: `en-${counter}@example.test`, role: "recruiter" },
      "en",
    );
    const revoked = await invite(
      owner,
      id,
      `gone-${counter}@example.test`,
      "owner",
    );
    if (!english.ok || !revoked.ok) throw new Error("invite failed");
    expect(
      await revokeInvitation(deps, owner.actor, id, revoked.invitationId),
    ).toEqual({ ok: true });

    outbox.length = 0;
    await drainInvitationEmails();
    expect(outbox.map((m) => [m.to, m.language])).toEqual([
      [`en-${counter}@example.test`, "en"],
    ]);
    expect(outbox[0]?.text).toContain(`${APP_URL}/en/organizations`);
    expect(outbox[0]?.text).toContain("Recruiter");
  });

  it("refuses duplicates, existing members, the removed admin role and non-owners", async () => {
    const owner = await person("dup-owner");
    const recruiter = await person("dup-recruiter");
    const id = await newOrganization(owner);
    await join(owner, id, recruiter, "recruiter");

    const target = `dup-${counter}@example.test`;
    expect(await invite(owner, id, target, "recruiter")).toMatchObject({
      ok: true,
    });
    expect(await invite(owner, id, target, "owner")).toEqual({
      ok: false,
      error: "alreadyInvited",
    });
    expect(await invite(owner, id, recruiter.email, "recruiter")).toEqual({
      ok: false,
      error: "alreadyMember",
    });
    expect(await invite(owner, id, `x-admin@example.test`, "admin")).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { role: "invalidChoice" },
    });
    for (const role of ["owner", "recruiter"])
      expect(
        await invite(recruiter, id, `x-${role}@example.test`, role),
      ).toEqual({ ok: false, error: "forbidden" });
  });

  it("lets only owners revoke invitations, and no one from outside", async () => {
    const owner = await person("rv-owner");
    const recruiter = await person("rv-recruiter");
    const outsider = await person("rv-outsider");
    const id = await newOrganization(owner);
    await newOrganization(outsider, { ...orgForm, name: "صيدلية أخرى" });
    await join(owner, id, recruiter, "recruiter");
    const pending = await invite(
      owner,
      id,
      `r-${counter}@example.test`,
      "recruiter",
    );
    if (!pending.ok) throw new Error("invite failed");

    expect(
      await revokeInvitation(deps, recruiter.actor, id, pending.invitationId),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await revokeInvitation(deps, outsider.actor, id, pending.invitationId),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await revokeInvitation(deps, owner.actor, id, pending.invitationId),
    ).toEqual({ ok: true });
    expect(
      await revokeInvitation(deps, owner.actor, id, pending.invitationId),
    ).toEqual({ ok: false, error: "invitationClosed" });
  });

  it("expires invitations after 7 days and lets the address be invited again", async () => {
    const owner = await person("exp-owner");
    const invitee = await person("exp-invitee");
    const id = await newOrganization(owner);
    const start = new Date();
    const later = new Date(
      start.getTime() + (LIMITS.invitationDays * 24 + 1) * 60 * 60 * 1000,
    );
    const first = await inviteMember(
      { ...deps, now: () => start },
      owner.actor,
      id,
      { email: invitee.email, role: "recruiter" },
    );
    if (!first.ok) throw new Error("invite failed");

    expect(await listMyInvitations(h.db, invitee.actor, later)).toEqual([]);
    expect(
      await respondToInvitation(
        { ...deps, now: () => later },
        invitee.actor,
        first.invitationId,
        "accept",
      ),
    ).toEqual({ ok: false, error: "invitationClosed" });
    const [closed] = await h.db
      .select({ status: organizationInvitation.status })
      .from(organizationInvitation)
      .where(eq(organizationInvitation.id, first.invitationId));
    expect(closed?.status).toBe("expired");

    // The worker does not email an expired invitation.
    expect(
      await sendInvitationNotice(workerDeps, first.invitationId, later),
    ).toBe("skipped");

    const second = await inviteMember(
      { ...deps, now: () => later },
      owner.actor,
      id,
      { email: invitee.email, role: "owner" },
    );
    expect(second).toMatchObject({ ok: true });
  });

  it("enforces the pending-invitation limit per organization", async () => {
    const owner = await person("limit-owner");
    const id = await newOrganization(owner);
    const results = [];
    for (let i = 0; i < LIMITS.pendingInvitations + 1; i++)
      results.push(
        await invite(
          owner,
          id,
          `limit-${counter}-${i}@example.test`,
          "recruiter",
        ),
      );
    expect(results.slice(0, -1).every((r) => r.ok)).toBe(true);
    expect(results.at(-1)).toEqual({ ok: false, error: "limitReached" });
  });

  it("enforces the daily invitation limit even after revoking", async () => {
    const owner = await person("daily-owner");
    const id = await newOrganization(owner);
    let last;
    for (let i = 0; i < LIMITS.invitationsPerDay + 1; i++) {
      last = await invite(
        owner,
        id,
        `d-${counter}-${i}@example.test`,
        "recruiter",
      );
      if (last.ok)
        await revokeInvitation(deps, owner.actor, id, last.invitationId);
    }
    expect(last).toEqual({ ok: false, error: "limitReached" });
  });

  it("declining leaves no membership", async () => {
    const owner = await person("dec-owner");
    const invitee = await person("dec-invitee");
    const id = await newOrganization(owner);
    const sent = await invite(owner, id, invitee.email, "recruiter");
    if (!sent.ok) throw new Error("invite failed");
    expect(
      await respondToInvitation(
        deps,
        invitee.actor,
        sent.invitationId,
        "decline",
      ),
    ).toEqual({ ok: true, organizationId: id });
    expect(await getOrganizationForMember(h.db, invitee.actor, id)).toBeNull();
    expect(
      await respondToInvitation(
        deps,
        invitee.actor,
        sent.invitationId,
        "maybe",
      ),
    ).toEqual({ ok: false, error: "validation" });
  });
});

describe("roles and removal", () => {
  it("keeps at least one owner, also when two owners demote each other at once", async () => {
    const a = await person("owner-a");
    const b = await person("owner-b");
    const id = await newOrganization(a);
    const bId = await join(a, id, b, "owner");
    const aId = await memberIdOf(id, a);

    // Hold the organization and both member rows, so both requests are in
    // flight before either can proceed; then let them go together.
    const blocker = await h.pool.connect();
    await blocker.query("begin");
    await blocker.query("select 1 from organization where id = $1 for update", [
      id,
    ]);
    await blocker.query(
      "select 1 from organization_member where organization_id = $1 for update",
      [id],
    );
    const racing = Promise.all([
      changeMemberRole(deps, a.actor, id, bId, "recruiter"),
      changeMemberRole(deps, b.actor, id, aId, "recruiter"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blocker.query("commit");
    blocker.release();
    const results = await racing;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "forbidden" },
    ]);
    const members = await listMembers(
      h.db,
      results[0]?.ok ? a.actor : b.actor,
      id,
    );
    expect(members.filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("refuses the last owner leaving, and nobody changes their own role", async () => {
    const owner = await person("last-owner");
    const id = await newOrganization(owner);
    const own = await memberIdOf(id, owner);
    expect(await leaveOrganization(deps, owner.actor, id)).toEqual({
      ok: false,
      error: "lastOwner",
    });
    expect(
      await changeMemberRole(deps, owner.actor, id, own, "recruiter"),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await removeMember(deps, owner.actor, id, own)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("lets an owner hand over and then leave", async () => {
    const owner = await person("handover");
    const next = await person("next-owner");
    const id = await newOrganization(owner);
    const nextId = await join(owner, id, next, "recruiter");
    expect(
      await changeMemberRole(deps, owner.actor, id, nextId, "owner"),
    ).toEqual({ ok: true });
    expect(await leaveOrganization(deps, owner.actor, id)).toEqual({
      ok: true,
    });
    expect(await getOrganizationForMember(h.db, owner.actor, id)).toBeNull();
    expect(
      (await auditOf(id)).filter((a) => a.action.startsWith("member.")),
    ).toEqual([
      {
        action: "member.role_changed",
        actorId: owner.actor.userId,
        role: "owner",
        previousRole: "recruiter",
      },
      {
        action: "member.left",
        actorId: owner.actor.userId,
        role: null,
        previousRole: "owner",
      },
    ]);
  });

  it("applies the removal matrix and blocks cross-organization ids", async () => {
    const owner = await person("rm-owner");
    const coOwner = await person("rm-co-owner");
    const recruiter = await person("rm-recruiter");
    const recruiter2 = await person("rm-recruiter2");
    const otherOwner = await person("rm-other");
    const id = await newOrganization(owner);
    const other = await newOrganization(otherOwner, {
      ...orgForm,
      name: "صيدلية بعيدة",
    });
    const coOwnerId = await join(owner, id, coOwner, "owner");
    const recruiterId = await join(owner, id, recruiter, "recruiter");
    const recruiter2Id = await join(owner, id, recruiter2, "recruiter");
    const ownerId = await memberIdOf(id, owner);

    // A recruiter removes and re-roles nobody.
    for (const target of [recruiter2Id, ownerId])
      expect(await removeMember(deps, recruiter.actor, id, target)).toEqual({
        ok: false,
        error: "forbidden",
      });
    expect(
      await changeMemberRole(deps, recruiter.actor, id, recruiter2Id, "owner"),
    ).toEqual({ ok: false, error: "forbidden" });
    // Another organization's owner, with this organization's member id.
    expect(await removeMember(deps, otherOwner.actor, id, recruiterId)).toEqual(
      { ok: false, error: "notFound" },
    );
    expect(
      await removeMember(deps, otherOwner.actor, other, recruiterId),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await changeMemberRole(deps, otherOwner.actor, other, coOwnerId, "owner"),
    ).toEqual({ ok: false, error: "notFound" });
    // The removed admin role cannot be granted.
    expect(
      await changeMemberRole(deps, owner.actor, id, recruiterId, "admin"),
    ).toEqual({ ok: false, error: "validation" });

    expect(await removeMember(deps, owner.actor, id, recruiterId)).toEqual({
      ok: true,
    });
    expect(
      await getOrganizationForMember(h.db, recruiter.actor, id),
    ).toBeNull();
    // An owner removes another owner while one remains.
    expect(await removeMember(deps, owner.actor, id, coOwnerId)).toEqual({
      ok: true,
    });
    expect(
      (await listMembers(h.db, owner.actor, id)).map((m) => m.role),
    ).toEqual(["owner", "recruiter"]);
  });

  it("applies a role change on the next request (no cached roles)", async () => {
    const owner = await person("cache-owner");
    const second = await person("cache-second");
    const id = await newOrganization(owner);
    const secondId = await join(owner, id, second, "owner");
    expect((await listMembers(h.db, second.actor, id)).length).toBe(2);
    await changeMemberRole(deps, owner.actor, id, secondId, "recruiter");
    expect(await listMembers(h.db, second.actor, id)).toEqual([]);
    expect(await updateOrganization(deps, second.actor, id, orgForm)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("audit trail and data rights", () => {
  it("refuses to change or delete audit rows, but follows account deletion", async () => {
    const owner = await person("audit-owner");
    const id = await newOrganization(owner);
    await expect(
      h.pool.query(
        "update organization_audit set action = 'member.left' where organization_id = $1",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.pool.query(
        "delete from organization_audit where organization_id = $1",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(h.pool.query("truncate organization_audit")).rejects.toThrow(
      /append-only/,
    );

    // Deleting the account nulls the actor (cascade) and removes the
    // membership; the organization and its history stay.
    const other = await person("audit-co-owner");
    const otherId = await join(owner, id, other, "owner");
    await changeMemberRole(
      deps,
      other.actor,
      id,
      await memberIdOf(id, owner),
      "recruiter",
    );
    await h.db.delete(user).where(eq(user.id, other.actor.userId));
    const rows = await auditOf(id);
    expect(rows.some((r) => r.actorId === other.actor.userId)).toBe(false);
    expect(rows.some((r) => r.actorId === null)).toBe(true);
    expect(otherId).toBeTruthy();
  });

  it("exports own memberships and received invitations, nothing about others", async () => {
    const owner = await person("export-owner");
    const member = await person("export-member");
    const id = await newOrganization(owner);
    await join(owner, id, member, "recruiter");
    await invite(owner, id, `third-${counter}@example.test`, "owner");

    const own = await exportOwnOrganizations(h.db, member.actor);
    expect(own.memberships).toEqual([
      expect.objectContaining({
        organizationName: "صيدلية النور",
        kind: "pharmacy",
        role: "recruiter",
        governorate: { code: "EG-C", nameAr: "القاهرة", nameEn: "Cairo" },
      }),
    ]);
    expect(own.invitationsReceived).toEqual([
      expect.objectContaining({ role: "recruiter", status: "accepted" }),
    ]);
    const all = await exportOwnData(h.db, member.actor);
    const text = JSON.stringify(all);
    expect(all?.organizations.memberships).toHaveLength(1);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain("third-");
  });
});
