import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { getProfileForViewer } from "@/modules/profiles/service";
import { ProfileView } from "@/modules/profiles/ui/profile-view";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

// Profile ids are not known at build time. The locale layout sets
// dynamicParams = false for unknown locales; this segment states its own value.
export const dynamicParams = true;

/**
 * A member's profile. Members only (signed out → sign-in). A hidden, missing
 * or malformed id all get the same 404, so hidden profiles cannot be probed.
 */
export default async function MemberProfilePage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const view = await getProfileForViewer(getDb(), actor, id);
  if (!view) notFound();
  const t = await getTranslations("ProfileView");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <ProfileView view={view} />
    </PageShell>
  );
}
