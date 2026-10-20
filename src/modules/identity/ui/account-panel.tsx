"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import {
  FormStatus,
  SecondaryButton,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import { useRouter } from "@/shared/i18n/navigation";
import { type AuthErrorKey, authPost } from "./auth-client";
import { normalizeCode, PASSWORD_MAX } from "./validation";

type Setup = { uri: string; secret: string; backupCodes: string[] };

type Mode =
  | { name: "idle" }
  | { name: "enablePassword" }
  | { name: "setup"; setup: Setup }
  | { name: "disablePassword" };

/** Splits the base32 key into groups of four for manual entry. */
function formatSecret(uri: string): string {
  let secret = "";
  try {
    secret = new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    secret = "";
  }
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const t = useTranslations("Account");
  const te = useTranslations("AuthErrors");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ name: "idle" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string>();

  function reset(next: Mode) {
    setMode(next);
    setError(null);
    setFieldError(undefined);
  }

  async function onEnablePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    setFieldError(password ? undefined : tc("required"));
    if (!password) return;
    setPending(true);
    setError(null);
    const result = await authPost<{ totpURI: string; backupCodes: string[] }>(
      "/two-factor/enable",
      { password },
      locale,
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset({
      name: "setup",
      setup: {
        uri: result.data.totpURI,
        secret: formatSecret(result.data.totpURI),
        backupCodes: result.data.backupCodes,
      },
    });
  }

  async function onConfirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = normalizeCode(
      String(new FormData(event.currentTarget).get("code") ?? ""),
    );
    setFieldError(code ? undefined : tc("required"));
    if (!code) return;
    setPending(true);
    setError(null);
    const result = await authPost("/two-factor/verify-totp", { code }, locale);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset({ name: "idle" });
    setSuccess(t("notices.totp_enabled"));
    router.refresh();
  }

  async function onDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    setFieldError(password ? undefined : tc("required"));
    if (!password) return;
    setPending(true);
    setError(null);
    const result = await authPost("/two-factor/disable", { password }, locale);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reset({ name: "idle" });
    setSuccess(t("notices.totp_disabled"));
    router.refresh();
  }

  const status = (
    <FormStatus error={error ? te(error) : null} success={success} />
  );

  if (mode.name === "enablePassword" || mode.name === "disablePassword") {
    const enabling = mode.name === "enablePassword";
    return (
      <form
        noValidate
        onSubmit={enabling ? onEnablePassword : onDisable}
        className="flex flex-col gap-4"
      >
        <TextField
          name="password"
          type="password"
          label={t("confirmPasswordLabel")}
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          error={fieldError}
        />
        {status}
        <SubmitButton
          pending={pending}
          label={enabling ? t("continue") : t("confirmDisable")}
          pendingLabel={t("working")}
        />
        <SecondaryButton onClick={() => reset({ name: "idle" })}>
          {t("cancel")}
        </SecondaryButton>
      </form>
    );
  }

  if (mode.name === "setup") {
    const { setup } = mode;
    return (
      <div className="flex flex-col gap-4">
        <p>{t("setupStep1")}</p>
        <a
          href={setup.uri}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary px-5 font-semibold text-primary"
        >
          {t("openInApp")}
        </a>
        <div className="flex flex-col gap-1">
          <span className="font-semibold">{t("secretLabel")}</span>
          <code
            dir="ltr"
            className="break-all rounded-lg bg-canvas p-3 text-start font-mono text-lg"
            data-testid="totp-secret"
          >
            {setup.secret}
          </code>
        </div>
        <details>
          <summary className="min-h-11 cursor-pointer py-2 font-semibold">
            {t("uriLabel")}
          </summary>
          <code
            dir="ltr"
            className="block break-all rounded-lg bg-canvas p-3 text-start font-mono text-sm"
          >
            {setup.uri}
          </code>
        </details>
        <p>{t("setupStep2")}</p>
        <div className="flex flex-col gap-1">
          <span className="font-semibold">{t("backupCodesLabel")}</span>
          <ul
            dir="ltr"
            className="grid grid-cols-2 gap-2 rounded-lg bg-canvas p-3 font-mono"
            data-testid="backup-codes"
          >
            {setup.backupCodes.map((code) => (
              <li key={code} className="text-start">
                {code}
              </li>
            ))}
          </ul>
        </div>
        <form
          noValidate
          onSubmit={onConfirmCode}
          className="flex flex-col gap-4"
        >
          <p>{t("setupStep3")}</p>
          <TextField
            name="code"
            label={t("codeLabel")}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={12}
            error={fieldError}
          />
          {status}
          <SubmitButton
            pending={pending}
            label={t("confirmEnable")}
            pendingLabel={t("working")}
          />
          <SecondaryButton onClick={() => reset({ name: "idle" })}>
            {t("cancel")}
          </SecondaryButton>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {status}
      <SecondaryButton
        onClick={() => {
          setSuccess(null);
          reset({ name: enabled ? "disablePassword" : "enablePassword" });
        }}
      >
        {enabled ? t("disableStart") : t("enableStart")}
      </SecondaryButton>
    </div>
  );
}

export function SessionActions() {
  const t = useTranslations("Account");
  const te = useTranslations("AuthErrors");
  const locale = useLocale();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);

  async function run(path: "/sign-out" | "/revoke-sessions") {
    setPending(true);
    setError(null);
    const result = await authPost(path, {}, locale);
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    router.push({ pathname: "/sign-in", query: { notice: "signed_out" } });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <FormStatus error={error ? te(error) : null} />
      <SecondaryButton disabled={pending} onClick={() => run("/sign-out")}>
        {t("signOut")}
      </SecondaryButton>
      {confirming ? (
        <div className="flex flex-col gap-3 rounded-lg border border-red-700 p-3">
          <p>{t("signOutEverywhereConfirm")}</p>
          <SecondaryButton
            disabled={pending}
            onClick={() => run("/revoke-sessions")}
          >
            {t("confirm")}
          </SecondaryButton>
          <SecondaryButton
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            {t("cancel")}
          </SecondaryButton>
        </div>
      ) : (
        <SecondaryButton disabled={pending} onClick={() => setConfirming(true)}>
          {t("signOutEverywhere")}
        </SecondaryButton>
      )}
    </div>
  );
}
