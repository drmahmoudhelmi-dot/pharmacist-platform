"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import {
  CheckboxField,
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import {
  addExperienceAction,
  deleteExperienceAction,
  updateExperienceAction,
} from "../actions";
import { LIMITS } from "../constants";
import type { ExperienceItem } from "../service";
import {
  type ExperienceField,
  formDataToRaw,
  parseExperience,
} from "../validation";
import { formatMonth, monthNames, splitMonth } from "./format";
import { useWrite } from "./use-write";

type Mode = { name: "list" } | { name: "add" } | { name: "edit"; id: string };

export function ExperienceSection({ items }: { items: ExperienceItem[] }) {
  const t = useTranslations("Profile");
  const [mode, setMode] = useState<Mode>({ name: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  const atLimit = items.length >= LIMITS.experiencePerUser;

  function done(message: string) {
    setMode({ name: "list" });
    setNotice(message);
  }

  return (
    <div className="flex flex-col gap-4">
      <FormStatus success={notice} />
      {items.length === 0 ? (
        <p className="text-muted" data-testid="experience-empty">
          {t("experienceEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="experience-list">
          {items.map((item) =>
            mode.name === "edit" && mode.id === item.id ? (
              <li key={item.id} className="rounded-lg border border-muted p-3">
                <ExperienceForm
                  item={item}
                  onCancel={() => setMode({ name: "list" })}
                  onDone={() => done(t("experienceUpdated"))}
                />
              </li>
            ) : (
              <ExperienceRow
                key={item.id}
                item={item}
                disabled={mode.name !== "list"}
                onEdit={() => {
                  setNotice(null);
                  setMode({ name: "edit", id: item.id });
                }}
                onDeleted={() => done(t("experienceDeleted"))}
              />
            ),
          )}
        </ul>
      )}
      {mode.name === "add" ? (
        <div className="rounded-lg border border-muted p-3">
          <ExperienceForm
            onCancel={() => setMode({ name: "list" })}
            onDone={() => done(t("experienceAdded"))}
          />
        </div>
      ) : atLimit ? (
        <p className="text-muted">{t("experienceLimit")}</p>
      ) : (
        <SecondaryButton
          disabled={mode.name !== "list"}
          onClick={() => {
            setNotice(null);
            setMode({ name: "add" });
          }}
        >
          {t("addExperience")}
        </SecondaryButton>
      )}
    </div>
  );
}

function ExperienceRow({
  item,
  disabled,
  onEdit,
  onDeleted,
}: {
  item: ExperienceItem;
  disabled: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("Profile");
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const write = useWrite<never>();

  async function onDelete() {
    const ok = await write.submit(
      null,
      () => deleteExperienceAction(item.id),
      t("experienceDeleted"),
    );
    if (ok) onDeleted();
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-muted p-3">
      <p className="font-semibold">
        <bdi>{item.title}</bdi>
      </p>
      <p>
        <bdi>{item.employerName}</bdi>
      </p>
      <p className="text-sm text-muted">
        {formatMonth(locale, item.startMonth)} –{" "}
        {item.endMonth ? formatMonth(locale, item.endMonth) : t("present")}
      </p>
      <FormStatus error={write.error} />
      {confirming ? (
        <div
          role="group"
          aria-label={t("deleteConfirm")}
          className="flex flex-col gap-3 rounded-lg border border-red-700 p-3"
        >
          <p>{t("deleteConfirm")}</p>
          <SecondaryButton
            tone="danger"
            disabled={write.pending}
            onClick={onDelete}
          >
            {write.pending ? t("deleting") : t("confirmDelete")}
          </SecondaryButton>
          <SecondaryButton
            disabled={write.pending}
            onClick={() => setConfirming(false)}
          >
            {t("cancel")}
          </SecondaryButton>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <SecondaryButton disabled={disabled} onClick={onEdit}>
            {t("edit")}
            <span className="sr-only"> {item.title}</span>
          </SecondaryButton>
          <SecondaryButton
            tone="danger"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            {t("delete")}
            <span className="sr-only"> {item.title}</span>
          </SecondaryButton>
        </div>
      )}
    </li>
  );
}

function MonthYear({
  prefix,
  legend,
  value,
  monthError,
  yearError,
}: {
  prefix: "start" | "end";
  legend: string;
  value: string | null;
  monthError?: string;
  yearError?: string;
}) {
  const t = useTranslations("Profile");
  const locale = useLocale();
  const { year, month } = splitMonth(value);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-semibold text-ink">{legend}</legend>
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          name={`${prefix}Month`}
          label={t("monthLabel")}
          placeholder={t("choose")}
          options={monthNames(locale).map((label, i) => ({
            value: String(i + 1),
            label,
          }))}
          defaultValue={month}
          error={monthError}
        />
        <TextField
          name={`${prefix}Year`}
          label={t("yearLabel")}
          inputMode="numeric"
          maxLength={4}
          defaultValue={year}
          error={yearError}
        />
      </div>
    </fieldset>
  );
}

function ExperienceForm({
  item,
  onCancel,
  onDone,
}: {
  item?: ExperienceItem;
  onCancel: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("Profile");
  const write = useWrite<ExperienceField>();
  const [current, setCurrent] = useState(item ? item.endMonth === null : false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseExperience(formDataToRaw(form));
    const ok = await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () =>
        item
          ? updateExperienceAction(item.id, form)
          : addExperienceAction(form),
      item ? t("experienceUpdated") : t("experienceAdded"),
    );
    if (ok) onDone();
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-label={item ? t("editExperience") : t("addExperience")}
      className="flex flex-col gap-4"
    >
      <TextField
        name="title"
        label={t("titleLabel")}
        dir="auto"
        autoComplete="organization-title"
        maxLength={LIMITS.experienceTitle.max}
        defaultValue={item?.title}
        error={write.fieldError("title")}
      />
      <TextField
        name="employerName"
        label={t("employerLabel")}
        dir="auto"
        autoComplete="organization"
        maxLength={LIMITS.employerName.max}
        defaultValue={item?.employerName}
        error={write.fieldError("employerName")}
      />
      <MonthYear
        prefix="start"
        legend={t("startLegend")}
        value={item?.startMonth ?? null}
        monthError={write.fieldError("startMonth")}
        yearError={write.fieldError("startYear")}
      />
      <CheckboxField
        name="current"
        label={t("currentLabel")}
        defaultChecked={current}
        onChange={setCurrent}
      />
      {current ? null : (
        <MonthYear
          prefix="end"
          legend={t("endLegend")}
          value={item?.endMonth ?? null}
          monthError={write.fieldError("endMonth")}
          yearError={write.fieldError("endYear")}
        />
      )}
      <FormStatus error={write.error} />
      <SubmitButton
        pending={write.pending}
        label={t("saveExperience")}
        pendingLabel={t("saving")}
      />
      <SecondaryButton disabled={write.pending} onClick={onCancel}>
        {t("cancel")}
      </SecondaryButton>
    </form>
  );
}
