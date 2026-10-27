import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { accountSuspension } from "./schema";

// Whether accounts are suspended (ADR-009). A leaf with no imports beyond the
// schema, so Better Auth's configuration (auth-config.ts) and other modules
// can call it without import cycles. The workflow is in suspension.ts.

type Db = NodePgDatabase;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/** True while the account has an active suspension. */
export async function isSuspended(
  db: Pick<Db, "select">,
  userId: string,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const [row] = await db
    .select({ id: accountSuspension.id })
    .from(accountSuspension)
    .where(
      and(
        eq(accountSuspension.userId, userId),
        isNull(accountSuspension.liftedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Of the given accounts, those currently suspended. */
export async function getSuspendedUserIds(
  db: Pick<Db, "select">,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(isUuid))];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: accountSuspension.userId })
    .from(accountSuspension)
    .where(
      and(
        inArray(accountSuspension.userId, ids),
        isNull(accountSuspension.liftedAt),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}
