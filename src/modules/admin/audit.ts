import { isIP } from "node:net";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type { ActorKind, AuditAction, TargetType } from "./constants";
import { adminAudit } from "./schema";

// The single writer for the admin audit log (ADR-008). A leaf: it imports
// only its own schema, so identity, verification, jobs and later modules can
// call it from inside their own transactions without import cycles. Callers
// pass their transaction; if the action rolls back, the audit row goes too.

type Writer = Pick<NodePgDatabase, "insert">;

const code = z.string().regex(/^[a-z0-9_.-]{1,64}$/);

/** The detail each action may carry: codes only, never personal data. */
const DETAIL: Record<AuditAction, z.ZodType<Record<string, string>>> = {
  "role.granted": z.strictObject({ role: code }),
  "role.revoked": z.strictObject({ role: code }),
  "verification.decided": z.strictObject({ decision: code, reasonCode: code }),
  "job.moderated": z.strictObject({ decision: code, reasonCode: code }),
  "account.data_exported": z.strictObject({}),
};

export type AuditEntry = {
  actorId: string | null;
  actorKind: ActorKind;
  action: AuditAction;
  targetType: TargetType;
  targetId: string;
  detail: Record<string, string>;
  ip?: string | null;
  at?: Date;
};

/** First X-Forwarded-For entry, if it is an IP address (else null). */
export function auditIp(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim() ?? "";
  return first !== "" && isIP(first) !== 0 ? first : null;
}

/**
 * Records one staff action. Throws on a detail that does not match the
 * action's schema, so a mistake fails the action instead of logging
 * something it should not.
 */
export async function recordAudit(db: Writer, entry: AuditEntry) {
  const detail = DETAIL[entry.action].parse(entry.detail);
  await db.insert(adminAudit).values({
    actorId: entry.actorId,
    actorKind: entry.actorKind,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    detail,
    ip: auditIp(entry.ip),
    ...(entry.at ? { at: entry.at } : {}),
  });
}
