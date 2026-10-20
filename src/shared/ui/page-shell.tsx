import type { ReactNode } from "react";
import { Link } from "@/shared/i18n/navigation";

/** Narrow, mobile-first page frame shared by the account pages. */
export function PageShell({
  title,
  homeLabel,
  children,
}: {
  title: string;
  homeLabel: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-6">
      <nav>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline"
        >
          {homeLabel}
        </Link>
      </nav>
      <h1 className="text-2xl font-bold leading-tight text-ink">{title}</h1>
      {children}
    </main>
  );
}

export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
    >
      {children}
    </Link>
  );
}
