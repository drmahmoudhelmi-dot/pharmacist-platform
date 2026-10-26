import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { AUDIT_ACTIONS, TARGET_TYPES } from "@/modules/admin/constants";
import { searchAudit } from "@/modules/admin/service";
import { requireStaff } from "@/modules/identity/policy";
import { isStaffRole } from "@/modules/identity/roles";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { SelectField, TextField } from "@/shared/ui/form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DETAIL_KEYS = ["role", "decision", "reasonCode"] as const;

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.slice(0, 254) || undefined;

// The admin audit log (ADR-008): read-only, newest first, for super admins.
export default async function StaffAuditPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("super_admin");
  const sp = await searchParams;
  const filters = {
    action: first(sp.action),
    targetType: first(sp.targetType),
    targetId: first(sp.targetId),
    actorEmail: first(sp.actorEmail),
  };
  const page = await searchAudit(getDb(), actor, {
    ...filters,
    cursor: first(sp.cursor),
  });
  const t = await getTranslations("StaffAudit");
  const ta = await getTranslations("AuditActions");
  const tk = await getTranslations("AuditActorKinds");
  const tt = await getTranslations("AuditTargetTypes");
  const td = await getTranslations("AuditDetailKeys");
  const tr = await getTranslations("Roles");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "medium", timeZone: "Africa/Cairo" },
  );
  const query = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      <form
        method="get"
        className="flex flex-col gap-4"
        data-testid="audit-filter"
      >
        <SelectField
          name="action"
          label={t("filterAction")}
          placeholder={t("any")}
          required={false}
          defaultValue={filters.action}
          options={AUDIT_ACTIONS.map((a) => ({
            value: a,
            label: ta(a.replace(".", "_")),
          }))}
        />
        <SelectField
          name="targetType"
          label={t("filterTargetType")}
          placeholder={t("any")}
          required={false}
          defaultValue={filters.targetType}
          options={TARGET_TYPES.map((x) => ({ value: x, label: tt(x) }))}
        />
        <TextField
          name="targetId"
          label={t("filterTargetId")}
          required={false}
          maxLength={36}
          defaultValue={filters.targetId}
        />
        <TextField
          name="actorEmail"
          type="email"
          label={t("filterActorEmail")}
          required={false}
          maxLength={254}
          defaultValue={filters.actorEmail}
        />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong"
        >
          {t("apply")}
        </button>
      </form>

      {page.items.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="audit-empty"
        >
          {t("empty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="audit-list">
          {page.items.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-1 rounded-lg border border-muted bg-surface p-3"
              data-testid="audit-entry"
              data-action={e.action}
            >
              <span className="font-semibold">
                {ta(e.action.replace(".", "_"))}
              </span>
              <span className="text-sm text-muted">
                {format.format(new Date(e.at))}
              </span>
              <span>
                {t("actor")}:{" "}
                {e.actorEmail ? (
                  <bdi dir="ltr" className="break-all">
                    {e.actorEmail}
                  </bdi>
                ) : (
                  tk(e.actorKind)
                )}
              </span>
              <span>
                {t("target")}: {tt(e.targetType)}{" "}
                <bdi dir="ltr" className="break-all font-mono text-sm">
                  {e.targetId}
                </bdi>
              </span>
              {Object.keys(e.detail).length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-sm">
                  {Object.entries(e.detail).map(([k, v]) => (
                    <li key={k}>
                      {(DETAIL_KEYS as readonly string[]).includes(k)
                        ? td(k)
                        : k}
                      :{" "}
                      {k === "role" && isStaffRole(v) ? (
                        tr(v)
                      ) : (
                        <bdi dir="ltr" className="break-all font-mono">
                          {v}
                        </bdi>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {e.ip ? (
                <span className="text-sm text-muted">
                  {t("ip")}:{" "}
                  <bdi dir="ltr" className="break-all">
                    {e.ip}
                  </bdi>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {page.nextCursor ? (
        <Link
          href={{
            pathname: "/staff/audit",
            query: { ...query, cursor: page.nextCursor },
          }}
          className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
          data-testid="audit-next"
        >
          {t("next")}
        </Link>
      ) : null}
      <TextLink href="/staff">{t("staffLink")}</TextLink>
    </PageShell>
  );
}
