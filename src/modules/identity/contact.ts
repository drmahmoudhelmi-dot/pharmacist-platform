import { eq } from "drizzle-orm";
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
