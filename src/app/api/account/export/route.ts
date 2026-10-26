import { recordAudit } from "@/modules/admin/audit";
import { can as canAccount, getActor } from "@/modules/identity/policy";
import { exportOwnApplications } from "@/modules/jobs/applications";
import { exportOwnData } from "@/modules/profiles/service";
import { getDb } from "@/shared/db/client";
import { logger } from "@/shared/logging/logger";

// "Download my data" (ADR-003, data rights): the caller's own account and
// profile data as a JSON attachment. Never cached; ids only in the log.
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAccount(actor, "account.read", { ownerId: actor.userId })) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const now = new Date();
  const [profileData, applications] = await Promise.all([
    exportOwnData(getDb(), actor, now),
    // Applications live in the jobs module, which depends on profiles; so
    // they join the export here rather than inside profiles' export.
    exportOwnApplications(getDb(), actor),
  ]);
  const data = profileData ? { ...profileData, applications } : null;
  if (!data) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // On record in the admin audit log (ADR-008): who exported which account.
  await recordAudit(getDb(), {
    actorId: actor.userId,
    actorKind: "user",
    action: "account.data_exported",
    targetType: "user",
    targetId: actor.userId,
    detail: {},
    ip: request.headers.get("x-forwarded-for"),
  });
  logger.info({ event: "account.data_exported", userId: actor.userId });
  const date = now.toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="pharmacist-platform-data-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
