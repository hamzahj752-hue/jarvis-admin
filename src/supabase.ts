/*
 * The single Supabase client.
 *
 * One instance, created once, with the official `@supabase/supabase-js` client.
 * It owns the parts of the session contract that are easy to get subtly wrong:
 *
 *  * `persistSession` keeps the session in localStorage, so a reload does not
 *    ask the administrator to sign in again.
 *  * `autoRefreshToken` refreshes the access token before it expires, so a long
 *    editing session is not cut off mid-save.
 *  * `detectSessionInUrl` consumes the OAuth callback (the `?code=` PKCE code or
 *    the `#access_token=` implicit fragment) that Google/Supabase redirects back
 *    with, and exchanges it for a real session.
 *  * `flowType: "pkce"` uses the authorization-code flow with PKCE, so no access
 *    token is ever placed in the redirect URL and no client secret is needed.
 *
 * The storage key is the same one the previous build used, so an administrator
 * who already has a valid session keeps it across this upgrade.
 *
 * The key passed here is the publishable/anon key. It is a public client
 * identifier: it lets a browser talk to the API at all and grants nothing on its
 * own. There is no service-role key anywhere in this bundle.
 */
import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.ts";
import type { Database } from "./database.types.ts";

export const SESSION_STORAGE_KEY = "jarvis_admin_session";

let instance: SupabaseClient<Database> | null = null;

export function supabase(): SupabaseClient<Database> {
  if (instance) return instance;
  instance = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storageKey: SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
    global: {
      headers: { "X-Client-Info": "jarvis-admin-web/1.0" },
    },
  });
  return instance;
}

/** Test seam: lets the harness swap the transport without touching call sites. */
export function __setSupabaseClient(client: SupabaseClient<Database> | null): void {
  instance = client;
}

export type { Session, User };