import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { user } from "./schema";

/**
 * The address to send a transactional email to, for other modules' background
 * jobs (verification notices). Null when the user no longer exists or has not
 * verified the address. Callers must not log the result.
 */
export async function getNotificationAddress(
  db: NodePgDatabase,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.emailVerified ? row.email : null;
}

/**
 * Addresses of several users, for other modules that show members to each
 * other (organizations: owners and admins see their members' emails). Users
 * that no longer exist are absent from the map. Callers must not log it.
 */
export async function getEmailsOfUsers(
  db: Pick<NodePgDatabase, "select">,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.id, [...userIds]));
  return new Map(rows.map((r) => [r.id, r.email]));
}
