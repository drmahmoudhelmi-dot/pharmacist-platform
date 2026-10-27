"use server";

import { headers } from "next/headers";
import { type Actor, can, requireStaff } from "@/modules/identity/policy";
import { isStaffRole } from "@/modules/identity/roles";
import {
  reinstateAccount,
  type SuspensionResult,
  suspendAccount,
} from "@/modules/identity/suspension";
import { getDb } from "@/shared/db/client";
import { getJobClient } from "@/shared/jobs/client";
import { logger } from "@/shared/logging/logger";
import { auditIp } from "./audit";
import { changeStaffRole, type RoleActionResult } from "./service";

// Server actions for staff role management (ADR-008). The caller is resolved
// from the session (super_admin, TOTP session); the service applies the
// policy again. Results are plain codes the UI maps to messages. Logs carry
// ids and codes only: never the email typed into the form.

export type RoleFormResult = RoleActionResult | { ok: false; error: "generic" };

const log = logger.child({ module: "admin" });

async function change(
  change: "grant" | "revoke",
  email: unknown,
  role: unknown,
): Promise<RoleFormResult> {
  const actor = await requireStaff("super_admin");
  const ip = (await headers()).get("x-forwarded-for");
  try {
    const result = await changeStaffRole(
      getDb(),
      actor,
      { email, role, change },
      ip,
    );
    log.info({
      event: `admin.role.${change}`,
      userId: actor.userId,
      role: isStaffRole(role) ? role : undefined,
      outcome: result.ok ? result.status : result.error,
    });
    return result;
  } catch (error) {
    log.error(
      {
        event: `admin.role.${change}.failed`,
        userId: actor.userId,
        errName: error instanceof Error ? error.name : undefined,
      },
      "role change failed",
    );
    return { ok: false, error: "generic" };
  }
}

export async function grantRoleAction(form: FormData) {
  return change("grant", form.get("email"), form.get("role"));
}

export async function revokeRoleAction(email: string, role: string) {
  return change("revoke", email, role);
}

// ---------------------------------------------------------------------------
// Account suspension (ADR-009). The staff area gate is requireStaff(); the
// service applies `account.suspend` and the staff-target rule again.

export type SuspensionFormResult =
  SuspensionResult | { ok: false; error: "generic" };

async function suspension(
  name: "suspend" | "reinstate",
  userId: unknown,
  work: (actor: Actor, ip: string | null) => Promise<SuspensionResult>,
): Promise<SuspensionFormResult> {
  const actor = await requireStaff();
  if (!can(actor, "account.suspend")) return { ok: false, error: "forbidden" };
  const ip = auditIp((await headers()).get("x-forwarded-for"));
  const target = typeof userId === "string" ? userId.slice(0, 36) : undefined;
  try {
    const result = await work(actor, ip);
    log.info({
      event: `admin.account.${name}`,
      userId: actor.userId,
      targetUserId: target,
      outcome: result.ok ? "ok" : result.error,
    });
    return result;
  } catch (error) {
    log.error(
      {
        event: `admin.account.${name}.failed`,
        userId: actor.userId,
        targetUserId: target,
        errName: error instanceof Error ? error.name : undefined,
      },
      "account suspension change failed",
    );
    return { ok: false, error: "generic" };
  }
}

export async function suspendAccountAction(
  userId: string,
  form: FormData,
): Promise<SuspensionFormResult> {
  return suspension("suspend", userId, async (actor, ip) =>
    suspendAccount(
      { db: getDb(), boss: await getJobClient() },
      actor,
      { userId, reasonCode: form.get("reasonCode"), note: form.get("note") },
      ip,
    ),
  );
}

export async function reinstateAccountAction(
  userId: string,
  form: FormData,
): Promise<SuspensionFormResult> {
  return suspension("reinstate", userId, async (actor, ip) =>
    reinstateAccount(
      { db: getDb(), boss: await getJobClient() },
      actor,
      { userId, reasonCode: form.get("reasonCode") },
      ip,
    ),
  );
}
