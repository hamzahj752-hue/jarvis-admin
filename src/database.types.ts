/*
 * Hand-written types for the JARVIS tables this panel owns.
 *
 * `jarvis_languages`, `jarvis_language_voices`, `jarvis_system_state` and
 * `jarvis_assistant_policy` are created and constrained by the migrations in
 * supabase/migrations. Typing them here makes a column rename a compile error in
 * the panel instead of a runtime surprise: a select that asks for a column the
 * table does not have comes back as a PostgREST error rather than as data that
 * silently omits a setting.
 */
import type {
  AssistantPolicyRow,
  LanguageRow,
  SystemStateRow,
  VoiceRow,
} from "./types.ts";

type Timestamped = { created_at: string; updated_at: string };

export type LanguageInsert = Omit<LanguageRow, keyof Timestamped>;
export type LanguageUpdate = Partial<Omit<LanguageRow, "id">>;

export type VoiceInsert = Omit<VoiceRow, "id" | keyof Timestamped>;
export type VoiceUpdate = Partial<Omit<VoiceRow, "id">>;

export type SystemStateUpdate = Partial<Omit<SystemStateRow, "id">>;
export type AssistantPolicyUpdate = Partial<Omit<AssistantPolicyRow, "id">>;

type Table<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      jarvis_languages: Table<LanguageRow, LanguageInsert, LanguageUpdate>;
      jarvis_language_voices: Table<VoiceRow, VoiceInsert, VoiceUpdate>;
      jarvis_system_state: Table<SystemStateRow, Partial<Omit<SystemStateRow, keyof Timestamped>>, SystemStateUpdate>;
      jarvis_assistant_policy: Table<
        AssistantPolicyRow,
        Partial<Omit<AssistantPolicyRow, "id" | keyof Timestamped>>,
        AssistantPolicyUpdate
      >;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}