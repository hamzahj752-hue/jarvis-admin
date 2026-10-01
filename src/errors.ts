/*
 * One error type for everything that can fail on the way to or from the backend,
 * and honest translation of each failure into something an administrator can act
 * on. Nothing here invents a status: an unknown failure is reported as unknown.
 */

/** PostgREST answers "I do not know that table" with this code. */
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

export interface BackendErrorOptions {
  /** HTTP status, or 0 when the request never got an answer. */
  status?: number;
  /** PostgREST/Postgres error code, when the server supplied one. */
  code?: string | null;
  /** Server-supplied hint, kept so the operator sees what the database said. */
  hint?: string | null;
}

export class BackendError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly hint: string | null;

  constructor(message: string, options: BackendErrorOptions = {}) {
    super(message);
    this.name = "BackendError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.hint = options.hint ?? null;
  }

  /** True when the server does not have this table yet (a pending migration). */
  get isMissingTable(): boolean {
    if (this.code && MISSING_TABLE_CODES.has(this.code)) return true;
    return /could not find the table|relation .* does not exist/i.test(this.message);
  }

  /** True when the write was refused by row-level security. */
  get isAuthorizationFailure(): boolean {
    if (this.code === "42501") return true;
    return /row-level security|not authorized/i.test(this.message);
  }

  /** True when the session is gone, invalid or expired. */
  get isAuthFailure(): boolean {
    if (this.status === 401 || this.status === 403) return true;
    return /invalid login credentials|invalid jwt|token is expired|jwt|session_not_found/i.test(this.message);
  }
}

const NETWORK_HINTS = [
  "failed to fetch",
  "networkerror",
  "network request failed",
  "load failed",
  "econnrefused",
  "enotfound",
  "etimedout",
  "socket hang up",
];

function looksLikeNetworkFailure(text: string): boolean {
  const lowered = text.toLowerCase();
  return NETWORK_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * Turns anything thrown or returned by the Supabase client into a BackendError
 * with a message that names the operation and, where the server said so, the
 * server's own words.
 */
export function toBackendError(error: unknown, label: string): BackendError {
  if (error instanceof BackendError) return error;

  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      status?: unknown;
      hint?: unknown;
      details?: unknown;
      error?: unknown;
      error_description?: unknown;
    };

    const message =
      pickString(candidate.message) ??
      pickString(candidate.error_description) ??
      pickString(candidate.error) ??
      pickString(candidate.details) ??
      pickString(candidate.hint);

    const code = pickString(candidate.code);
    const status = typeof candidate.status === "number" ? candidate.status : 0;

    if (message) {
      const text = message.trim();
      const hint = pickString(candidate.hint);
      if (looksLikeNetworkFailure(text)) {
        return new BackendError(
          `${label} could not reach the backend: ${text}. Check the network connection and that ` +
          `the Supabase project is reachable, then try again.`,
          { status, code, hint }
        );
      }
      return new BackendError(message ? `${label}: ${text}` : `${label} failed.`, { status, code, hint });
    }
  }

  if (error instanceof Error) {
    if (looksLikeNetworkFailure(error.message)) {
      return new BackendError(
        `${label} could not reach the backend: ${error.message}. Check the network connection, ` +
        `then try again.`,
        {}
      );
    }
    return new BackendError(`${label}: ${error.message}`, {});
  }

  return new BackendError(`${label} failed for an unknown reason.`, {});
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A message for a response body that was not JSON, kept separate so a 502 from a
 * proxy does not arrive as "[object Object]".
 */
export function statusMessage(status: number, body: string | null, label: string): BackendError {
  const trimmed = body?.trim();
  if (trimmed && trimmed.length < 300 && !trimmed.startsWith("<")) {
    return new BackendError(`${label}: ${trimmed}`, { status });
  }
  return new BackendError(`${label} failed (HTTP ${status}).`, { status });
}

/** Narrows an unknown value to an Error for a catch block. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}