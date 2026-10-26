"use server";

import { headers } from "next/headers";
import { requireStaff } from "@/modules/identity/policy";
import { isStaffRole } from "@/modules/identity/roles";
import { getDb } from "@/shared/db/client";
import { logger } from "@/shared/logging/logger";
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
