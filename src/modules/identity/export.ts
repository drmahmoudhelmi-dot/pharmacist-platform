import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { listRoles } from "./roles-service";
import { user } from "./schema";

export type AccountExport = {
  id: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  roles: string[];
};

/**
 * The identity part of a user's data export (ADR-003, data rights). Columns
 * are listed explicitly: password hashes, session tokens, TOTP secrets and
 * backup codes live in other tables and are never selected here. The always
 * empty `name` and `image` columns are left out.
 */
export async function getAccountExport(
  db: NodePgDatabase,
  userId: string,
): Promise<AccountExport | null> {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    roles: await listRoles(db, userId),
  };
}
