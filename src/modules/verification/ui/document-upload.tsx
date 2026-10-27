"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { formatCount } from "@/shared/i18n/format";
import { isRejectReason } from "@/modules/uploads/constants";

// One photo for a verification document: uploads it to POST /api/uploads with
// progress, then polls GET /api/uploads/<id> until the worker has scanned and
// re-encoded it. Only a `clean` upload fills the hidden input the form submits;
// the server checks ownership and status again on submit.

type State =
  | { phase: "idle" }
  | { phase: "uploading"; percent: number }
  | { phase: "processing"; id: string }
  | { phase: "clean"; id: string }
  | { phase: "rejected"; reason: string }
  | { phase: "error"; code: string };

const POLL_MS = 2000;
/** Stop polling after about five minutes; the worker may be down. */
const POLL_LIMIT = 150;

function uploadFile(
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("purpose", "verification_document");
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        body: (xhr.response ?? {}) as Record<string, unknown>,
      });
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(form);
  });
}

export function DocumentUpload({
  kind,
  label,
  hint,
  serverError,
}: {
  kind: string;
  label: string;
  hint: string;
  /** Localized error from the last submit, if the server refused this photo. */
  serverError?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Verification");
  const tu = useTranslations("UploadErrors");
  const ts = useTranslations("UploadStatus");
  const id = useId();
  const [state, setState] = useState<State>({ phase: "idle" });
  const polls = useRef(0);

  useEffect(() => {
    if (state.phase !== "processing") return;
    const uploadId = state.id;
    const timer = setTimeout(async () => {
      polls.current += 1;
      try {
        const response = await fetch(`/api/uploads/${uploadId}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          status?: string;
          rejectReason?: string | null;
          error?: string;
        };
        if (!response.ok)
          setState({ phase: "error", code: body.error ?? "unavailable" });
        else if (body.status === "clean")
          setState({ phase: "clean", id: uploadId });
        else if (body.status === "rejected")
          setState({
            phase: "rejected",
            reason: isRejectReason(body.rejectReason)
              ? body.rejectReason
              : "processing_failed",
          });
        else if (polls.current >= POLL_LIMIT)
          setState({ phase: "error", code: "stillProcessing" });
        else setState({ phase: "processing", id: uploadId });
      } catch {
        setState({ phase: "error", code: "network" });
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    polls.current = 0;
    setState({ phase: "uploading", percent: 0 });
    try {
      const result = await uploadFile(file, (percent) =>
        setState({ phase: "uploading", percent }),
      );
      if (result.status === 202 && typeof result.body.id === "string")
        setState({ phase: "processing", id: result.body.id });
      else
        setState({
          phase: "error",
          code:
            typeof result.body.error === "string"
              ? result.body.error
              : "unavailable",
        });
    } catch {
      setState({ phase: "error", code: "network" });
    }
    // Lets the same file be chosen again after an error.
    event.target.value = "";
  }

  let message: string | null = null;
  let tone: "info" | "ok" | "error" = "info";
  switch (state.phase) {
    case "uploading":
      message = t("uploadProgress", {
        percent: formatCount(state.percent, locale),
      });
      break;
    case "processing":
      message = ts("processing");
      break;
    case "clean":
      message = t("uploadReady");
      tone = "ok";
      break;
    case "rejected":
      message = ts(`rejected.${state.reason}`);
      tone = "error";
      break;
    case "error":
      message =
        state.code === "network" || state.code === "stillProcessing"
          ? t(`upload_${state.code}`)
          : tu(state.code);
      tone = "error";
      break;
  }
  const error = tone === "error" ? message : (serverError ?? null);
  const busy = state.phase === "uploading" || state.phase === "processing";

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-muted p-3"
      data-testid={`document-${kind}`}
      data-state={state.phase}
    >
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-sm text-muted">
        {hint}
      </p>
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={onChange}
        disabled={busy}
        aria-describedby={`${id}-hint ${id}-status`}
        aria-invalid={error ? true : undefined}
        className="min-h-11 w-full text-base file:me-3 file:min-h-11 file:rounded-lg file:border file:border-primary file:bg-surface file:px-4 file:font-semibold file:text-primary"
      />
      <input
        type="hidden"
        name={kind}
        value={state.phase === "clean" ? state.id : ""}
      />
      <div id={`${id}-status`} aria-live="polite">
        {state.phase === "uploading" ? (
          <progress
            max={100}
            value={state.percent}
            className="h-2 w-full accent-primary"
            aria-label={label}
          />
        ) : null}
        {message && tone !== "error" ? (
          <p
            className={
              tone === "ok"
                ? "font-semibold text-primary-strong"
                : "text-sm text-muted"
            }
          >
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
