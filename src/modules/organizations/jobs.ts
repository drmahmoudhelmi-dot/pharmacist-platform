import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import type { EmailSender } from "@/shared/email/sender";
import { renderEmail } from "@/shared/email/templates";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import {
  type EmailLocale,
  isEmailLocale,
  isMemberRole,
  type MemberRole,
} from "./constants";
import { organization, organizationInvitation } from "./schema";

// The worker side of organizations (ADR-005): the `organization.notify`
// invitation email. Runs in `pnpm worker`, not in the web app, so it does not
// import "server-only". Logs carry ids only, never the address or the
// organization's name.

type Db = NodePgDatabase;

export type InvitationNoticeDeps = {
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

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

export function renderInvitationEmail(input: {
  to: string;
  locale: EmailLocale;
  appUrl: string;
  organizationName: string;
  role: MemberRole;
}) {
  const catalog = catalogs[input.locale];
  const strings = catalog.OrganizationEmail.invited;
  const values = {
    organization: input.organizationName,
    role: catalog.OrganizationRoles[input.role],
    days: catalog.OrganizationEmail.days,
  };
  return renderEmail(
    {
      subject: fill(strings.subject, values),
      heading: strings.heading,
      paragraphs: [fill(strings.body, values), fill(strings.expiry, values)],
      action: {
        label: strings.action,
        url: `${input.appUrl}${pagePath(input.locale, "/organizations")}`,
      },
      note: strings.note,
    },
    { to: input.to, locale: input.locale },
  );
}

export type NoticeOutcome = "sent" | "skipped";

/**
 * Emails one invitation to its address. Skips (without retrying) when the
 * invitation is gone, no longer pending or already expired. SMTP errors
 * throw, so pg-boss retries with backoff.
 */
export async function sendInvitationNotice(
  deps: InvitationNoticeDeps,
  invitationId: string,
  now: Date = new Date(),
): Promise<NoticeOutcome> {
  const [row] = await deps.db
    .select({
      email: organizationInvitation.email,
      role: organizationInvitation.role,
      status: organizationInvitation.status,
      locale: organizationInvitation.locale,
      expiresAt: organizationInvitation.expiresAt,
      organizationName: organization.name,
    })
    .from(organizationInvitation)
    .innerJoin(
      organization,
      eq(organization.id, organizationInvitation.organizationId),
    )
    .where(eq(organizationInvitation.id, invitationId))
    .limit(1);
  const skip = (reason: string): NoticeOutcome => {
    deps.logger.info({
      event: "organization.invitation_notice_skipped",
      invitationId,
      reason,
    });
    return "skipped";
  };
  if (!row) return skip("invitation_missing");
  if (row.status !== "pending") return skip("not_pending");
  if (row.expiresAt <= now) return skip("expired");
  if (!isMemberRole(row.role)) return skip("invalid_role");
  const message = renderInvitationEmail({
    to: row.email,
    locale: isEmailLocale(row.locale) ? row.locale : "ar",
    appUrl: deps.appUrl,
    organizationName: row.organizationName,
    role: row.role,
  });
  await deps.emailSender.send(message);
  deps.logger.info({
    event: "organization.invitation_notice_sent",
    invitationId,
  });
  return "sent";
}
