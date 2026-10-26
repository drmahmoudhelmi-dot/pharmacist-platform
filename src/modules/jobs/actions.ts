"use server";

import { headers } from "next/headers";
import { auditIp } from "@/modules/admin/audit";
import { requireActor } from "@/modules/identity/policy";
import { getDb } from "@/shared/db/client";
import { getJobClient } from "@/shared/jobs/client";
import { logger } from "@/shared/logging/logger";
import {
  type ApplicationResult,
  type ApplicationsDeps,
  applyToJob,
  moveApplication,
  withdrawApplication,
} from "./applications";
import {
  closeJob,
  copyJob,
  createJob,
  decideJob,
  deleteJob,
  type JobsDeps,
  pauseJob,
  resumeJob,
  submitJob,
  updateJob,
  type WriteResult,
} from "./service";
import {
  type ApplicationField,
  type DecisionField,
  formDataToRaw,
  isUuid,
  type JobField,
} from "./validation";

// Server actions for the job pages. Each resolves the caller from the session
// and passes only ids and form fields to the service, which loads the
// caller's role, applies the policy and validates. Results are plain codes;
// the UI maps them to messages. Logs carry ids only, never form values.

export type ActionResult<K extends string = never, T = object> =
  WriteResult<K, T> | { ok: false; error: "generic" };

const log = logger.child({ module: "jobs" });

async function deps(): Promise<JobsDeps> {
  return { db: getDb(), boss: await getJobClient() };
}

async function run<K extends string, T>(
  name: string,
  ids: { userId: string; organizationId?: unknown; jobId?: unknown },
  work: () => Promise<WriteResult<K, T>>,
): Promise<ActionResult<K, T>> {
  // Client-supplied: logged only when it is a well-formed id.
  const organizationId = isUuid(ids.organizationId)
    ? ids.organizationId
    : undefined;
  const jobId = isUuid(ids.jobId) ? ids.jobId : undefined;
  try {
    const result = await work();
    if (result.ok)
      log.info({
        event: `jobs.${name}`,
        userId: ids.userId,
        organizationId,
        jobId,
      });
    return result;
  } catch (error) {
    log.error(
      {
        event: `jobs.${name}.failed`,
        userId: ids.userId,
        organizationId,
        jobId,
        errName: error instanceof Error ? error.name : undefined,
      },
      "job write failed",
    );
    return { ok: false, error: "generic" };
  }
}

export type ApplicationActionResult<K extends string = never, T = object> =
  ApplicationResult<K, T> | { ok: false; error: "generic" };

async function applicationDeps(): Promise<ApplicationsDeps> {
  return { db: getDb(), boss: await getJobClient() };
}

async function runApplication<K extends string, T>(
  name: string,
  ids: { userId: string; jobId?: unknown; applicationId?: unknown },
  work: () => Promise<ApplicationResult<K, T>>,
): Promise<ApplicationActionResult<K, T>> {
  // Client-supplied: logged only when it is a well-formed id.
  const jobId = isUuid(ids.jobId) ? ids.jobId : undefined;
  const applicationId = isUuid(ids.applicationId)
    ? ids.applicationId
    : undefined;
  try {
    const result = await work();
    if (result.ok)
      log.info({
        event: `applications.${name}`,
        userId: ids.userId,
        jobId,
        applicationId,
      });
    return result;
  } catch (error) {
    log.error(
      {
        event: `applications.${name}.failed`,
        userId: ids.userId,
        jobId,
        applicationId,
        errName: error instanceof Error ? error.name : undefined,
      },
      "application write failed",
    );
    return { ok: false, error: "generic" };
  }
}

export async function createJobAction(
  organizationId: string,
  form: FormData,
): Promise<ActionResult<JobField, { jobId: string }>> {
  const actor = await requireActor();
  return run("created", { userId: actor.userId, organizationId }, async () =>
    createJob(await deps(), actor, organizationId, formDataToRaw(form)),
  );
}

export async function updateJobAction(
  jobId: string,
  form: FormData,
): Promise<ActionResult<JobField>> {
  const actor = await requireActor();
  return run("updated", { userId: actor.userId, jobId }, async () =>
    updateJob(await deps(), actor, jobId, formDataToRaw(form)),
  );
}

export async function deleteJobAction(jobId: string): Promise<ActionResult> {
  const actor = await requireActor();
  return run("deleted", { userId: actor.userId, jobId }, async () =>
    deleteJob(await deps(), actor, jobId),
  );
}

export async function submitJobAction(
  jobId: string,
): Promise<
  ActionResult<
    "startDate" | "endDate",
    { status: "pending_review" | "published" }
  >
> {
  const actor = await requireActor();
  return run("submitted", { userId: actor.userId, jobId }, async () =>
    submitJob(await deps(), actor, jobId),
  );
}

export async function pauseJobAction(jobId: string): Promise<ActionResult> {
  const actor = await requireActor();
  return run("paused", { userId: actor.userId, jobId }, async () =>
    pauseJob(await deps(), actor, jobId),
  );
}

export async function resumeJobAction(
  jobId: string,
): Promise<ActionResult<never, { status: "published" | "expired" }>> {
  const actor = await requireActor();
  return run("resumed", { userId: actor.userId, jobId }, async () =>
    resumeJob(await deps(), actor, jobId),
  );
}

export async function closeJobAction(jobId: string): Promise<ActionResult> {
  const actor = await requireActor();
  return run("closed", { userId: actor.userId, jobId }, async () =>
    closeJob(await deps(), actor, jobId),
  );
}

export async function copyJobAction(
  jobId: string,
): Promise<ActionResult<never, { jobId: string }>> {
  const actor = await requireActor();
  return run("copied", { userId: actor.userId, jobId }, async () =>
    copyJob(await deps(), actor, jobId),
  );
}

export async function decideJobAction(
  jobId: string,
  form: FormData,
): Promise<ActionResult<DecisionField>> {
  const actor = await requireActor();
  return run("decided", { userId: actor.userId, jobId }, async () =>
    decideJob(
      await deps(),
      actor,
      jobId,
      formDataToRaw(form),
      auditIp((await headers()).get("x-forwarded-for")),
    ),
  );
}

export async function applyToJobAction(
  jobId: string,
  form: FormData,
): Promise<
  ApplicationActionResult<ApplicationField, { applicationId: string }>
> {
  const actor = await requireActor();
  return runApplication("applied", { userId: actor.userId, jobId }, async () =>
    applyToJob(await applicationDeps(), actor, jobId, formDataToRaw(form)),
  );
}

export async function withdrawApplicationAction(
  applicationId: string,
): Promise<ApplicationActionResult> {
  const actor = await requireActor();
  return runApplication(
    "withdrawn",
    { userId: actor.userId, applicationId },
    async () =>
      withdrawApplication(await applicationDeps(), actor, applicationId),
  );
}

export async function moveApplicationAction(
  applicationId: string,
  to: string,
): Promise<ApplicationActionResult> {
  const actor = await requireActor();
  return runApplication(
    "moved",
    { userId: actor.userId, applicationId },
    async () =>
      moveApplication(await applicationDeps(), actor, applicationId, to),
  );
}
