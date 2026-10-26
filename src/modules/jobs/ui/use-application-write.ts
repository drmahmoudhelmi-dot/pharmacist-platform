"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import type { ApplicationActionResult } from "../actions";
import type { FieldErrors } from "../validation";

type State<K extends string> = {
  pending: boolean;
  error: string | null;
  success: string | null;
  fieldErrors: FieldErrors<K>;
};

const idle = { pending: false, error: null, success: null, fieldErrors: {} };

/**
 * Submit flow for the application forms and buttons (the counterpart of
 * `useWrite` for "ApplicationErrors"): the server result alone decides
 * success; a success refreshes the page's server data.
 */
export function useApplicationWrite<K extends string = never, T = object>() {
  const te = useTranslations("ApplicationErrors");
  const router = useRouter();
  const [state, setState] = useState<State<K>>(idle);

  async function submit(
    clientErrors: FieldErrors<K> | null,
    call: () => Promise<ApplicationActionResult<K, T>>,
    successMessage: string,
  ): Promise<ApplicationActionResult<K, T> | null> {
    if (clientErrors) {
      setState({ ...idle, error: te("validation"), fieldErrors: clientErrors });
      return null;
    }
    setState({ ...idle, pending: true });
    let result: ApplicationActionResult<K, T>;
    try {
      result = await call();
    } catch {
      setState({ ...idle, error: te("network") });
      return null;
    }
    if (result.ok) {
      setState({ ...idle, success: successMessage });
      router.refresh();
      return result;
    }
    setState({
      ...idle,
      error: te(result.error),
      fieldErrors: ("fieldErrors" in result && result.fieldErrors) || {},
    });
    // The page may be stale (closed job, changed status): show the truth.
    if (result.error !== "validation" && result.error !== "generic")
      router.refresh();
    return result;
  }

  function fieldError(key: K): string | undefined {
    const code: string | undefined = state.fieldErrors[key];
    return code ? te(code) : undefined;
  }

  return { ...state, submit, fieldError };
}
