"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/shared/ui/form";
import { Link, useRouter } from "@/shared/i18n/navigation";
import { type AuthErrorKey, authPost } from "./auth-client";
import { checkPassword, PASSWORD_MAX } from "./validation";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("ResetPassword");
  const tc = useTranslations("Common");
  const te = useTranslations("AuthErrors");
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [fieldError, setFieldError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newPassword = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    const issue = checkPassword(newPassword);
    setFieldError(issue ? tc(issue) : undefined);
    if (issue) return;
    setPending(true);
    setError(null);
    const result = await authPost(
      "/reset-password",
      { token, newPassword },
      locale,
    );
    if (result.ok) {
      router.push({
        pathname: "/sign-in",
        query: { notice: "password_reset" },
      });
      return;
    }
    setPending(false);
    setError(result.error);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-muted">{t("intro")}</p>
      <TextField
        name="password"
        type="password"
        label={t("newPasswordLabel")}
        autoComplete="new-password"
        hint={tc("passwordHint")}
        maxLength={PASSWORD_MAX}
        error={fieldError}
      />
      <FormStatus error={error ? te(error) : null} />
      {error === "invalidToken" ? (
        <Link
          href="/forgot-password"
          className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
        >
          {t("requestNew")}
        </Link>
      ) : null}
      <SubmitButton
        pending={pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
      />
    </form>
  );
}
