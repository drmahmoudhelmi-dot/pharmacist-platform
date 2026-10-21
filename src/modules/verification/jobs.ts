import { and, eq, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import { getNotificationAddress } from "@/modules/identity/contact";
import type { EmailSender } from "@/shared/email/sender";
import { renderEmail } from "@/shared/email/templates";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import {
  type EmailLocale,
  isEmailLocale,
  isRejectReason,
  type NotificationKind,
} from "./constants";
import { cairoToday } from "./national-id";
import { verificationDecision, verificationSubmission } from "./schema";

// The worker side of verification (ADR-004, 4b): the `verification.notify`
// email job and the daily `verification.expire` job. Runs in `pnpm worker`,
// not in the web app, so it does not import "server-only". Logs carry ids and
// codes only, never addresses or message contents.

type Db = NodePgDatabase;

export type NoticeDeps = {
  db: Db;
  emailSender: EmailSender;
  logger: Logger;
  /** Public origin without a trailing slash. */
  appUrl: string;
};

const catalogs = { ar, en } as const;

/** Arabic is unprefixed (localePrefix "as-needed"). */
const pagePath = (locale: EmailLocale, path: string) =>
  locale === "ar" ? path : `/en${path}`;

export function renderVerificationEmail(
  kind: NotificationKind,
  input: {
    to: string;
    locale: EmailLocale;
    appUrl: string;
    rejectionReason?: string | null;
  },
) {
  const catalog = catalogs[input.locale];
  const strings = catalog.VerificationEmail[kind];
  const paragraphs: string[] = [strings.body];
  if (kind === "rejected" && isRejectReason(input.rejectionReason))
    paragraphs.push(
      `${catalog.VerificationEmail.reasonLabel}: ${catalog.VerificationReasons[input.rejectionReason]}`,
    );
  return renderEmail(
    {
      subject: strings.subject,
      heading: strings.heading,
      paragraphs,
      action: {
        label: strings.action,
        url: `${input.appUrl}${pagePath(input.locale, "/verification")}`,
      },
      note: catalog.VerificationEmail.note,
    },
    { to: input.to, locale: input.locale },
  );
}

export type NoticeOutcome = "sent" | "skipped";

/**
 * Sends one notice about a submission. Skips (without retrying) when the
 * submission or the user's verified address is gone, or when a decision
 * notice no longer matches the recorded decision. SMTP errors throw, so
 * pg-boss retries with backoff.
 */
export async function sendVerificationNotice(
  deps: NoticeDeps,
  submissionId: string,
  kind: NotificationKind,
): Promise<NoticeOutcome> {
  const [row] = await deps.db
    .select({
      userId: verificationSubmission.userId,
      locale: verificationSubmission.locale,
      decision: verificationDecision.decision,
      reasonCode: verificationDecision.reasonCode,
    })
    .from(verificationSubmission)
    .leftJoin(
      verificationDecision,
      eq(verificationDecision.submissionId, verificationSubmission.id),
    )
    .where(eq(verificationSubmission.id, submissionId))
    .limit(1);
  const skip = (reason: string): NoticeOutcome => {
    deps.logger.info({
      event: "verification.notice_skipped",
      submissionId,
      kind,
      reason,
    });
    return "skipped";
  };
  if (!row) return skip("submission_missing");
  if (kind !== "received" && row.decision !== kind)
    return skip("decision_mismatch");
  const to = await getNotificationAddress(deps.db, row.userId);
  if (!to) return skip("no_address");
  const message = renderVerificationEmail(kind, {
    to,
    locale: isEmailLocale(row.locale) ? row.locale : "ar",
    appUrl: deps.appUrl,
    rejectionReason: row.reasonCode,
  });
  await deps.emailSender.send(message);
  deps.logger.info({
    event: "verification.notice_sent",
    submissionId,
    userId: row.userId,
    kind,
  });
  return "sent";
}

/**
 * Marks verified submissions whose card expiry date is before today (in
 * Cairo) as expired. Idempotent: only `verified` rows move, and the database
 * trigger allows no other transition. Returns how many changed.
 */
export async function expireVerifications(
  deps: { db: Db; logger: Logger },
  now: Date = new Date(),
): Promise<number> {
  const today = cairoToday(now);
  const expired = await deps.db
    .update(verificationSubmission)
    .set({ status: "expired", expiredAt: now, updatedAt: now })
    .where(
      and(
        eq(verificationSubmission.status, "verified"),
        lt(verificationSubmission.cardExpiresOn, today),
      ),
    )
    .returning({ id: verificationSubmission.id });
  deps.logger.info({
    event: "verification.expired",
    count: expired.length,
    today,
  });
  return expired.length;
}
