"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormStatus, SecondaryButton } from "@/shared/ui/form";
import { withdrawApplicationAction } from "../actions";
import { useApplicationWrite } from "./use-application-write";

/** Withdraw an application, after confirming. */
export function WithdrawButton({ applicationId }: { applicationId: string }) {
  const t = useTranslations("Applications");
  const write = useApplicationWrite();
  const [confirming, setConfirming] = useState(false);

  async function withdraw() {
    setConfirming(false);
    await write.submit(
      null,
      () => withdrawApplicationAction(applicationId),
      t("withdrawn"),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div className="flex flex-col gap-2" role="group">
          <p>{t("withdrawConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              tone="danger"
              onClick={withdraw}
              disabled={write.pending}
            >
              {t("confirmWithdraw")}
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(false)}>
              {t("cancel")}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div>
          <SecondaryButton
            tone="danger"
            onClick={() => setConfirming(true)}
            disabled={write.pending}
          >
            {t("withdraw")}
          </SecondaryButton>
        </div>
      )}
      <FormStatus error={write.error} success={write.success} />
    </div>
  );
}
