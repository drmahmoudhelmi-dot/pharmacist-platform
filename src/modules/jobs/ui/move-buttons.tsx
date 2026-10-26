"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormStatus, SecondaryButton } from "@/shared/ui/form";
import { moveApplicationAction } from "../actions";
import type { EmployerMove } from "../constants";
import { useApplicationWrite } from "./use-application-write";

const NEEDS_CONFIRMATION: readonly EmployerMove[] = ["accepted", "rejected"];

/**
 * The moves the server says the employer may make. Accepting and rejecting
 * are final and notify the applicant, so they ask first.
 */
export function MoveButtons({
  applicationId,
  moves,
}: {
  applicationId: string;
  moves: readonly EmployerMove[];
}) {
  const t = useTranslations("Applications");
  const write = useApplicationWrite();
  const [confirming, setConfirming] = useState<EmployerMove | null>(null);

  async function move(to: EmployerMove) {
    setConfirming(null);
    await write.submit(
      null,
      () => moveApplicationAction(applicationId, to),
      t(`moved.${to}`),
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="move-buttons">
      {moves.length === 0 ? (
        <p className="text-muted">{t("noMoves")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {moves.map((to) => (
            <SecondaryButton
              key={to}
              tone={to === "rejected" ? "danger" : "primary"}
              disabled={write.pending}
              onClick={() =>
                NEEDS_CONFIRMATION.includes(to)
                  ? setConfirming(to)
                  : void move(to)
              }
            >
              {t(`moveActions.${to}`)}
            </SecondaryButton>
          ))}
        </div>
      )}
      {confirming ? (
        <div className="flex flex-col gap-2" role="group">
          <p role="alert">{t(`moveConfirm.${confirming}`)}</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              tone={confirming === "rejected" ? "danger" : "primary"}
              disabled={write.pending}
              onClick={() => void move(confirming)}
            >
              {t(`confirmMove.${confirming}`)}
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(null)}>
              {t("cancel")}
            </SecondaryButton>
          </div>
        </div>
      ) : null}
      <FormStatus error={write.error} success={write.success} />
    </div>
  );
}
