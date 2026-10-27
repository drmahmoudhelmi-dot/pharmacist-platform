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
import { checkEmail, normalizeCode, PASSWORD_MAX } from "./validation";

type Step = "password" | "totp" | "backup";

export function SignInForm() {
  const t = useTranslations("SignIn");
  const tc = useTranslations("Common");
  const te = useTranslations("AuthErrors");
  const locale = useLocale();
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    code?: string;
  }>({});

  function finish() {
    setSuccess(true);
    router.push("/account");
    router.refresh();
  }

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const emailIssue = checkEmail(email);
    const errors = {
      email: emailIssue ? tc(emailIssue) : undefined,
      password: password ? undefined : tc("required"),
    };
    setFieldErrors(errors);
    if (errors.email || errors.password) return;

    setPending(true);
    setError(null);
    const result = await authPost<{ twoFactorRedirect?: boolean }>(
      "/sign-in/email",
      { email, password, rememberMe: true },
      locale,
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.data?.twoFactorRedirect) {
      // Password accepted; the session is created only after the second step.
      setStep("totp");
      return;
    }
    finish();
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get("code") ?? "");
    const code = step === "totp" ? normalizeCode(raw) : raw.trim();
    setFieldErrors({ code: code ? undefined : tc("required") });
    if (!code) return;
    setPending(true);
    setError(null);
    const result = await authPost(
      step === "totp"
        ? "/two-factor/verify-totp"
        : "/two-factor/verify-backup-code",
      { code },
      locale,
    );
    if (result.ok) {
      finish();
      return;
    }
    setPending(false);
    setError(result.error);
    if (
      result.error === "twoFactorExpired" ||
      result.error === "twoFactorTooManyAttempts" ||
      result.error === "accountSuspended"
    ) {
      setStep("password");
    }
  }

  if (step === "password") {
    return (
      <form noValidate onSubmit={onPassword} className="flex flex-col gap-4">
        <TextField
          name="email"
          type="email"
          label={tc("emailLabel")}
          autoComplete="email"
          inputMode="email"
          error={fieldErrors.email}
        />
        <TextField
          name="password"
          type="password"
          label={tc("passwordLabel")}
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          error={fieldErrors.password}
        />
        <FormStatus
          error={error ? te(error) : null}
          success={success ? t("success") : null}
        />
        <SubmitButton
          pending={pending || success}
          label={t("submit")}
          pendingLabel={t("submitting")}
        />
      </form>
    );
  }

  return (
    <form noValidate onSubmit={onCode} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-ink">{t("totpTitle")}</h2>
      {step === "totp" ? <p className="text-muted">{t("totpIntro")}</p> : null}
      <TextField
        key={step}
        name="code"
        label={step === "totp" ? t("codeLabel") : t("backupCodeLabel")}
        autoComplete="one-time-code"
        inputMode={step === "totp" ? "numeric" : "text"}
        maxLength={step === "totp" ? 12 : 32}
        error={fieldErrors.code}
      />
      <FormStatus
        error={error ? te(error) : null}
        success={success ? t("success") : null}
      />
      <SubmitButton
        pending={pending || success}
        label={t("verify")}
        pendingLabel={t("verifying")}
      />
      <SecondaryButton
        onClick={() => {
          setError(null);
          setStep(step === "totp" ? "backup" : "totp");
        }}
      >
        {step === "totp" ? t("useBackupCode") : t("useTotp")}
      </SecondaryButton>
    </form>
  );
}
