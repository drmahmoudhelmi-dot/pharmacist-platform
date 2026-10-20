import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { StaffRole } from "./roles";
import { isStaffRole } from "./roles";
import { session, user, userRole } from "./schema";

/** Staff roles held by a user; empty for regular users. */
export async function listRoles(
  db: NodePgDatabase,
  userId: string,
): Promise<StaffRole[]> {
  const rows = await db
    .select({ role: userRole.role })
    .from(userRole)
    .where(eq(userRole.userId, userId));
  // The CHECK constraint guarantees valid values; filter defensively anyway.
  return rows.map((row) => row.role).filter(isStaffRole);
}

export async function findUserByEmail(db: NodePgDatabase, email: string) {
  const rows = await db
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export type RoleChangeResult =
  | { status: "granted" | "revoked"; userId: string; sessionsRevoked: number }
  | { status: "unchanged"; userId: string }
  | { status: "user_not_found" | "email_not_verified" | "invalid_role" };

/**
 * Grants or revokes a staff role and, when something changed, deletes all the
 * user's sessions in the same transaction, so the next session is a fresh
 * sign-in (session rotation on privilege change, ADR-002).
 */
export async function changeRole(
  db: NodePgDatabase,
  input: {
    email: string;
    role: string;
    change: "grant" | "revoke";
    grantedBy?: string | null;
  },
): Promise<RoleChangeResult> {
  if (!isStaffRole(input.role)) return { status: "invalid_role" };
  const role = input.role;
  const target = await findUserByEmail(db, input.email);
  if (!target) return { status: "user_not_found" };
  if (!target.emailVerified) return { status: "email_not_verified" };

  return db.transaction(async (tx) => {
    const changed =
      input.change === "grant"
        ? await tx
            .insert(userRole)
            .values({
              userId: target.id,
              role,
              grantedBy: input.grantedBy ?? null,
            })
            .onConflictDoNothing({ target: [userRole.userId, userRole.role] })
            .returning({ id: userRole.id })
        : await tx
            .delete(userRole)
            .where(and(eq(userRole.userId, target.id), eq(userRole.role, role)))
            .returning({ id: userRole.id });
    if (changed.length === 0) {
      return { status: "unchanged" as const, userId: target.id };
    }
    const revoked = await tx
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });
    return {
      status:
        input.change === "grant" ? ("granted" as const) : ("revoked" as const),
      userId: target.id,
      sessionsRevoked: revoked.length,
    };
  });
}
