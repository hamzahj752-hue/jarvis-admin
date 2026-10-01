/*
 * The panel's single source of rendered truth.
 *
 * Every field here is filled from a backend response and is cleared on sign-out.
 * Nothing is ever read back out of localStorage: the browser only ever holds the
 * Supabase session handle, and the page re-reads the database on every load, so
 * what is on screen is always what the database actually says.
 */
import type {
  AdminIdentity,
  AssistantPolicyRow,
  HealthReport,
  LanguageRow,
  SystemStateRow,
  UserAppSnapshot,
  VoiceRow,
} from "./types.ts";

export interface AdminState {
  /** The verified administrator. Null means signed out. */
  user: AdminIdentity | null;
  languages: LanguageRow[];
  voices: VoiceRow[];
  /** Per-section load failures, so one broken section cannot blank the others. */
  languagesError: string | null;
  systemState: SystemStateRow | null;
  systemStateError: string | null;
  assistantPolicy: AssistantPolicyRow | null;
  assistantPolicyError: string | null;
  health: HealthReport | null;
  healthError: string | null;
  languagesEndpoint: UserAppSnapshot | null;
  languagesEndpointError: string | null;
  /** True while a full reload is in flight; drives the busy messages. */
  loading: boolean;
  /** True while a write is in flight; every write control is disabled. */
  saving: boolean;
}

export const state: AdminState = {
  user: null,
  languages: [],
  voices: [],
  languagesError: null,
  systemState: null,
  systemStateError: null,
  assistantPolicy: null,
  assistantPolicyError: null,
  health: null,
  healthError: null,
  languagesEndpoint: null,
  languagesEndpointError: null,
  loading: false,
  saving: false,
};

export function resetConfiguration(): void {
  state.languages = [];
  state.voices = [];
  state.languagesError = null;
  state.systemState = null;
  state.systemStateError = null;
  state.assistantPolicy = null;
  state.assistantPolicyError = null;
  state.health = null;
  state.healthError = null;
  state.languagesEndpoint = null;
  state.languagesEndpointError = null;
  state.loading = false;
  state.saving = false;
}

/** The single stored voice mapping for a language and gender, if there is one. */
export function voiceRow(languageId: string, gender: string): VoiceRow | null {
  return state.voices.find((voice) => voice.language_id === languageId && voice.gender === gender) ?? null;
}

/**
 * Exactly the mappings a User App receives right now: enabled, and belonging to
 * an enabled language. Derived rather than stored so the panel can never show a
 * count that disagrees with the public endpoint.
 */
export function activeVoiceRows(): VoiceRow[] {
  const enabled = new Set(state.languages.filter((language) => language.enabled).map((language) => language.id));
  return state.voices.filter((voice) => voice.enabled && enabled.has(voice.language_id));
}