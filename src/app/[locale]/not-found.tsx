import { getTranslations } from "next-intl/server";
import { PageShell } from "@/shared/ui/page-shell";

// Localized 404 for notFound() inside a locale's pages (e.g. a hidden profile).
export default async function NotFound() {
  const t = await getTranslations("NotFound");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p>{t("body")}</p>
    </PageShell>
  );
}
