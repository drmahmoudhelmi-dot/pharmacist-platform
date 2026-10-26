import "server-only";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  getEmailsOfUsers,
  getNotificationAddress,
} from "@/modules/identity/contact";
import type { Actor } from "@/modules/identity/policy";
import { listGovernorates } from "@/modules/profiles/governorates";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import {
  type AuditAction,
  type EmailLocale,
  isMemberRole,
  isOrganizationKind,
  LIMITS,
  type MemberRole,
  type OrganizationKind,
} from "./constants";
import { can } from "./policy";
import {
  organization,
  organizationAudit,
  organizationInvitation,
  organizationMember,
} from "./schema";
import {
  type FieldErrors,
  type InvitationField,
  isUuid,
  type OrganizationField,
  parseInvitation,
  parseOrganization,
  type RawForm,
} from "./validation";

// All database access for organizations (ADR-005). Every function takes the
// Actor built from the session. The actor's role is loaded here from
// organization_member with the session's user id and the organization id from
// the URL, so another organization's id finds no membership and answers
// `notFound`, exactly like a missing one. Changes to members run in a
// transaction that locks the organization row first, which serializes them per
// organization (the "at least one owner" rule and the limits cannot be raced),
// and write an organization_audit row in the same transaction.

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type OrganizationDeps = {
  db: Db;
  boss: PgBoss;
  now?: () => Date;
};

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

export type OrganizationError =
  | "forbidden"
  | "validation"
  | "notFound"
  | "limitReached"
  | "lastOwner"
  | "alreadyMember"
  | "alreadyInvited"
  | "invitationClosed";

export type WriteResult<K extends string = never, T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: OrganizationError; fieldErrors?: FieldErrors<K> };

const fail = (error: OrganizationError) => ({ ok: false as const, error });

export type GovernorateRef = { code: string; nameAr: string; nameEn: string };

export type OrganizationSummary = {
  id: string;
  name: string;
  kind: OrganizationKind;
  role: MemberRole;
};

export type OrganizationView = {
  id: string;
  name: string;
  kind: OrganizationKind;
  governorateId: number;
  governorate: GovernorateRef | null;
  addressLine: string | null;
  myRole: MemberRole;
};

export type MemberView = {
  id: string;
  role: MemberRole;
  /** Null if the account no longer exists (row about to cascade). */
  email: string | null;
  isSelf: boolean;
  joinedAt: string;
};

export type InvitationView = {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
};

export type MyInvitation = {
  id: string;
  organizationName: string;
  kind: OrganizationKind;
  role: MemberRole;
  expiresAt: string;
};

const ROLE_ORDER = sql`case ${organizationMember.role} when 'owner' then 0 else 1 end`;

const narrowRole = (value: string): MemberRole =>
  // The CHECK constraint guarantees it; narrow defensively to the least role.
  isMemberRole(value) ? value : "recruiter";

const narrowKind = (value: string): OrganizationKind =>
  isOrganizationKind(value) ? value : "pharmacy";

async function audit(
  tx: Tx,
  entry: {
    organizationId: string;
    actorId: string;
    action: AuditAction;
    memberId?: string;
    invitationId?: string;
    role?: MemberRole;
    previousRole?: MemberRole;
  },
) {
  await tx.insert(organizationAudit).values(entry);
}

/** Locks the organization row; false when it does not exist. */
async function lockOrganization(tx: Tx, organizationId: string) {
  const rows = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .for("update");
  return rows.length === 1;
}

/** The caller's membership in an organization, or null. */
async function membershipOf(
  db: Db | Tx,
  organizationId: string,
  userId: string,
) {
  const [row] = await db
    .select({ id: organizationMember.id, role: organizationMember.role })
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.organizationId, organizationId),
        eq(organizationMember.userId, userId),
      ),
    )
    .limit(1);
  return row ? { id: row.id, role: narrowRole(row.role) } : null;
}

async function countOwners(tx: Tx, organizationId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.organizationId, organizationId),
        eq(organizationMember.role, "owner"),
      ),
    );
  return row?.n ?? 0;
}

async function governorateExists(db: Db, id: number) {
  return (await listGovernorates(db)).some((g) => g.id === id);
}

// ---------------------------------------------------------------------------
// Reading

/** The organizations the caller belongs to, with their role. */
export async function listMyOrganizations(
  db: Db,
  actor: Actor,
): Promise<OrganizationSummary[]> {
  if (!actor.emailVerified) return [];
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      kind: organization.kind,
      role: organizationMember.role,
    })
    .from(organizationMember)
    .innerJoin(
      organization,
      eq(organization.id, organizationMember.organizationId),
    )
    .where(eq(organizationMember.userId, actor.userId))
    .orderBy(asc(organization.name), asc(organization.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: narrowKind(r.kind),
    role: narrowRole(r.role),
  }));
}

/**
 * One organization as its member sees it. Null when the id is malformed, the
 * organization does not exist or the caller is not a member: callers answer
 * all of these with the same 404.
 */
export async function getOrganizationForMember(
  db: Db,
  actor: Actor,
  organizationId: unknown,
): Promise<OrganizationView | null> {
  if (!isUuid(organizationId)) return null;
  const membership = await membershipOf(db, organizationId, actor.userId);
  if (!can(actor, "organization.read", { actorRole: membership?.role }))
    return null;
  const [row] = await db
    .select({
      id: organization.id,
      name: organization.name,
      kind: organization.kind,
      governorateId: organization.governorateId,
      addressLine: organization.addressLine,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (!row || !membership) return null;
  const g = (await listGovernorates(db)).find(
    (x) => x.id === row.governorateId,
  );
  return {
    id: row.id,
    name: row.name,
    kind: narrowKind(row.kind),
    governorateId: row.governorateId,
    governorate: g
      ? { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn }
      : null,
    addressLine: row.addressLine,
    myRole: membership.role,
  };
}

/** Members with their emails, for owners; empty for anyone else. */
export async function listMembers(
  db: Db,
  actor: Actor,
  organizationId: unknown,
): Promise<MemberView[]> {
  if (!isUuid(organizationId)) return [];
  const membership = await membershipOf(db, organizationId, actor.userId);
  if (!can(actor, "members.read", { actorRole: membership?.role })) return [];
  const rows = await db
    .select({
      id: organizationMember.id,
      userId: organizationMember.userId,
      role: organizationMember.role,
      createdAt: organizationMember.createdAt,
    })
    .from(organizationMember)
    .where(eq(organizationMember.organizationId, organizationId))
    .orderBy(ROLE_ORDER, asc(organizationMember.createdAt));
  const emails = await getEmailsOfUsers(
    db,
    rows.map((r) => r.userId),
  );
  return rows.map((r) => ({
    id: r.id,
    role: narrowRole(r.role),
    email: emails.get(r.userId) ?? null,
    isSelf: r.userId === actor.userId,
    joinedAt: r.createdAt.toISOString(),
  }));
}

/** Pending, unexpired invitations, for owners. */
export async function listPendingInvitations(
  db: Db,
  actor: Actor,
  organizationId: unknown,
  now: Date = new Date(),
): Promise<InvitationView[]> {
  if (!isUuid(organizationId)) return [];
  const membership = await membershipOf(db, organizationId, actor.userId);
  if (!can(actor, "invitations.read", { actorRole: membership?.role }))
    return [];
  const rows = await db
    .select({
      id: organizationInvitation.id,
      email: organizationInvitation.email,
      role: organizationInvitation.role,
      expiresAt: organizationInvitation.expiresAt,
    })
    .from(organizationInvitation)
    .where(
      and(
        eq(organizationInvitation.organizationId, organizationId),
        eq(organizationInvitation.status, "pending"),
        gt(organizationInvitation.expiresAt, now),
      ),
    )
    .orderBy(asc(organizationInvitation.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: narrowRole(r.role),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * Pending, unexpired invitations addressed to the caller's verified email.
 * Nothing for an unverified address: the invitation is bound to the address.
 */
export async function listMyInvitations(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<MyInvitation[]> {
  if (!actor.emailVerified) return [];
  const email = await getNotificationAddress(db, actor.userId);
  if (!email) return [];
  const rows = await db
    .select({
      id: organizationInvitation.id,
      organizationName: organization.name,
      kind: organization.kind,
      role: organizationInvitation.role,
      expiresAt: organizationInvitation.expiresAt,
    })
    .from(organizationInvitation)
    .innerJoin(
      organization,
      eq(organization.id, organizationInvitation.organizationId),
    )
    .where(
      and(
        eq(organizationInvitation.email, email),
        eq(organizationInvitation.status, "pending"),
        gt(organizationInvitation.expiresAt, now),
      ),
    )
    .orderBy(asc(organizationInvitation.createdAt));
  return rows.map((r) => ({
    id: r.id,
    organizationName: r.organizationName,
    kind: narrowKind(r.kind),
    role: narrowRole(r.role),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Creating and editing

/**
 * Creates an organization with the caller as its first owner. At most
 * `LIMITS.createdPerUser` per user, serialized per user so the limit holds
 * under concurrent requests.
 */
export async function createOrganization(
  deps: OrganizationDeps,
  actor: Actor,
  raw: RawForm,
): Promise<WriteResult<OrganizationField, { organizationId: string }>> {
  if (!can(actor, "organization.create")) return fail("forbidden");
  const parsed = parseOrganization(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  if (!(await governorateExists(deps.db, parsed.data.governorateId)))
    return {
      ok: false,
      error: "validation",
      fieldErrors: { governorateId: "invalidChoice" },
    };

  return deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-create:${actor.userId}`}, 0))`,
    );
    const [created] = await tx
      .select({ n: count() })
      .from(organization)
      .where(eq(organization.createdBy, actor.userId));
    if ((created?.n ?? 0) >= LIMITS.createdPerUser) return fail("limitReached");

    const [org] = await tx
      .insert(organization)
      .values({ ...parsed.data, createdBy: actor.userId })
      .returning({ id: organization.id });
    if (!org) throw new Error("organization insert returned no row");
    const [member] = await tx
      .insert(organizationMember)
      .values({
        organizationId: org.id,
        userId: actor.userId,
        role: "owner",
        addedBy: actor.userId,
      })
      .returning({ id: organizationMember.id });
    await audit(tx, {
      organizationId: org.id,
      actorId: actor.userId,
      action: "organization.created",
      memberId: member?.id,
      role: "owner",
    });
    return { ok: true as const, organizationId: org.id };
  });
}

export async function updateOrganization(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
  raw: RawForm,
): Promise<WriteResult<OrganizationField>> {
  if (!isUuid(organizationId)) return fail("notFound");
  const parsed = parseOrganization(raw);

  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    if (!can(actor, "organization.update", { actorRole: membership.role }))
      return fail("forbidden");
    if (!parsed.ok)
      return {
        ok: false as const,
        error: "validation" as const,
        fieldErrors: parsed.fieldErrors,
      };
    if (!(await governorateExists(deps.db, parsed.data.governorateId)))
      return {
        ok: false as const,
        error: "validation" as const,
        fieldErrors: { governorateId: "invalidChoice" as const },
      };
    await tx
      .update(organization)
      .set({ ...parsed.data, updatedAt: nowOf(deps) })
      .where(eq(organization.id, organizationId));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "organization.updated",
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Invitations

/**
 * Invites an email address with a role. The same answer whether or not the
 * address has an account. Refuses an address that already belongs to a
 * member (the inviter sees members' emails anyway) or that has a pending
 * invitation; an expired one is closed and replaced. The email job is created
 * in the same transaction.
 */
export async function inviteMember(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
  raw: RawForm,
  locale: EmailLocale = "ar",
): Promise<WriteResult<InvitationField, { invitationId: string }>> {
  if (!isUuid(organizationId)) return fail("notFound");
  const parsed = parseInvitation(raw);
  const now = nowOf(deps);

  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    if (!can(actor, "invitations.read", { actorRole: membership.role }))
      return fail("forbidden");
    if (!parsed.ok)
      return {
        ok: false as const,
        error: "validation" as const,
        fieldErrors: parsed.fieldErrors,
      };
    const { email, role } = parsed.data;
    if (
      !can(actor, "invitation.create", {
        actorRole: membership.role,
        targetRole: role,
      })
    )
      return {
        ok: false as const,
        error: "forbidden" as const,
        fieldErrors: { role: "invalidChoice" as const },
      };

    const memberIds = await tx
      .select({ userId: organizationMember.userId })
      .from(organizationMember)
      .where(eq(organizationMember.organizationId, organizationId));
    const memberEmails = await getEmailsOfUsers(
      tx,
      memberIds.map((m) => m.userId),
    );
    if ([...memberEmails.values()].includes(email))
      return fail("alreadyMember");

    // Close an expired pending invitation to the same address first, so the
    // partial unique index admits the new one.
    const [existing] = await tx
      .select({
        id: organizationInvitation.id,
        expiresAt: organizationInvitation.expiresAt,
      })
      .from(organizationInvitation)
      .where(
        and(
          eq(organizationInvitation.organizationId, organizationId),
          eq(organizationInvitation.email, email),
          eq(organizationInvitation.status, "pending"),
        ),
      )
      .for("update");
    if (existing) {
      if (existing.expiresAt > now) return fail("alreadyInvited");
      await tx
        .update(organizationInvitation)
        .set({ status: "expired", closedAt: now })
        .where(eq(organizationInvitation.id, existing.id));
    }

    const [pending] = await tx
      .select({ n: count() })
      .from(organizationInvitation)
      .where(
        and(
          eq(organizationInvitation.organizationId, organizationId),
          eq(organizationInvitation.status, "pending"),
          gt(organizationInvitation.expiresAt, now),
        ),
      );
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [recent] = await tx
      .select({ n: count() })
      .from(organizationInvitation)
      .where(
        and(
          eq(organizationInvitation.organizationId, organizationId),
          gt(organizationInvitation.createdAt, dayAgo),
        ),
      );
    if (
      (pending?.n ?? 0) >= LIMITS.pendingInvitations ||
      (recent?.n ?? 0) >= LIMITS.invitationsPerDay
    )
      return fail("limitReached");

    const [invitation] = await tx
      .insert(organizationInvitation)
      .values({
        organizationId,
        email,
        role,
        invitedBy: actor.userId,
        locale,
        createdAt: now,
        expiresAt: new Date(
          now.getTime() + LIMITS.invitationDays * 24 * 60 * 60 * 1000,
        ),
      })
      .returning({ id: organizationInvitation.id });
    if (!invitation) throw new Error("invitation insert returned no row");
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "invitation.created",
      invitationId: invitation.id,
      role,
    });
    await enqueue(
      deps.boss,
      "organization.notify",
      { invitationId: invitation.id },
      { tx },
    );
    return { ok: true as const, invitationId: invitation.id };
  });
}

/** Locks one invitation of an organization; null if it is not there. */
async function lockInvitation(
  tx: Tx,
  invitationId: string,
  organizationId?: string,
) {
  const [row] = await tx
    .select({
      id: organizationInvitation.id,
      organizationId: organizationInvitation.organizationId,
      email: organizationInvitation.email,
      role: organizationInvitation.role,
      status: organizationInvitation.status,
      expiresAt: organizationInvitation.expiresAt,
    })
    .from(organizationInvitation)
    .where(
      organizationId
        ? and(
            eq(organizationInvitation.id, invitationId),
            eq(organizationInvitation.organizationId, organizationId),
          )
        : eq(organizationInvitation.id, invitationId),
    )
    .for("update");
  return row ? { ...row, role: narrowRole(row.role) } : null;
}

/**
 * A pending invitation past its expiry is closed as `expired` (in the
 * caller's transaction) and reported as closed.
 */
async function closeIfExpired(
  tx: Tx,
  invitation: { id: string; status: string; expiresAt: Date },
  now: Date,
): Promise<boolean> {
  if (invitation.status !== "pending") return true;
  if (invitation.expiresAt > now) return false;
  await tx
    .update(organizationInvitation)
    .set({ status: "expired", closedAt: now })
    .where(eq(organizationInvitation.id, invitation.id));
  return true;
}

export async function revokeInvitation(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
  invitationId: unknown,
): Promise<WriteResult> {
  if (!isUuid(organizationId) || !isUuid(invitationId)) return fail("notFound");
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    const invitation = await lockInvitation(tx, invitationId, organizationId);
    if (!invitation) return fail("notFound");
    if (
      !can(actor, "invitation.revoke", {
        actorRole: membership.role,
        targetRole: invitation.role,
      })
    )
      return fail("forbidden");
    if (await closeIfExpired(tx, invitation, now))
      return fail("invitationClosed");
    await tx
      .update(organizationInvitation)
      .set({ status: "revoked", closedAt: now, closedBy: actor.userId })
      .where(eq(organizationInvitation.id, invitation.id));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "invitation.revoked",
      invitationId: invitation.id,
      role: invitation.role,
    });
    return { ok: true as const };
  });
}

/**
 * The invitee accepts or declines. Only the user whose verified email is the
 * invited address may answer; for anyone else the invitation does not exist.
 * Accepting creates the membership with the invited role, unless the user is
 * already a member (their role stays as it is).
 */
export async function respondToInvitation(
  deps: OrganizationDeps,
  actor: Actor,
  invitationId: unknown,
  answer: unknown,
): Promise<WriteResult<never, { organizationId: string }>> {
  if (!actor.emailVerified) return fail("forbidden");
  if (!isUuid(invitationId)) return fail("notFound");
  if (answer !== "accept" && answer !== "decline") return fail("validation");
  const email = await getNotificationAddress(deps.db, actor.userId);
  if (!email) return fail("forbidden");
  const now = nowOf(deps);

  // The organization lock comes first, as in every other member change; the
  // invitation's organization is read unlocked to find it, then re-checked.
  const [target] = await deps.db
    .select({ organizationId: organizationInvitation.organizationId })
    .from(organizationInvitation)
    .where(
      and(
        eq(organizationInvitation.id, invitationId),
        eq(organizationInvitation.email, email),
      ),
    )
    .limit(1);
  if (!target) return fail("notFound");
  const organizationId = target.organizationId;

  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const invitation = await lockInvitation(tx, invitationId, organizationId);
    if (!invitation || invitation.email !== email) return fail("notFound");
    if (await closeIfExpired(tx, invitation, now))
      return fail("invitationClosed");

    if (answer === "decline") {
      await tx
        .update(organizationInvitation)
        .set({ status: "declined", closedAt: now, closedBy: actor.userId })
        .where(eq(organizationInvitation.id, invitation.id));
      await audit(tx, {
        organizationId,
        actorId: actor.userId,
        action: "invitation.declined",
        invitationId: invitation.id,
        role: invitation.role,
      });
      return { ok: true as const, organizationId };
    }

    let membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) {
      const [members] = await tx
        .select({ n: count() })
        .from(organizationMember)
        .where(eq(organizationMember.organizationId, organizationId));
      if ((members?.n ?? 0) >= LIMITS.membersPerOrganization)
        return fail("limitReached");
      const [inserted] = await tx
        .insert(organizationMember)
        .values({
          organizationId,
          userId: actor.userId,
          role: invitation.role,
          addedBy: actor.userId,
        })
        .returning({ id: organizationMember.id });
      if (!inserted) throw new Error("member insert returned no row");
      membership = { id: inserted.id, role: invitation.role };
    }
    await tx
      .update(organizationInvitation)
      .set({ status: "accepted", closedAt: now, closedBy: actor.userId })
      .where(eq(organizationInvitation.id, invitation.id));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "invitation.accepted",
      invitationId: invitation.id,
      memberId: membership.id,
      role: membership.role,
    });
    return { ok: true as const, organizationId };
  });
}

// ---------------------------------------------------------------------------
// Members

async function lockMember(tx: Tx, organizationId: string, memberId: string) {
  const [row] = await tx
    .select({
      id: organizationMember.id,
      userId: organizationMember.userId,
      role: organizationMember.role,
    })
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.id, memberId),
        eq(organizationMember.organizationId, organizationId),
      ),
    )
    .for("update");
  return row ? { ...row, role: narrowRole(row.role) } : null;
}

/** Owners change another member's role; at least one owner always remains. */
export async function changeMemberRole(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
  memberId: unknown,
  newRole: unknown,
): Promise<WriteResult> {
  if (!isUuid(organizationId) || !isUuid(memberId)) return fail("notFound");
  if (!isMemberRole(newRole)) return fail("validation");
  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    const target = await lockMember(tx, organizationId, memberId);
    if (!target) return fail("notFound");
    if (
      !can(actor, "member.changeRole", {
        actorRole: membership.role,
        targetRole: newRole,
        targetIsSelf: target.userId === actor.userId,
      })
    )
      return fail("forbidden");
    if (target.role === newRole) return { ok: true as const };
    if (target.role === "owner" && (await countOwners(tx, organizationId)) < 2)
      return fail("lastOwner");
    await tx
      .update(organizationMember)
      .set({ role: newRole, updatedAt: nowOf(deps) })
      .where(eq(organizationMember.id, target.id));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "member.role_changed",
      memberId: target.id,
      role: newRole,
      previousRole: target.role,
    });
    return { ok: true as const };
  });
}

/** Owners remove anyone else. */
export async function removeMember(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
  memberId: unknown,
): Promise<WriteResult> {
  if (!isUuid(organizationId) || !isUuid(memberId)) return fail("notFound");
  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    const target = await lockMember(tx, organizationId, memberId);
    if (!target) return fail("notFound");
    if (
      !can(actor, "member.remove", {
        actorRole: membership.role,
        targetRole: target.role,
        targetIsSelf: target.userId === actor.userId,
      })
    )
      return fail("forbidden");
    if (target.role === "owner" && (await countOwners(tx, organizationId)) < 2)
      return fail("lastOwner");
    await tx
      .delete(organizationMember)
      .where(eq(organizationMember.id, target.id));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "member.removed",
      memberId: target.id,
      previousRole: target.role,
    });
    return { ok: true as const };
  });
}

/** Any member leaves, except the last owner. */
export async function leaveOrganization(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: unknown,
): Promise<WriteResult> {
  if (!isUuid(organizationId)) return fail("notFound");
  return deps.db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return fail("notFound");
    const membership = await membershipOf(tx, organizationId, actor.userId);
    if (!membership) return fail("notFound");
    if (!can(actor, "organization.leave", { actorRole: membership.role }))
      return fail("forbidden");
    if (
      membership.role === "owner" &&
      (await countOwners(tx, organizationId)) < 2
    )
      return fail("lastOwner");
    await tx
      .delete(organizationMember)
      .where(eq(organizationMember.id, membership.id));
    await audit(tx, {
      organizationId,
      actorId: actor.userId,
      action: "member.left",
      memberId: membership.id,
      previousRole: membership.role,
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Data export (ADR-005, data rights)

export type OrganizationsExport = {
  memberships: {
    organizationName: string;
    kind: OrganizationKind;
    governorate: GovernorateRef | null;
    addressLine: string | null;
    role: MemberRole;
    joinedAt: string;
  }[];
  invitationsReceived: {
    organizationName: string;
    role: MemberRole;
    status: string;
    createdAt: string;
    closedAt: string | null;
  }[];
};

/**
 * The caller's memberships and the invitations sent to their verified
 * address. Other members' data is not included.
 */
export async function exportOwnOrganizations(
  db: Db,
  actor: Actor,
): Promise<OrganizationsExport> {
  if (!actor.emailVerified) return { memberships: [], invitationsReceived: [] };
  const [memberships, governorates, email] = await Promise.all([
    db
      .select({
        organizationName: organization.name,
        kind: organization.kind,
        governorateId: organization.governorateId,
        addressLine: organization.addressLine,
        role: organizationMember.role,
        joinedAt: organizationMember.createdAt,
      })
      .from(organizationMember)
      .innerJoin(
        organization,
        eq(organization.id, organizationMember.organizationId),
      )
      .where(eq(organizationMember.userId, actor.userId))
      .orderBy(asc(organizationMember.createdAt)),
    listGovernorates(db),
    getNotificationAddress(db, actor.userId),
  ]);
  const invitations = email
    ? await db
        .select({
          organizationName: organization.name,
          role: organizationInvitation.role,
          status: organizationInvitation.status,
          createdAt: organizationInvitation.createdAt,
          closedAt: organizationInvitation.closedAt,
        })
        .from(organizationInvitation)
        .innerJoin(
          organization,
          eq(organization.id, organizationInvitation.organizationId),
        )
        .where(eq(organizationInvitation.email, email))
        .orderBy(asc(organizationInvitation.createdAt))
    : [];
  return {
    memberships: memberships.map((m) => {
      const g = governorates.find((x) => x.id === m.governorateId);
      return {
        organizationName: m.organizationName,
        kind: narrowKind(m.kind),
        governorate: g
          ? { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn }
          : null,
        addressLine: m.addressLine,
        role: narrowRole(m.role),
        joinedAt: m.joinedAt.toISOString(),
      };
    }),
    invitationsReceived: invitations.map((i) => ({
      organizationName: i.organizationName,
      role: narrowRole(i.role),
      status: i.status,
      createdAt: i.createdAt.toISOString(),
      closedAt: i.closedAt ? i.closedAt.toISOString() : null,
    })),
  };
}
