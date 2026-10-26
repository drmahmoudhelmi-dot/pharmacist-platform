// Operator CLI for staff roles (ADR-002); the admin UI at /staff/roles is the
// everyday path (ADR-008). Changes here are audited with actor kind operator:
//   pnpm admin:grant-role <email> <role>
//   pnpm admin:revoke-role <email> <role>
// The user must exist and have a verified email. Any change revokes all of the
// user's sessions. Logs carry user ids only, never the email address.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createLogger } from "../../../shared/logging/logger";
import { STAFF_ROLES } from "../roles";
import { changeRole } from "../roles-service";

const logger = createLogger({
  base: { module: "identity", tool: "role-admin" },
});

const MESSAGES = {
  invalid_role: `Unknown role. Allowed: ${STAFF_ROLES.join(", ")}.`,
  user_not_found: "No user with that email.",
  email_not_verified: "The user has not verified their email yet.",
  // Staff-only rules; the operator CLI is not bound by them.
  self_change: "Staff cannot change their own roles.",
  last_super_admin: "At least one super_admin must remain.",
  actor_not_super_admin: "Only a current super_admin may change roles.",
} as const;

async function main(argv: string[]): Promise<number> {
  const [change, email, role] = argv;
  if ((change !== "grant" && change !== "revoke") || !email || !role) {
    console.error(
      "Usage: pnpm admin:grant-role <email> <role> | pnpm admin:revoke-role <email> <role>",
    );
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (copy .env.example to .env).");
    return 2;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await changeRole(drizzle(pool), { email, role, change });
    switch (result.status) {
      case "invalid_role":
      case "user_not_found":
      case "email_not_verified":
      case "self_change":
      case "last_super_admin":
      case "actor_not_super_admin":
        // Raw arguments are not logged: a swapped argument could be an email.
        logger.warn({
          event: `role.${change}.rejected`,
          reason: result.status,
        });
        console.error(MESSAGES[result.status]);
        return 1;
      case "unchanged":
        logger.info({
          event: `role.${change}.unchanged`,
          userId: result.userId,
          role,
        });
        console.log(
          `No change: the user ${change === "grant" ? "already has" : "does not have"} that role.`,
        );
        return 0;
      case "granted":
      case "revoked":
        logger.info({
          event: `role.${result.status}`,
          userId: result.userId,
          role,
          sessionsRevoked: result.sessionsRevoked,
          actor: "operator-cli",
        });
        console.log(
          `Role ${result.status}. ${result.sessionsRevoked} session(s) revoked; the user must sign in again.`,
        );
        return 0;
    }
  } catch (error) {
    logger.error({
      event: `role.${change}.failed`,
      errName: error instanceof Error ? error.name : "unknown",
    });
    console.error("Failed: database error (see logs).");
    return 1;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
