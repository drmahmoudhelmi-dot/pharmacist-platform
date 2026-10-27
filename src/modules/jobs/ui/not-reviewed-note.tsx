/**
 * Callout on job pages: the organization's details are not reviewed by the
 * platform. Amber on amber-50 (text 9.7:1, border 4.9:1 on white).
 */
export function NotReviewedNote({ children }: { children: string }) {
  return (
    <aside
      role="note"
      className="flex items-start gap-3 rounded-lg border-2 border-amber-700 bg-amber-50 p-3 text-base text-amber-950"
      data-testid="not-reviewed-note"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="mt-0.5 size-6 shrink-0 text-amber-800"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </svg>
      <p className="leading-relaxed">{children}</p>
    </aside>
  );
}
