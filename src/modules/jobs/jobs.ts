import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import { getNotificationAddress } from "@/modules/identity/contact";
import { isOrganizationMember } from "@/modules/organizations/jobs";
import type { EmailSender } from "@/shared/email/sender";
import { renderEmail } from "@/shared/email/templates";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import {
  type ApplicationNoticeKind,
  type EmailLocale,
  isRejectReason,
  type JobNotificationKind,
} from "./constants";
import { job, jobApplication, jobEvent, jobModerationDecision } from "./schema";

// The worker side of jobs (ADR-006): the daily `jobs.expire` pass and the
// `jobs.notify` emails to a job's creator. Runs in `pnpm worker`, not in the
// web app, so it does not import "server-only". Logs carry ids only.

type Db = NodePgDatabase;

export type JobNoticeDeps = {
  db: Db;
  emailSender: EmailSender;
  logger: Logger;
  /** Public origin without a trailing slash. */
  appUrl: string;
};

const catalogs = { ar, en } as const;

const pagePath = (locale: EmailLocale, path: string) =>
  locale === "ar" ? path : `/en${path}`;

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

export function renderJobEmail(
  kind: JobNotificationKind,
  input: {
    to: string;
    locale: EmailLocale;
    appUrl: string;
    jobId: string;
    title: string;
    rejectionReason?: string | null;
  },
) {
  const catalog = catalogs[input.locale];
  const strings = catalog.JobEmail[kind];
  const paragraphs = [fill(strings.body, { title: input.title })];
  if (
    (kind === "rejected" || kind === "removed") &&
    isRejectReason(input.rejectionReason)
  )
    paragraphs.push(
      `${catalog.JobEmail.reasonLabel}: ${catalog.JobRejectReasons[input.rejectionReason]}`,
    );
  return renderEmail(
    {
      subject: fill(strings.subject, { title: input.title }),
      heading: strings.heading,
      paragraphs,
      action: {
        label: strings.action,
        url: `${input.appUrl}${pagePath(input.locale, `/manage/jobs/${input.jobId}`)}`,
      },
      note: catalog.JobEmail.note,
    },
    { to: input.to, locale: input.locale },
  );
}

/**
 * Emails the job's creator about a moderation decision or the expiry. Skips
 * when the job or the creator's verified address is gone, or when a decision
 * notice no longer matches the job's state. Arabic, the product default:
 * there is no stored language preference yet.
 */
export async function sendJobNotice(
  deps: JobNoticeDeps,
  jobId: string,
  kind: JobNotificationKind,
): Promise<"sent" | "skipped"> {
  const [row] = await deps.db
    .select({
      title: job.title,
      status: job.status,
      createdBy: job.createdBy,
      organizationId: job.organizationId,
    })
    .from(job)
    .where(eq(job.id, jobId))
    .limit(1);
  const skip = (reason: string) => {
    deps.logger.info({ event: "jobs.notice_skipped", jobId, kind, reason });
    return "skipped" as const;
  };
  if (!row) return skip("job_missing");
  const expected: Record<JobNotificationKind, readonly string[]> = {
    approved: ["published", "paused", "closed", "expired"],
    rejected: ["rejected"],
    expired: ["expired"],
    removed: ["removed"],
  };
  if (!expected[kind].includes(row.status)) return skip("state_mismatch");
  if (!row.createdBy) return skip("no_creator");
  if (!(await isOrganizationMember(deps.db, row.organizationId, row.createdBy)))
    return skip("not_member");
  const to = await getNotificationAddress(deps.db, row.createdBy);
  if (!to) return skip("no_address");
  let reason: string | null = null;
  if (kind === "rejected" || kind === "removed") {
    const [decision] = await deps.db
      .select({ reasonCode: jobModerationDecision.reasonCode })
      .from(jobModerationDecision)
      .where(eq(jobModerationDecision.jobId, jobId))
      .orderBy(desc(jobModerationDecision.decidedAt))
      .limit(1);
    reason = decision?.reasonCode ?? null;
  }
  await deps.emailSender.send(
    renderJobEmail(kind, {
      to,
      locale: "ar",
      appUrl: deps.appUrl,
      jobId,
      title: row.title,
      rejectionReason: reason,
    }),
  );
  deps.logger.info({ event: "jobs.notice_sent", jobId, kind });
  return "sent";
}

/**
 * Daily: published and paused jobs past `expires_at` become `expired`, with
 * a history row and an email job each, in one transaction per batch.
 * Idempotent: an already expired job is not selected again.
 */
export async function expireJobs(
  deps: { db: Db; boss: PgBoss; logger: Logger },
  now: Date = new Date(),
): Promise<number> {
  let total = 0;
  for (;;) {
    const done = await deps.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: job.id, status: job.status })
        .from(job)
        .where(
          and(
            inArray(job.status, ["published", "paused"]),
            lte(job.expiresAt, now),
          ),
        )
        .limit(200)
        .for("update", { skipLocked: true });
      if (due.length === 0) return 0;
      await tx
        .update(job)
        .set({ status: "expired", updatedAt: now })
        .where(
          inArray(
            job.id,
            due.map((d) => d.id),
          ),
        );
      await tx.insert(jobEvent).values(
        due.map((d) => ({
          jobId: d.id,
          actorId: null,
          fromStatus: d.status as "published" | "paused",
          toStatus: "expired" as const,
          at: now,
        })),
      );
      for (const d of due)
        await enqueue(
          deps.boss,
          "jobs.notify",
          { jobId: d.id, kind: "expired" },
          { tx },
        );
      return due.length;
    });
    total += done;
    if (done === 0) break;
  }
  deps.logger.info({ event: "jobs.expired", count: total });
  return total;
}

/**
 * Emails the applicant that their application was shortlisted, accepted or
 * rejected (ADR-007). Skips when the application is gone, its status no
 * longer matches, or the applicant's verified address is gone. No employer
 * notes exist to leak; the email names the job and the organization's
 * status change only.
 */
export async function sendApplicationNotice(
  deps: JobNoticeDeps,
  applicationId: string,
  kind: ApplicationNoticeKind,
): Promise<"sent" | "skipped"> {
  const [row] = await deps.db
    .select({
      applicantId: jobApplication.applicantId,
      status: jobApplication.status,
      title: job.title,
      jobStatus: job.status,
    })
    .from(jobApplication)
    .innerJoin(job, eq(job.id, jobApplication.jobId))
    .where(eq(jobApplication.id, applicationId))
    .limit(1);
  const skip = (reason: string) => {
    deps.logger.info({
      event: "applications.notice_skipped",
      applicationId,
      kind,
      reason,
    });
    return "skipped" as const;
  };
  if (!row) return skip("application_missing");
  // A takedown notice goes to applications the employer could still move.
  const current =
    kind === "job_removed"
      ? row.jobStatus === "removed" &&
        !["accepted", "rejected", "withdrawn"].includes(row.status)
      : row.status === kind;
  if (!current) return skip("state_mismatch");
  const to = await getNotificationAddress(deps.db, row.applicantId);
  if (!to) return skip("no_address");
  const catalog = catalogs.ar;
  const strings = catalog.ApplicationEmail[kind];
  await deps.emailSender.send(
    renderEmail(
      {
        subject: fill(strings.subject, { title: row.title }),
        heading: strings.heading,
        paragraphs: [fill(strings.body, { title: row.title })],
        action: {
          label: catalog.ApplicationEmail.action,
          url: `${deps.appUrl}/applications`,
        },
        note: catalog.ApplicationEmail.note,
      },
      { to, locale: "ar" },
    ),
  );
  deps.logger.info({ event: "applications.notice_sent", applicationId, kind });
  return "sent";
}
