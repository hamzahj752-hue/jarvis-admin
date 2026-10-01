/*
 * The SMS and call policy form: which column each control writes, and the bounds
 * the database enforces.
 *
 * Two columns are deliberately absent from the switch list:
 * `confirmation_required` and `confirmation_required_before_answering`. The
 * clients ignore an explicit false for both, so a switch here would be a control
 * that looks live and does nothing - the worst kind of Admin control. They are
 * written as their enforced value on every save instead, so a row edited by hand
 * cannot leave them false and have that read as intent.
 *
 * No DOM in this file.
 */
import { BackendError } from "./errors.ts";

export const POLICY_SWITCHES = [
  ["policySmsEnabled", "sms_assistant_enabled"],
  ["policySmsAnnounce", "announce_incoming"],
  ["policySmsReply", "reply_enabled"],
  ["policyCallEnabled", "call_assistant_enabled"],
  ["policyCallAnnounce", "announce_incoming_calls"],
  ["policyCallAnswer", "answer_enabled"],
  ["policyCallAutoAnswer", "auto_answer"],
  ["policyCallAutoReject", "auto_reject"]
] as const;

export type PolicySwitchColumn = (typeof POLICY_SWITCHES)[number][1];

export interface PolicyNumberField {
  id: string;
  column: string;
  min: number;
  max: number;
}

export const POLICY_NUMBERS: readonly PolicyNumberField[] = [
  { id: "policyBodyTimeout", column: "body_timeout_ms", min: 5000, max: 120000 },
  { id: "policyConfirmTimeout", column: "confirmation_timeout_ms", min: 5000, max: 120000 },
  { id: "policyCallDecisionTimeout", column: "decision_timeout_ms", min: 5000, max: 60000 }
];

/** The columns that are always written as their enforced value. */
export const POLICY_ENFORCED = {
  confirmation_required: true,
  attribution_enabled: true,
  confirmation_required_before_answering: true
} as const;

/**
 * Parses one timeout, clamped to the same bounds the database enforces so the
 * message names the field instead of surfacing a constraint violation.
 */
export function parsePolicyNumber(raw: string, field: PolicyNumberField): number {
  const text = raw.trim();
  if (text === "") {
    throw new BackendError(`${field.column} must be a whole number of milliseconds.`, {});
  }
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value)) {
    throw new BackendError(`${field.column} must be a whole number of milliseconds.`, {});
  }
  if (value < field.min || value > field.max) {
    throw new BackendError(`${field.column} must be between ${field.min} and ${field.max} ms.`, {});
  }
  return value;
}

/** Maximum length the database allows for the attribution text. */
export const ATTRIBUTION_MAX_LENGTH = 120;

/** Mirrors the database's `char_length(attribution_text) <= 120` check. */
export function validateAttributionText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > ATTRIBUTION_MAX_LENGTH) {
    return `attribution_text must be ${ATTRIBUTION_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}