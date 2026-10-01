/*
 * The database and endpoint shapes this panel reads and writes.
 *
 * These mirror the columns created by supabase/migrations. They are the only
 * place a column name is spelled out, so a schema change shows up as a type
 * error here rather than as a silently dropped field in a saved row.
 */

/** public.jarvis_languages */
export type LanguageRow = {
  id: string;
  language_code: string;
  display_name: string;
  response_tag: string;
  recognition_tag: string;
  script_rule: string;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** public.jarvis_language_voices */
export type VoiceRow = {
  id: string;
  language_id: string;
  language_code: string;
  gender: string;
  voice_id: string;
  voice_name: string;
  enabled: boolean;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

/** public.jarvis_system_state */
export type SystemStateRow = {
  id: string;
  jarvis_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** public.jarvis_assistant_policy */
export type AssistantPolicyRow = {
  id: string;
  sms_assistant_enabled: boolean;
  announce_incoming: boolean;
  reply_enabled: boolean;
  confirmation_required: boolean;
  attribution_enabled: boolean;
  attribution_text: string;
  body_timeout_ms: number;
  confirmation_timeout_ms: number;
  call_assistant_enabled: boolean;
  announce_incoming_calls: boolean;
  answer_enabled: boolean;
  confirmation_required_before_answering: boolean;
  auto_answer: boolean;
  auto_reject: boolean;
  decision_timeout_ms: number;
  created_at: string;
  updated_at: string;
}

/** GET /functions/v1/jarvis-health */
export interface HealthReport {
  status: string;
  provider?: string;
  chatModel?: string;
  visionModel?: string;
  searchProvider?: string;
  providers?: { name: string; configured: boolean; models?: string[] }[];
  [key: string]: unknown;
}

/** GET /functions/v1/jarvis-languages - exactly what a User App applies. */
export interface UserAppSnapshot {
  version?: number;
  languages?: {
    id: string;
    language_code: string;
    display_name: string;
    response_tag: string;
    recognition_tag: string;
    script_rule: string;
    enabled: boolean;
    is_default: boolean;
  }[];
  voices?: {
    language_id: string;
    language_code: string;
    gender: string;
    voice_id: string;
    voice_name: string;
    is_primary?: boolean;
  }[];
  jarvisEnabled?: boolean | null;
  systemStateUpdatedAt?: string | null;
  smsPolicy?: Record<string, unknown> | null;
  callPolicy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** The signed-in administrator, as the auth server reports it. */
export interface AdminIdentity {
  email: string | null;
  role: string | null;
  userId: string | null;
}

/** GET /functions/v1/jarvis-admin-stats */
export interface AdminStatsSnapshot {
  totalUsers: number;
}
