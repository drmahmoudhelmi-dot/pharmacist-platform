import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/shared/db/client";
import { type Actor, can } from "./policy";
import { user } from "./schema";

export type AccountView = {
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  isStaff: boolean;
};

/** The caller's own account details. Returns null if the policy says no. */
export async function getAccountView(
  actor: Actor,
  ownerId: string = actor.userId,
): Promise<AccountView | null> {
  if (!can(actor, "account.read", { ownerId })) return null;
  const rows = await getDb()
    .select({
      email: user.email,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(user)
    .where(eq(user.id, ownerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, isStaff: actor.roles.length > 0 };
}
