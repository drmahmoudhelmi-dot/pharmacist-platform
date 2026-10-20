import type { Logger } from "pino";
import type { EmailSender } from "@/shared/email/sender";
import {
  type AuthEmailKind,
  renderAuthEmail,
  toEmailLocale,
} from "@/shared/email/templates";

// Header the app's auth client sends so emails use the page's language.
export const LOCALE_HEADER = "x-app-locale";

export type AuthEmailDeps = {
  emailSender: EmailSender;
  logger: Logger;
  /** Public origin without a trailing slash. */
  appUrl: string;
};

function localePath(locale: "ar" | "en", path: string): string {
  // Arabic is the default locale and has no prefix (localePrefix "as-needed").
  return locale === "ar" ? path : `/en${path}`;
}

/**
 * Renders and sends an auth email without awaiting SMTP. The HTTP response
 * then takes the same time whether or not the address is registered (no
 * timing oracle), and a mail outage reveals nothing either. Logs carry the
 * user id and email kind only, never the address, link or token. Moves to the
 * outbox when the worker exists (ADR-002, "Revisit when").
 */
export function dispatchAuthEmail(
  deps: AuthEmailDeps,
  kind: AuthEmailKind,
  user: { id: string; email: string },
  path: string,
  params: Record<string, string>,
  request: Request | undefined,
): void {
  const locale = toEmailLocale(request?.headers.get(LOCALE_HEADER));
  const query = new URLSearchParams(params).toString();
  const url = `${deps.appUrl}${localePath(locale, path)}${query ? `?${query}` : ""}`;
  const message = renderAuthEmail(kind, { to: user.email, url, locale });
  let sending: Promise<void>;
  try {
    sending = deps.emailSender.send(message);
  } catch (error) {
    sending = Promise.reject(error);
  }
  sending.then(
    () => deps.logger.info({ event: "auth.email.sent", kind, userId: user.id }),
    (error: unknown) =>
      deps.logger.error(
        {
          event: "auth.email.failed",
          kind,
          userId: user.id,
          errName: error instanceof Error ? error.name : "unknown",
        },
        "auth email could not be sent",
      ),
  );
}
