/*
 * Administrator authentication.
 *
 * Identity comes from Supabase Auth. Sign-in is Google's OAuth flow, handled by
 * the official client: the browser is sent to Google, comes back to the site
 * root, and the authorization code is exchanged for a session here. No password
 * is typed into this page for the Google path, no OAuth client secret exists
 * anywhere in this bundle, and the access token never travels in a URL.
 *
 * Being authenticated is not the same as being allowed to administrate. Two
 * independent checks are applied, and the second is the one that matters:
 *
 *  1. This page reads `app_metadata.role` from the signed-in user as reported by
 *     `/auth/v1/user` and hides the panel from anyone else. That is for the
 *     administrator's own benefit, and it is not a security boundary.
 *  2. Row-level security in Postgres reads the same claim out of the JWT on the
 *     server for every single statement. A non-admin cannot write these settings
 *     by forging a token, by editing localStorage, or by calling the REST API
 *     directly, because `app_metadata` is writable only by the auth server.
 *
 * The session lives in localStorage under a fixed key so a reload does not ask
 * for credentials again, and it is re-verified with the server on every load: a
 * session that has been revoked, or whose role was removed, is discarded rather
 * than trusted.
 */
import { ADMIN_ROLE, redirectOrigin } from "./config.ts";
import { BackendError, toBackendError } from "./errors.ts";
import { SESSION_STORAGE_KEY, supabase, type Session, type User } from "./supabase.ts";
import type { AdminIdentity } from "./types.ts";

export type AuthFailureKind =
  | "cancelled"
  | "unauthorized"
  | "expired"
  | "network"
  | "configuration"
  | "unknown";

export interface AuthProblem {
  kind: AuthFailureKind;
  message: string;
}

export type SessionStatus = "anonymous" | "administrator" | "rejected";

export interface SessionResolution {
  status: SessionStatus;
  user: AdminIdentity | null;
  problem: AuthProblem | null;
}

/* --------------------------------------------------------------- identity ---- */

/**
 * The role as the auth server reports it.
 *
 * `app_metadata` is trusted and `user_metadata` is not: a user can change their
 * own `user_metadata` through the client library, and no policy in this project
 * reads it.
 */
export function identityOf(user: User | null | undefined): AdminIdentity {
  const metadata = (user?.app_metadata ?? {}) as Record<string, unknown>;
  return {
    email: typeof user?.email === "string" ? user.email : null,
    role: typeof metadata.role === "string" ? metadata.role : null,
    userId: typeof user?.id === "string" ? user.id : null
  };
}

export function isAdmin(identity: AdminIdentity | null | undefined): boolean {
  return !!identity && identity.role === ADMIN_ROLE;
}

/* ------------------------------------------------------------ oauth result ---- */

const OAUTH_PARAM_KEYS = new Set([
  "error",
  "error_code",
  "error_description",
  "error_uri",
  "code",
  "access_token",
  "refresh_token",
  "expires_at",
  "expires_in",
  "token_type",
  "token",
  "provider_token",
  "type",
  "state"
]);

/**
 * Reads the result Google and Supabase put in the redirect URL.
 *
 * Handles both shapes: `?error=...` for a cancelled or refused consent, and the
 * PKCE `?code=...` this client asks for. The parameters are only read here; the
 * URL is not modified until the Supabase client has consumed the code.
 */
export function readOauthResult(href: string): { problem: AuthProblem | null; code: string | null } {
  const url = new URL(href);
  const params = new URLSearchParams(url.search);
  let hashParams = new URLSearchParams();
  if (url.hash && url.hash.length > 1) {
    try {
      hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    } catch {
      hashParams = new URLSearchParams();
    }
  }

  const code = params.get("code") ?? hashParams.get("code");
  const errorCode = params.get("error_code") ?? hashParams.get("error_code");
  const error = params.get("error") ?? hashParams.get("error");
  const description =
    params.get("error_description") ??
    hashParams.get("error_description") ??
    params.get("error") ??
    hashParams.get("error");

  if (!error && !errorCode) return { problem: null, code };

  const kind = classifyOauthFailure(error, errorCode, description);
  return { problem: { kind, message: oauthMessage(kind, description, errorCode ?? error) }, code };
}

function classifyOauthFailure(error: string | null, errorCode: string | null, description: string | null): AuthFailureKind {
  const haystack = `${error ?? ""} ${errorCode ?? ""} ${description ?? ""}`.toLowerCase();
  /*
   * Expiry is tested first, and deliberately. Supabase answers a cancelled
   * consent screen with `error=access_denied` as well, but it only adds
   * `error_code=otp_expired` when the one-time code actually timed out. Telling
   * an administrator whose link expired that they "cancelled" sends them looking
   * for a button they already pressed.
   */
  if (
    haystack.includes("otp_expired") ||
    haystack.includes("expired") ||
    haystack.includes("invalid_token") ||
    haystack.includes("session_not_found")
  ) {
    return "expired";
  }
  if (haystack.includes("access_denied") || haystack.includes("cancelled") || haystack.includes("canceled")) {
    return "cancelled";
  }
  return "unknown";
}

function oauthMessage(kind: AuthFailureKind, description: string | null, code: string | null): string {
  const detail = description && description !== code ? ` (${description})` : "";
  switch (kind) {
    case "cancelled":
      return `Google sign-in was cancelled${detail}. Nothing was changed. Press Continue with Google to try again.`;
    case "expired":
      return `That sign-in link or session had already expired${detail}. Sign in again to continue.`;
    default:
      return `Google sign-in could not be completed${detail ? ` ${detail}` : ""}.`;
  }
}

/**
 * Removes the authentication parameters from the address bar.
 *
 * Called only after the Supabase client has read them: the `?code=` parameter is
 * a single-use credential, and leaving it in the URL would put a usable value
 * into the browser history and into any screenshot of the address bar.
 */
export function clearAuthParamsFromUrl(): void {
  if (!window.history || typeof window.history.replaceState !== "function") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of Array.from(url.searchParams.keys())) {
    if (OAUTH_PARAM_KEYS.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  for (const key of Array.from(new URLSearchParams(url.hash.replace(/^#/, "")).keys())) {
    if (OAUTH_PARAM_KEYS.has(key)) {
      url.hash = "";
      changed = true;
      break;
    }
  }
  if (!changed) return;
  const search = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
}

/* -------------------------------------------------------------- session ---- */

/** Removes the stored session handle without contacting the server. */
export function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* A browser with storage disabled still works for this page load. */
  }
}

/** The stored handle, for the Settings page's "what is stored" report. */
export function storedSessionKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>).sort() : [];
  } catch {
    return [];
  }
}

export async function currentSession(): Promise<Session | null> {
  const { data, error } = await supabase().auth.getSession();
  if (error) throw toBackendError(error, "Reading the saved session");
  return data.session ?? null;
}

/**
 * Turns a signed-in-but-not-administrator account into a rejection.
 *
 * The session is ended locally so the page cannot sit in a half-authorised state
 * and so the next load starts from a clean, anonymous one.
 */
async function reject(identity: AdminIdentity, problem: AuthProblem): Promise<SessionResolution> {
  await supabase().auth.signOut().catch(() => {
    /* The local handle is removed either way. */
  });
  clearStoredSession();
  void identity;
  return { status: "rejected", user: null, problem };
}

export function unauthorizedMessage(identity: AdminIdentity): AuthProblem {
  return {
    kind: "unauthorized",
    message:
      `Signed in as ${identity.email ?? "that Google account"}, but it is not authorized as an administrator. ` +
      `Its trusted app_metadata.role is ${identity.role ?? "unset"}. An administrator has to grant the ` +
      `admin role to this exact Google account before it can open the panel.`
  };
}

/**
 * Resolves the session for this page load.
 *
 * Order matters. The OAuth result is read first, then the Supabase client
 * consumes the callback code, then the URL is cleaned, and only then is the
 * identity re-checked against the server. A stored handle is never trusted on its
 * own: `getUser()` asks the auth server who the token belongs to, which is also
 * where a removed role shows up.
 */
export async function resolveSession(): Promise<SessionResolution> {
  const oauth = readOauthResult(window.location.href);

  let session: Session | null = null;
  try {
    session = await currentSession();
  } catch (error) {
    clearStoredSession();
    return {
      status: "anonymous",
      user: null,
      problem: {
        kind: isTransportFailure(error) ? "network" : "expired",
        message: isTransportFailure(error)
          ? `Supabase could not be reached while restoring the saved session: ${describe(error)}. ` +
            `Nothing was changed. Try again once the connection is back.`
          : problemMessage(error, "The saved session could not be restored.")
      }
    };
  }

  /* Only now is it safe to take the credential out of the address bar. */
  clearAuthParamsFromUrl();

  if (!session) {
    return { status: "anonymous", user: null, problem: oauth.problem };
  }

  let verified: User | null = null;
  try {
    const { data, error } = await supabase().auth.getUser();
    if (error) throw error;
    verified = data.user;
  } catch (error) {
    await supabase().auth.signOut().catch(() => undefined);
    clearStoredSession();
    const backend = error instanceof BackendError ? error : null;
    /*
     * Two very different failures land here and must not be reported the same
     * way. A rejected token means the session is gone and signing in again is the
     * fix. A transport failure means the session may well still be valid: telling
     * the administrator to sign in again would be wrong advice, and would invite
     * them to re-authenticate over an outage.
     */
    if (backend || isTransportFailure(error)) {
      return {
        status: "anonymous",
        user: null,
        problem: {
          kind: "network",
          message:
            `This browser has a saved session, but the Supabase auth server could not be reached: ` +
            `${backend ? backend.message : describe(error)} Nothing was changed. Try again once the connection is back.`
        }
      };
    }
    return {
      status: "anonymous",
      user: null,
      problem: {
        kind: "expired",
        message: problemMessage(error, "The saved session is no longer valid.") + " Sign in again to continue."
      }
    };
  }

  const identity = identityOf(verified);
  if (!isAdmin(identity)) return reject(identity, unauthorizedMessage(identity));

  return { status: "administrator", user: identity, problem: oauth.problem };
}

/* ---------------------------------------------------------------- sign in ---- */

/**
 * Starts Google sign-in.
 *
 * `redirectTo` is the running origin, so the same build returns correctly to
 * production, to a preview deployment and to localhost. The client navigates
 * away on success; only a failure to even start the flow returns here.
 */
export async function signInWithGoogle(): Promise<AuthProblem | null> {
  try {
    const { error } = await supabase().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectOrigin(),
        scopes: "openid email profile",
        queryParams: { access_type: "online", prompt: "select_account" }
      }
    });
    if (!error) return null;
    return { kind: classifySignInFailure(error.message), message: signInFailureMessage(error.message) };
  } catch (error) {
    const backend = error instanceof BackendError ? error : null;
    return {
      kind: "network",
      message: `Google sign-in could not be started: ${backend ? backend.message : String(error)}. Check the network connection and try again.`
    };
  }
}

/** The secondary sign-in path, kept for an administrator with a password set. */
export async function signInWithPassword(email: string, password: string): Promise<AuthProblem | null> {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) return { kind: classifySignInFailure(error.message), message: signInFailureMessage(error.message) };
  if (!data.user) return { kind: "unknown", message: "Sign-in returned no user. Try again." };
  const identity = identityOf(data.user);
  if (!isAdmin(identity)) {
    await supabase().auth.signOut().catch(() => undefined);
    clearStoredSession();
    return unauthorizedMessage(identity);
  }
  return null;
}

export async function signOut(): Promise<void> {
  try {
    await supabase().auth.signOut();
  } catch {
    /* Revoking server-side is best effort; the local handle goes either way. */
  }
  clearStoredSession();
}

function classifySignInFailure(message: string): AuthFailureKind {
  const lowered = message.toLowerCase();
  if (lowered.includes("failed to fetch") || lowered.includes("network")) return "network";
  if (lowered.includes("expired") || lowered.includes("invalid")) return "expired";
  return "unknown";
}

function signInFailureMessage(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes("invalid login credentials")) {
    return "That email and password were not accepted. Check them and try again.";
  }
  if (lowered.includes("email not confirmed")) {
    return "This account has not been confirmed yet. Confirm it in Supabase, then sign in.";
  }
  if (lowered.includes("failed to fetch") || lowered.includes("network")) {
    return `The sign-in request could not reach Supabase: ${message}. Check the network connection and try again.`;
  }
  return message;
}

function problemMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Tells a dead network apart from a rejected credential.
 *
 * Both arrive as a rejected promise with a message, and confusing them is costly:
 * an outage is reported as "your session expired" (which sends the administrator
 * to sign in again over a broken connection), and a revoked session is reported as
 * a network problem (which suggests waiting, when signing in again is the fix).
 */
function isTransportFailure(error: unknown): boolean {
  const lowered = describe(error).toLowerCase();
  return (
    lowered.includes("failed to fetch") ||
    lowered.includes("network") ||
    lowered.includes("load failed") ||
    lowered.includes("connection") ||
    lowered.includes("timeout") ||
    lowered.includes("timed out")
  );
}

/* ---------------------------------------------------------------- events ---- */

/**
 * Subscribes to session changes.
 *
 * The handler is deferred with a task boundary on purpose: awaiting a Supabase
 * call from inside `onAuthStateChange` re-enters the client's internal lock and
 * deadlocks the refresh.
 */
export function onAuthStateChange(handler: (event: string, session: Session | null) => void): () => void {
  const { data } = supabase().auth.onAuthStateChange((event, session) => {
    const nextEvent = event;
    const nextSession = session;
    setTimeout(() => handler(nextEvent, nextSession), 0);
  });
  return () => data.subscription.unsubscribe();
}