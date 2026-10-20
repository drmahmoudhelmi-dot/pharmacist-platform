"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/shared/ui/form";
import { useRouter } from "@/shared/i18n/navigation";
import { type AuthErrorKey, authPost } from "./auth-client";
import { checkEmail, checkPassword, PASSWORD_MAX } from "./validation";

export function SignUpForm() {
  const t = useTranslations("SignUp");
  const tc = useTranslations("Common");
  const te = useTranslations("AuthErrors");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const emailIssue = checkEmail(email);
    const passwordIssue = checkPassword(password);
    setFieldErrors({
      email: emailIssue ? tc(emailIssue) : undefined,
      password: passwordIssue ? tc(passwordIssue) : undefined,
    });
    if (emailIssue || passwordIssue) return;

    setPending(true);
    setError(null);
    // The response is the same for new and already-registered emails.
    const result = await authPost(
      "/sign-up/email",
      {
        email,
        password,
        name: "",
      },
      locale,
    );
    if (result.ok) {
      router.push("/check-email");
      return;
    }
    setPending(false);
    setError(result.error);
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
        error={fieldErrors.email}
      />
      <TextField
        name="password"
        type="password"
        label={tc("passwordLabel")}
        autoComplete="new-password"
        hint={tc("passwordHint")}
        maxLength={PASSWORD_MAX}
        error={fieldErrors.password}
      />
      <FormStatus error={error ? te(error) : null} />
      <SubmitButton
        pending={pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
      />
    </form>
  );
}
