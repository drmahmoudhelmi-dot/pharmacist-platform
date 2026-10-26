"use server";

import { getLocale } from "next-intl/server";
import { requireActor } from "@/modules/identity/policy";
import { getDb } from "@/shared/db/client";
import { getJobClient } from "@/shared/jobs/client";
import { logger } from "@/shared/logging/logger";
import { isEmailLocale } from "./constants";
import {
  changeMemberRole,
  createOrganization,
  inviteMember,
  leaveOrganization,
  type OrganizationDeps,
  removeMember,
  respondToInvitation,
  revokeInvitation,
  updateOrganization,
  type WriteResult,
} from "./service";
import {
  formDataToRaw,
  type InvitationField,
  isUuid,
  type OrganizationField,
} from "./validation";

// Server actions for the organization pages. Each resolves the caller from
// the session and passes only ids and form fields to the service, which loads
// the caller's membership, applies the policy and validates. Results are
// plain codes; the UI maps them to messages. Logs carry ids only, never form
// values (the invited email address).

export type ActionResult<K extends string = never, T = object> =
  WriteResult<K, T> | { ok: false; error: "generic" };

const log = logger.child({ module: "organizations" });

async function deps(): Promise<OrganizationDeps> {
  return { db: getDb(), boss: await getJobClient() };
}

async function run<K extends string, T>(
  name: string,
  ids: { userId: string; organizationId?: unknown },
  work: () => Promise<WriteResult<K, T>>,
): Promise<ActionResult<K, T>> {
  // Client-supplied: logged only when it is a well-formed id.
  const organizationId = isUuid(ids.organizationId)
    ? ids.organizationId
    : undefined;
  try {
    const result = await work();
    if (result.ok)
      log.info({
        event: `organizations.${name}`,
        userId: ids.userId,
        organizationId,
      });
    return result;
  } catch (error) {
    log.error(
      {
        event: `organizations.${name}.failed`,
        userId: ids.userId,
        organizationId,
        errName: error instanceof Error ? error.name : undefined,
      },
      "organization write failed",
    );
    return { ok: false, error: "generic" };
  }
}

export async function createOrganizationAction(
  form: FormData,
): Promise<ActionResult<OrganizationField, { organizationId: string }>> {
  const actor = await requireActor();
  return run("created", { userId: actor.userId }, async () =>
    createOrganization(await deps(), actor, formDataToRaw(form)),
  );
}

export async function updateOrganizationAction(
  organizationId: string,
  form: FormData,
): Promise<ActionResult<OrganizationField>> {
  const actor = await requireActor();
  return run("updated", { userId: actor.userId, organizationId }, async () =>
    updateOrganization(
      await deps(),
      actor,
      organizationId,
      formDataToRaw(form),
    ),
  );
}

export async function inviteMemberAction(
  organizationId: string,
  form: FormData,
): Promise<ActionResult<InvitationField, { invitationId: string }>> {
  const actor = await requireActor();
  const locale = await getLocale();
  return run(
    "invitation.created",
    { userId: actor.userId, organizationId },
    async () =>
      inviteMember(
        await deps(),
        actor,
        organizationId,
        formDataToRaw(form),
        isEmailLocale(locale) ? locale : "ar",
      ),
  );
}

export async function revokeInvitationAction(
  organizationId: string,
  invitationId: string,
): Promise<ActionResult> {
  const actor = await requireActor();
  return run(
    "invitation.revoked",
    { userId: actor.userId, organizationId },
    async () =>
      revokeInvitation(await deps(), actor, organizationId, invitationId),
  );
}

export async function respondToInvitationAction(
  invitationId: string,
  answer: "accept" | "decline",
): Promise<ActionResult<never, { organizationId: string }>> {
  const actor = await requireActor();
  return run(`invitation.${answer}`, { userId: actor.userId }, async () =>
    respondToInvitation(await deps(), actor, invitationId, answer),
  );
}

export async function changeMemberRoleAction(
  organizationId: string,
  memberId: string,
  role: string,
): Promise<ActionResult> {
  const actor = await requireActor();
  return run(
    "member.role_changed",
    { userId: actor.userId, organizationId },
    async () =>
      changeMemberRole(await deps(), actor, organizationId, memberId, role),
  );
}

export async function removeMemberAction(
  organizationId: string,
  memberId: string,
): Promise<ActionResult> {
  const actor = await requireActor();
  return run(
    "member.removed",
    { userId: actor.userId, organizationId },
    async () => removeMember(await deps(), actor, organizationId, memberId),
  );
}

export async function leaveOrganizationAction(
  organizationId: string,
): Promise<ActionResult> {
  const actor = await requireActor();
  return run(
    "member.left",
    { userId: actor.userId, organizationId },
    async () => leaveOrganization(await deps(), actor, organizationId),
  );
}
