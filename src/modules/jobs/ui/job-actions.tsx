"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import { FormStatus, SecondaryButton } from "@/shared/ui/form";
import {
  closeJobAction,
  copyJobAction,
  deleteJobAction,
  pauseJobAction,
  resumeJobAction,
  submitJobAction,
} from "../actions";
import type { JobPermissions } from "../service";
import { useWrite } from "./use-write";

type Confirming = "close" | "delete" | null;

/**
 * Lifecycle buttons for a member who manages the job. Only the actions the
 * server says are allowed are shown; the server checks again on every call.
 * Closing and deleting ask first.
 */
export function JobActions({
  jobId,
  organizationId,
  permissions,
}: {
  jobId: string;
  organizationId: string;
  permissions: JobPermissions;
}) {
  const t = useTranslations("Jobs");
  const router = useRouter();
  const write = useWrite<"startDate" | "endDate", Record<string, unknown>>();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const busy = write.pending;

  async function submit() {
    await write.submit(
      null,
      () => submitJobAction(jobId),
      (result) => t(`submitted.${String(result.status)}`),
    );
  }

  async function resume() {
    await write.submit(
      null,
      () => resumeJobAction(jobId),
      (result) =>
        result.status === "expired" ? t("resumedExpired") : t("resumed"),
    );
  }

  async function copy() {
    const result = await write.submit(
      null,
      () => copyJobAction(jobId),
      t("copied"),
    );
    if (result?.ok && typeof result.jobId === "string")
      router.push(`/manage/jobs/${result.jobId}`);
  }

  async function remove() {
    const result = await write.submit(
      null,
      () => deleteJobAction(jobId),
      t("deleted"),
    );
    if (result?.ok) router.push(`/organizations/${organizationId}/jobs`);
  }

  async function close() {
    setConfirming(null);
    await write.submit(null, () => closeJobAction(jobId), t("closed"));
  }

  return (
    <div className="flex flex-col gap-3" data-testid="job-actions">
      <div className="flex flex-wrap gap-2">
        {permissions.submit ? (
          <SecondaryButton onClick={submit} disabled={busy}>
            {t("submit")}
          </SecondaryButton>
        ) : null}
        {permissions.pause ? (
          <SecondaryButton
            onClick={() =>
              void write.submit(null, () => pauseJobAction(jobId), t("paused"))
            }
            disabled={busy}
          >
            {t("pause")}
          </SecondaryButton>
        ) : null}
        {permissions.resume ? (
          <SecondaryButton onClick={resume} disabled={busy}>
            {t("resume")}
          </SecondaryButton>
        ) : null}
        {permissions.copy ? (
          <SecondaryButton onClick={copy} disabled={busy}>
            {t("copy")}
          </SecondaryButton>
        ) : null}
        {permissions.close && confirming !== "close" ? (
          <SecondaryButton
            tone="danger"
            onClick={() => setConfirming("close")}
            disabled={busy}
          >
            {t("close")}
          </SecondaryButton>
        ) : null}
        {permissions.delete && confirming !== "delete" ? (
          <SecondaryButton
            tone="danger"
            onClick={() => setConfirming("delete")}
            disabled={busy}
          >
            {t("delete")}
          </SecondaryButton>
        ) : null}
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2" role="group">
          <p>
            {confirming === "close" ? t("closeConfirm") : t("deleteConfirm")}
          </p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              tone="danger"
              disabled={busy}
              onClick={confirming === "close" ? close : remove}
            >
              {confirming === "close" ? t("confirmClose") : t("confirmDelete")}
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(null)}>
              {t("cancel")}
            </SecondaryButton>
          </div>
        </div>
      ) : null}
      <FormStatus
        error={
          write.error
            ? // A temporary period that has started since: say which date.
              [
                write.error,
                write.fieldError("startDate") ?? write.fieldError("endDate"),
              ]
                .filter(Boolean)
                .join(" ")
            : null
        }
        success={write.success}
      />
    </div>
  );
}
