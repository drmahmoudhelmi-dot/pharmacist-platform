"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/shared/ui/form";
import { type AuthErrorKey, authPost } from "./auth-client";
import { checkEmail } from "./validation";

export function ForgotPasswordForm() {
  const t = useTranslations("ForgotPassword");
  const tc = useTranslations("Common");
  const te = useTranslations("AuthErrors");
  const locale = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [sent, setSent] = useState(false);
  const [fieldError, setFieldError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const issue = checkEmail(email);
    setFieldError(issue ? tc(issue) : undefined);
    if (issue) return;
    setPending(true);
    setError(null);
    setSent(false);
    // Same answer whether or not the email is registered.
    const result = await authPost(
      "/request-password-reset",
      { email: email.trim() },
      locale,
    );
    setPending(false);
    if (result.ok) setSent(true);
    else setError(result.error);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-muted">{t("intro")}</p>
      <TextField
        name="email"
        type="email"
        label={tc("emailLabel")}
        autoComplete="email"
        inputMode="email"
        error={fieldError}
      />
      <FormStatus
        error={error ? te(error) : null}
        success={sent ? t("sent") : null}
      />
      <SubmitButton
        pending={pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
      />
    </form>
  );
}
