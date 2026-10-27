import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import type { EmailSender } from "@/shared/email/sender";
import { renderEmail } from "@/shared/email/templates";
import ar from "../../../messages/ar.json";
import { getNotificationAddress } from "./contact";
import { accountSuspension } from "./schema";
import type { SuspensionNoticeKind } from "./suspension-constants";

// The worker side of account suspension (ADR-009): the `account.notify`
// email. Runs in `pnpm worker`, so no "server-only". Arabic, the product
// default; the internal note is never read here. Logs carry ids only.

export type AccountNoticeDeps = {
  db: NodePgDatabase;
  emailSender: EmailSender;
  logger: Logger;
  /** Public origin without a trailing slash. */
  appUrl: string;
};

/**
 * Emails the account that it was suspended (with the reason) or reinstated.
 * Skips when the record or the verified address is gone, or when the notice
 * no longer matches the record (a suspension already lifted).
 */
export async function sendAccountNotice(
  deps: AccountNoticeDeps,
  suspensionId: string,
  kind: SuspensionNoticeKind,
): Promise<"sent" | "skipped"> {
  const [row] = await deps.db
    .select({
      userId: accountSuspension.userId,
      reasonCode: accountSuspension.reasonCode,
      liftedAt: accountSuspension.liftedAt,
    })
    .from(accountSuspension)
    .where(eq(accountSuspension.id, suspensionId))
    .limit(1);
  const skip = (reason: string) => {
    deps.logger.info({
      event: "account.notice_skipped",
      suspensionId,
      kind,
      reason,
    });
    return "skipped" as const;
  };
  if (!row) return skip("record_missing");
  if ((kind === "suspended") !== (row.liftedAt === null))
    return skip("state_mismatch");
  const to = await getNotificationAddress(deps.db, row.userId);
  if (!to) return skip("no_address");
  const catalog = ar.AccountEmail;
  const strings = catalog[kind];
  const paragraphs = [strings.body];
  if (kind === "suspended")
    paragraphs.push(
      `${catalog.reasonLabel}: ${ar.SuspensionReasons[row.reasonCode]}`,
    );
  await deps.emailSender.send(
    renderEmail(
      {
        subject: strings.subject,
        heading: strings.heading,
        paragraphs,
        action: {
          label: strings.action,
          url: kind === "reinstated" ? `${deps.appUrl}/sign-in` : deps.appUrl,
        },
        note: catalog.note,
      },
      { to, locale: "ar" },
    ),
  );
  deps.logger.info({ event: "account.notice_sent", suspensionId, kind });
  return "sent";
}
