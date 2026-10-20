import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import type { EmailMessage } from "./sender";

export type EmailLocale = "ar" | "en";
export type AuthEmailKind = "verification" | "passwordReset" | "accountExists";

const catalogs = { ar: ar.Email, en: en.Email } as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Unknown or missing locale falls back to Arabic, the product default. */
export function toEmailLocale(value: unknown): EmailLocale {
  return value === "en" ? "en" : "ar";
}

/**
 * Renders one of the auth emails. Strings come from messages/<locale>.json
 * (namespace "Email"). The link is only placed in the body; callers must not
 * log the returned message.
 */
export function renderAuthEmail(
  kind: AuthEmailKind,
  input: { to: string; url: string; locale: EmailLocale },
): EmailMessage {
  const catalog = catalogs[input.locale];
  const strings = catalog[kind];
  const dir = input.locale === "ar" ? "rtl" : "ltr";

  const text = [
    strings.heading,
    "",
    strings.body,
    "",
    `${strings.action}: ${input.url}`,
    "",
    strings.ignore,
    "",
    "--",
    catalog.footer,
  ].join("\n");

  const url = escapeHtml(input.url);
  const html = `<!doctype html>
<html lang="${input.locale}" dir="${dir}">
<head><meta charset="utf-8"><title>${escapeHtml(strings.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:Tahoma,Arial,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border-radius:12px;text-align:start;" dir="${dir}">
<p style="margin:0 0 8px;color:#475569;">${escapeHtml(catalog.productName)}</p>
<h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(strings.heading)}</h1>
<p style="margin:0 0 24px;line-height:1.7;">${escapeHtml(strings.body)}</p>
<p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">${escapeHtml(strings.action)}</a></p>
<p style="margin:0 0 24px;line-height:1.7;font-size:14px;color:#475569;" dir="ltr">${url}</p>
<p style="margin:0 0 16px;line-height:1.7;font-size:14px;color:#475569;">${escapeHtml(strings.ignore)}</p>
<p style="margin:0;font-size:12px;color:#475569;">${escapeHtml(catalog.footer)}</p>
</div>
</body>
</html>`;

  return {
    to: input.to,
    subject: strings.subject,
    text,
    html,
    language: input.locale,
  };
}
