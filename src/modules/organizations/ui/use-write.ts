"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import type { ActionResult } from "../actions";
import type { FieldErrors } from "../validation";

type State<K extends string> = {
  pending: boolean;
  error: string | null;
  success: string | null;
  fieldErrors: FieldErrors<K>;
};

const idle = { pending: false, error: null, success: null, fieldErrors: {} };

/**
 * Shared submit flow for the organization forms: client-side check for fast
 * feedback, then the server action, whose result alone decides success.
 * Every message is localized from a stable code ("OrganizationErrors").
 */
export function useWrite<K extends string = never, T = object>() {
  const te = useTranslations("OrganizationErrors");
  const router = useRouter();
  const [state, setState] = useState<State<K>>(idle);

  async function submit(
    clientErrors: FieldErrors<K> | null,
    call: () => Promise<ActionResult<K, T>>,
    successMessage: string,
  ): Promise<ActionResult<K, T> | null> {
    if (clientErrors) {
      setState({ ...idle, error: te("validation"), fieldErrors: clientErrors });
      return null;
    }
    setState({ ...idle, pending: true });
    let result: ActionResult<K, T>;
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
    return result;
  }

  function fieldError(key: K): string | undefined {
    const code: string | undefined = state.fieldErrors[key];
    return code ? te(code) : undefined;
  }

  return { ...state, submit, fieldError, reset: () => setState(idle) };
}
