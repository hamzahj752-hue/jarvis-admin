/*
 * Build-time configuration.
 *
 * Everything the panel needs to reach Supabase arrives through Vite environment
 * variables, so no endpoint and no key is written into the source. The build
 * fails loudly if one is missing instead of shipping a page that cannot sign in.
 *
 * Both values are PUBLIC. The publishable/anon key is a client identifier that
 * authorises nothing by itself: every statement this panel makes carries the
 * signed-in administrator's JWT and is re-checked by Postgres row-level security.
 * A service-role key, a secret key or a database password must never appear in
 * anything under src/ or in a VITE_* variable - VITE_* values are inlined into
 * the published bundle.
 */

const raw = import.meta.env as Record<string, string | undefined>;

function required(name: string): string {
  const value = (raw[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env (or add ${name} to the deployment's ` +
      `environment variables) and build again.`
    );
  }
  return value;
}

/** No trailing slash: every base URL in this app is concatenated with a path. */
export const SUPABASE_URL = required("VITE_SUPABASE_URL").replace(/\/+$/, "");
export const SUPABASE_ANON_KEY = required("VITE_SUPABASE_ANON_KEY");

/**
 * The trusted claim every row-level-security policy in this project reads.
 *
 * It lives in `app_metadata`, which only the Supabase Auth server (Studio, the
 * admin API, or SQL) can write. A user cannot promote themselves by editing
 * `user_metadata` or by patching anything in the browser, which is exactly why
 * the same claim gates the database and not just this page.
 */
export const ADMIN_ROLE = "admin";

export const SYSTEM_STATE_ROW_ID = "default";
export const POLICY_ROW_ID = "default";

export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * Where Google is told to send the browser back to.
 *
 * The origin of the running page, never a hardcoded host: the same bundle then
 * works on the Vercel production URL, on a preview deployment and on localhost
 * without being rebuilt for each one.
 */
export function redirectOrigin(): string {
  return window.location.origin;
}