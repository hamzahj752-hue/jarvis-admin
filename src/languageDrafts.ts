/*
 * The language/voice form's rules, as pure functions.
 *
 * These mirror the constraints the database enforces (see
 * supabase/migrations/202610300001_language_voice_configuration.sql) so an
 * administrator is told what is wrong before a request is made. The database
 * stays the authority: when the two disagree, the database's error is what gets
 * shown, verbatim.
 *
 * No DOM in this file, which is what makes the rules directly testable.
 */
import { GENDERS, type Gender } from "./config.ts";
import type { LanguageRow, VoiceRow } from "./types.ts";

export const ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

/*
 * The locale tag the devices resolve with `Locale.forLanguageTag`.
 *
 * Language, then any number of 2-8 character alphanumeric subtags: enough for
 * en, en-IN, hi-IN, zh-Hans-CN and Android's own en-GB-oxendict and
 * en-US-u-hc-h12. It stays deliberately permissive about the subtags because a
 * stricter BCP-47 subset would reject tags Android really does emit, and a
 * rejected tag blocks the administrator over something the platform resolves
 * anyway. What it does reject is what a typing mistake looks like: a missing or
 * spaced language, an underscore, or a bare word where a tag belongs.
 */
export const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface VoiceDraft {
  /** The row currently in the database for this language and gender, if any. */
  existing: VoiceRow | null;
  voice_name: string;
  voice_id: string;
  enabled: boolean;
}

export interface LanguageDraft {
  id: string;
  original: LanguageRow;
  enabled: boolean;
  isDefault: boolean;
  language_code: string;
  display_name: string;
  response_tag: string;
  recognition_tag: string;
  script_rule: string;
  voices: Record<Gender, VoiceDraft>;
}

/** Every problem with the form at once, as one line per problem. */
export function validateDrafts(drafts: LanguageDraft[]): string[] {
  const problems: string[] = [];
  let enabledCount = 0;
  let defaultCount = 0;

  for (const draft of drafts) {
    const label = draft.display_name || draft.id;
    if (!ID_PATTERN.test(draft.id)) {
      problems.push(`${label}: the id must match ${ID_PATTERN.source}.`);
    }
    if (!LANGUAGE_CODE_PATTERN.test(draft.language_code)) {
      problems.push(`${label}: the language code must look like en, en-IN or hi-IN.`);
    }
    if (draft.display_name.length < 1 || draft.display_name.length > 80) {
      problems.push(`${label}: the display name must be 1-80 characters.`);
    }
    if (draft.response_tag.length < 2 || draft.response_tag.length > 35) {
      problems.push(`${label}: the response locale tag must be 2-35 characters.`);
    }
    if (draft.recognition_tag.length < 2 || draft.recognition_tag.length > 35) {
      problems.push(`${label}: the recognition locale tag must be 2-35 characters.`);
    }
    if (draft.script_rule.length < 1 || draft.script_rule.length > 1000) {
      problems.push(`${label}: the response instruction must be 1-1000 characters.`);
    }
    if (draft.enabled) enabledCount += 1;
    if (draft.isDefault) {
      defaultCount += 1;
      if (!draft.enabled) problems.push(`${label}: the default language must also be enabled.`);
    }
    if (!draft.enabled && draft.original.is_default) {
      problems.push(`${label}: choose another enabled language as the default before disabling this one.`);
    }

    for (const gender of GENDERS) {
      const voice = draft.voices[gender];
      const hasId = voice.voice_id.length > 0;
      const hasName = voice.voice_name.length > 0;
      if (!hasId && !hasName) {
        if (voice.existing) {
          problems.push(
            `${label} ${gender}: restore the voice ID and name, or press Remove mapping to delete the stored row.`
          );
        }
        continue;
      }
      if (!hasId || !hasName) {
        problems.push(`${label} ${gender}: a voice needs both a voice name and an exact voice ID.`);
        continue;
      }
      if (voice.voice_id.length > 255) problems.push(`${label} ${gender}: the voice ID must be 1-255 characters.`);
      if (voice.voice_name.length > 120) problems.push(`${label} ${gender}: the voice name must be 1-120 characters.`);
      if (!draft.enabled && voice.enabled) {
        problems.push(`${label} ${gender}: a voice cannot be enabled while its language is disabled.`);
      }
    }
  }

  if (enabledCount === 0) {
    problems.push("At least one language must stay enabled: the User App would have nothing to speak.");
  }
  if (defaultCount === 0) problems.push("Exactly one enabled language must be the default.");
  if (defaultCount > 1) problems.push("Only one language can be the default.");
  return problems;
}

/** True when nothing the administrator typed differs from the stored row. */
export function languageUnchanged(draft: LanguageDraft, language: LanguageRow): boolean {
  return (
    draft.enabled === language.enabled &&
    draft.isDefault === language.is_default &&
    draft.language_code === language.language_code &&
    draft.display_name === language.display_name &&
    draft.response_tag === language.response_tag &&
    draft.recognition_tag === language.recognition_tag &&
    draft.script_rule === language.script_rule
  );
}

export function voiceUnchanged(voice: VoiceDraft, existing: VoiceRow | null, languageCode: string): boolean {
  if (!existing) return false;
  return (
    existing.voice_id === voice.voice_id &&
    existing.voice_name === voice.voice_name &&
    existing.enabled === voice.enabled &&
    existing.language_code === languageCode
  );
}

export interface VoicePayload {
  language_id: string;
  language_code: string;
  gender: Gender;
  voice_id: string;
  voice_name: string;
  enabled: boolean;
  is_primary: boolean;
}

/** Exactly the columns the voice table accepts, so a write never touches the rest. */
export function voicePayload(
  languageId: string,
  languageCode: string,
  gender: Gender,
  voice: VoiceDraft,
  existing: VoiceRow | null
): VoicePayload {
  return {
    language_id: languageId,
    language_code: languageCode,
    gender,
    voice_id: voice.voice_id,
    voice_name: voice.voice_name,
    enabled: voice.enabled,
    is_primary: existing ? existing.is_primary : true,
  };
}