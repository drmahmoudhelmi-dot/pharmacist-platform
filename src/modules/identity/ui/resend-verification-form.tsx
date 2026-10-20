"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/shared/ui/form";
import { type AuthErrorKey, authPost } from "./auth-client";
import { checkEmail } from "./validation";

export function ResendVerificationForm() {
  const t = useTranslations("CheckEmail");
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
    const result = await authPost(
      "/send-verification-email",
      { email: email.trim() },
      locale,
    );
    setPending(false);
    if (result.ok) setSent(true);
    else setError(result.error);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-ink">{t("resendTitle")}</h2>
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
        success={sent ? t("resent") : null}
      />
      <SubmitButton
        pending={pending}
        label={t("resendSubmit")}
        pendingLabel={t("resending")}
      />
    </form>
  );
}
