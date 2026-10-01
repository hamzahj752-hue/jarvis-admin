/*
 * Everything the panel reads and writes.
 *
 * Two rules hold for every function in this file:
 *
 *  1. The caller's JWT is the only credential used. Statements go through the
 *     official Supabase client, which attaches the signed-in administrator's
 *     access token, so Postgres re-checks row-level security on the server for
 *     every one of them. There is no path here that bypasses it, and no path
 *     that uses a privileged key.
 *
 *  2. A failure is reported, never swallowed and never guessed around. A table
 *     that has not been migrated yet is reported as exactly that, instead of
 *     being rendered as "no data".
 */
import { SUPABASE_URL } from "./config.ts";
import { BackendError, statusMessage, toBackendError } from "./errors.ts";
import { supabase } from "./supabase.ts";
import type {
  AssistantPolicyUpdate,
  LanguageUpdate,
  SystemStateUpdate,
  VoiceInsert,
  VoiceUpdate,
} from "./database.types.ts";
import type {
  AssistantPolicyRow,
  HealthReport,
  LanguageRow,
  SystemStateRow,
  UserAppSnapshot,
  VoiceRow,
} from "./types.ts";

/* --------------------------------------------------------------- reading ---- */

export async function fetchLanguages(): Promise<{ languages: LanguageRow[]; voices: VoiceRow[] }> {
  const client = supabase();
  const [languages, voices] = await Promise.all([
    client.from("jarvis_languages").select("*").order("id", { ascending: true }),
    client.from("jarvis_language_voices").select("*").order("language_id", { ascending: true }).order("gender", { ascending: true }),
  ]);

  if (languages.error) throw toBackendError(languages.error, "Loading the language list");
  if (voices.error) throw toBackendError(voices.error, "Loading the voice mappings");

  return { languages: languages.data ?? [], voices: voices.data ?? [] };
}

export async function fetchSystemState(id: string): Promise<SystemStateRowLite | null> {
  const { data, error } = await supabase()
    .from("jarvis_system_state")
    .select("id,jarvis_enabled,created_at,updated_at")
    .eq("id", id)
    .limit(1);
  if (error) throw toBackendError(error, "Loading the JARVIS system state");
  return (data && data[0]) || null;
}

export async function fetchAssistantPolicy(id: string): Promise<AssistantPolicyRowLite | null> {
  const { data, error } = await supabase()
    .from("jarvis_assistant_policy")
    .select("*")
    .eq("id", id)
    .limit(1);
  if (error) throw toBackendError(error, "Loading the assistant policy");
  return (data && data[0]) || null;
}

/* --------------------------------------------------------------- writing ---- */

/**
 * Clears the incumbent default language before another one is set.
 *
 * The database enforces a single default with a partial unique index, so the
 * order matters: two defaults at the same instant is a constraint violation, not
 * something to reconcile afterwards.
 */
export async function clearOtherDefaults(languageId: string): Promise<void> {
  const { error } = await supabase()
    .from("jarvis_languages")
    .update({ is_default: false })
    .eq("is_default", true)
    .neq("id", languageId);
  if (error) throw toBackendError(error, "Clearing the previous default language");
}

export async function updateLanguage(languageId: string, changes: LanguageUpdate): Promise<LanguageRowLite> {
  const { data, error } = await supabase()
    .from("jarvis_languages")
    .update(changes)
    .eq("id", languageId)
    .select("*")
    .limit(1);
  if (error) throw toBackendError(error, `Saving ${languageId}`);
  const row = data && data[0];
  if (!row) {
    throw new BackendError(
      `The database did not confirm the save for "${languageId}". Row-level security may have ` +
      `rejected the write, or the row was removed while this page was open.`,
      {}
    );
  }
  return row;
}

/** Keeps the denormalised language_code on existing voice rows in step. */
export async function syncVoiceLanguageCode(languageId: string, languageCode: string): Promise<void> {
  const { error } = await supabase()
    .from("jarvis_language_voices")
    .update({ language_code: languageCode })
    .eq("language_id", languageId);
  if (error) throw toBackendError(error, `Syncing the language code on the ${languageId} voice mappings`);
}

/**
 * Updates one stored mapping, addressed by language and gender.
 *
 * Deliberately not an upsert: the table also has a unique (language_id, voice_id)
 * constraint, so a merge-duplicates upsert that moves a voice ID onto another row
 * can collide with it instead of editing the row the administrator is looking at.
 */
export async function updateVoice(languageId: string, gender: string, changes: VoiceUpdate): Promise<VoiceRowLite> {
  const { data, error } = await supabase()
    .from("jarvis_language_voices")
    .update(changes)
    .eq("language_id", languageId)
    .eq("gender", gender)
    .select("*")
    .limit(1);
  if (error) throw toBackendError(error, `Saving the ${gender} voice for ${languageId}`);
  const row = data && data[0];
  if (!row) {
    throw new BackendError(`The database did not confirm the ${gender} voice for "${languageId}".`, {});
  }
  return row;
}

export async function insertVoice(values: VoiceInsert): Promise<VoiceRowLite> {
  const { data, error } = await supabase().from("jarvis_language_voices").insert(values).select("*").limit(1);
  if (error) throw toBackendError(error, `Adding the ${values.gender} voice for ${values.language_id}`);
  const row = data && data[0];
  if (!row) throw new BackendError(`The database did not confirm the new ${values.gender} voice mapping.`, {});
  return row;
}

export async function deleteVoice(languageId: string, gender: string): Promise<void> {
  const { data, error } = await supabase()
    .from("jarvis_language_voices")
    .delete()
    .eq("language_id", languageId)
    .eq("gender", gender)
    .select("id");
  if (error) throw toBackendError(error, `Removing the ${gender} voice mapping for ${languageId}`);
  /* An empty result is a real possibility only if the row vanished underneath
     us; saying so is better than reporting a deletion that may not have happened. */
  if (!data || data.length === 0) {
    throw new BackendError(
      `No ${gender} voice mapping for "${languageId}" was deleted. It may already be gone.`,
      {}
    );
  }
}

export async function updateSystemState(id: string, changes: SystemStateUpdate): Promise<SystemStateRowLite> {
  const { data, error } = await supabase()
    .from("jarvis_system_state")
    .update(changes)
    .eq("id", id)
    .select("*")
    .limit(1);
  if (error) throw toBackendError(error, "Saving the JARVIS system state");
  const row = data && data[0];
  if (!row) throw new BackendError("The database did not confirm the JARVIS system state save.", {});
  return row;
}

export async function updateAssistantPolicy(id: string, changes: AssistantPolicyUpdate): Promise<AssistantPolicyRowLite> {
  const { data, error } = await supabase()
    .from("jarvis_assistant_policy")
    .update(changes)
    .eq("id", id)
    .select("*")
    .limit(1);
  if (error) throw toBackendError(error, "Saving the assistant policy");
  const row = data && data[0];
  if (!row) throw new BackendError("The database did not confirm the assistant policy save.", {});
  return row;
}

/* ---------------------------------------------------------- public probes ---- */

/*
 * The two public Edge Functions are fetched directly instead of through
 * `functions.invoke`, for two reasons: they only answer GET, and they are the
 * exact configuration a User App downloads, so the panel reads them with no
 * session attached at all. That is also what makes the "what the User App
 * receives" panel an independent check: it cannot accidentally show admin-only
 * data, because it never sends the admin token.
 */

const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;

export async function fetchHealth(): Promise<HealthReport> {
  return publicGet<HealthReport>("jarvis-health", "Reading the backend health report");
}

export async function fetchUserAppConfiguration(): Promise<UserAppSnapshot> {
  return publicGet<UserAppSnapshot>("jarvis-languages", "Reading the User App configuration");
}

async function publicGet<T>(name: string, label: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${FUNCTIONS_BASE}/${name}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw toBackendError(error, label);
  }

  const body = await response.text();
  if (!response.ok) throw statusMessage(response.status, body, label);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new BackendError(`${label}: the backend returned a response that is not JSON.`, {
      status: response.status,
    });
  }
}

/* -------------------------------------------------------------- row types ---- */

type LanguageRowLite = LanguageRow;
type VoiceRowLite = VoiceRow;
type SystemStateRowLite = SystemStateRow;
type AssistantPolicyRowLite = AssistantPolicyRow;