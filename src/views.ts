/*
 * Rendering.
 *
 * Every function here only draws what `state` holds, and `state` is only ever
 * filled from a backend response. A value the database did not send is drawn as
 * "unknown", never as a default that looks chosen.
 */
import { POLICY_ROW_ID, SYSTEM_STATE_ROW_ID } from "./config.ts";
import { byId, clear, element, setInline, timestamp } from "./dom.ts";
import { POLICY_NUMBERS, POLICY_SWITCHES } from "./assistantPolicy.ts";
import { activeVoiceRows, state } from "./state.ts";
import type { AssistantPolicyRow } from "./types.ts";

/* -------------------------------------------------------------- dashboard ---- */

function setStat(id: string, value: string, kind: "online" | "offline" | "unknown" | null): void {
  const node = byId(id);
  node.textContent = value;
  node.className = "stat-value" + (kind ? " " + kind : "");
}

export function renderDashboard(): void {
  const enabled = state.languages.filter((language) => language.enabled);

  if (state.systemState === null) {
    setStat("dashJarvis", "—", "unknown");
    byId("dashJarvisSub").textContent = state.systemStateError
      ? state.systemStateError
      : "No system state row in the database";
  } else if (state.systemState.jarvis_enabled) {
    setStat("dashJarvis", "ON", "online");
    byId("dashJarvisSub").textContent =
      `From ${SYSTEM_STATE_ROW_ID} · changed ${timestamp(state.systemState.updated_at)}`;
  } else {
    setStat("dashJarvis", "OFF", "offline");
    byId("dashJarvisSub").textContent =
      `From ${SYSTEM_STATE_ROW_ID} · changed ${timestamp(state.systemState.updated_at)}`;
  }

  setStat("dashLanguages", String(enabled.length), null);
  byId("dashLanguagesSub").textContent = state.languagesError
    ? state.languagesError
    : state.languages.length === enabled.length
      ? "Every configured language is enabled"
      : `${state.languages.length - enabled.length} of ${state.languages.length} configured languages are disabled`;

  const activeVoices = activeVoiceRows();
  setStat("dashVoices", String(activeVoices.length), activeVoices.length === 0 ? "unknown" : null);
  byId("dashVoicesSub").textContent =
    state.voices.length === 0
      ? "No voice mappings configured yet"
      : `${activeVoices.length} of ${state.voices.length} stored mappings are active`;

  if (state.health) {
    const ok = state.health.status === "ok";
    setStat("dashBackend", ok ? "OK" : "DEGRADED", ok ? "online" : "unknown");
    byId("dashBackendSub").textContent = `jarvis-health reported "${state.health.status}"`;
  } else {
    setStat("dashBackend", "—", "unknown");
    byId("dashBackendSub").textContent = state.healthError
      ? `jarvis-health has not answered — ${state.healthError}`
      : "jarvis-health has not answered";
  }

  renderServices();
  renderConnection();
}

function renderServices(): void {
  const list = byId("serviceList");
  clear(list);

  const add = (name: string, label: string, status: string, note: string): void => {
    const box = element("div", "service");
    const top = element("div", "service-top");
    top.appendChild(element("strong", null, name));
    top.appendChild(element("span", status, label));
    box.appendChild(top);
    box.appendChild(element("small", null, note));
    list.appendChild(box);
  };

  if (state.systemState === null) {
    add(
      "JARVIS Core",
      "● Unknown",
      "unknown",
      state.systemStateError ?? "No system state row in public.jarvis_system_state"
    );
  } else {
    add(
      "JARVIS Core",
      state.systemState.jarvis_enabled ? "● Enabled" : "● Disabled",
      state.systemState.jarvis_enabled ? "online" : "offline",
      `Persisted switch, last changed ${timestamp(state.systemState.updated_at)}`
    );
  }

  if (state.languagesEndpointError) {
    add("Language API", "● Unavailable", "offline", state.languagesEndpointError);
  } else if (state.languagesEndpoint) {
    add(
      "Language API",
      "● Reachable",
      "online",
      `Returned ${(state.languagesEndpoint.languages ?? []).length} active language(s) and ` +
        `${(state.languagesEndpoint.voices ?? []).length} active voice mapping(s)`
    );
  } else {
    add("Language API", "● Not checked", "unknown", "Refresh the dashboard to probe jarvis-languages");
  }

  const activeVoices = activeVoiceRows();
  if (activeVoices.length === 0) {
    add(
      "Voice Engine",
      "● Not configured",
      "unknown",
      "No enabled voice mapping exists for an enabled language"
    );
  } else {
    add(
      "Voice Engine",
      "● Configured",
      "online",
      `${activeVoices.length} exact engine voice ID(s) published to the User App`
    );
  }

  if (state.assistantPolicy === null) {
    add(
      "Assistant Policy",
      "● Not available",
      state.assistantPolicyError ? "offline" : "unknown",
      state.assistantPolicyError ??
        `No row with id=${POLICY_ROW_ID} exists yet; the apps run their shipped defaults`
    );
  } else {
    add(
      "Assistant Policy",
      "● Loaded",
      "online",
      `SMS and call policy row changed ${timestamp(state.assistantPolicy.updated_at)}`
    );
  }
}

function renderConnection(): void {
  const dot = byId("connectionDot");
  const label = byId("connectionText");
  dot.className = "dot";

  if (!state.user) {
    label.textContent = "Signed out";
    return;
  }
  if (state.health && state.languagesEndpoint && !state.languagesEndpointError) {
    dot.classList.add("green");
    label.textContent = "Backend verified just now";
    return;
  }
  if (state.healthError) {
    dot.classList.add("red");
    label.textContent = `Gateway unreachable — ${state.healthError}`;
    return;
  }
  dot.classList.add("yellow");
  label.textContent = "Signed in as administrator";
}

/* ------------------------------------------------------------------ jarvis ---- */

export function renderJarvis(): void {
  const known = state.systemState !== null;
  const enabled = known && state.systemState ? !!state.systemState.jarvis_enabled : false;
  const toggle = byId("jarvisSwitch") as HTMLInputElement;
  toggle.checked = enabled;
  toggle.disabled = !known || state.saving;
  byId("jarvisStateMeta").textContent =
    known && state.systemState
      ? `row id=${state.systemState.id} · jarvis_enabled=${state.systemState.jarvis_enabled} · updated ${timestamp(state.systemState.updated_at)}`
      : state.systemStateError ?? `No row with id=${SYSTEM_STATE_ROW_ID} was returned by the database.`;
}

/* -------------------------------------------------------- assistant policy ---- */

export function renderAssistantPolicy(): void {
  const row: AssistantPolicyRow | null = state.assistantPolicy;
  const known = row !== null;
  const disabled = !known || state.saving;

  for (const [id, column] of POLICY_SWITCHES) {
    const box = byId(id) as HTMLInputElement;
    /* A null column is reported as unchecked-but-unknown rather than written
       over: writing false over a value that was never chosen would turn an
       absent decision into one. */
    box.checked = known && row && typeof row[column] === "boolean" ? row[column] : false;
    box.disabled = disabled;
  }

  const attribution = byId("policyAttributionText") as HTMLInputElement;
  attribution.value = known && row && typeof row.attribution_text === "string" ? row.attribution_text : "";
  attribution.disabled = disabled;

  for (const field of POLICY_NUMBERS) {
    const input = byId(field.id) as HTMLInputElement;
    const stored = row ? row[field.column as keyof AssistantPolicyRow] : null;
    input.value = typeof stored === "number" && Number.isFinite(stored) ? String(stored) : "";
    input.disabled = disabled;
  }

  const save = byId("saveAssistantPolicy") as HTMLButtonElement;
  save.disabled = disabled;
  (byId("refreshAssistantPolicy") as HTMLButtonElement).disabled = state.saving;

  byId("policyMeta").textContent =
    known && row
      ? `row id=${row.id} · updated ${timestamp(row.updated_at)}`
      : state.assistantPolicyError ??
        `No row with id=${POLICY_ROW_ID} was returned. The apps are running their shipped defaults until the migration creates it.`;
}

/* --------------------------------------------------------------------- ai ---- */

export function renderAi(): void {
  if (!state.health) {
    byId("aiProvider").textContent = "Unavailable";
    byId("aiModel").textContent = "Unavailable";
    byId("aiSearch").textContent = "Unavailable";
    byId("aiModels").textContent = "Unavailable";
    return;
  }
  byId("aiProvider").textContent = state.health.provider ?? "none reported";
  byId("aiModel").textContent =
    `${state.health.chatModel ?? "none"} (chat) · ${state.health.visionModel ?? "none"} (vision)`;
  byId("aiSearch").textContent = state.health.searchProvider ?? "none reported";
  const providers = Array.isArray(state.health.providers) ? state.health.providers : [];
  if (providers.length === 0) {
    byId("aiModels").textContent = "none reported";
    return;
  }
  byId("aiModels").textContent = providers
    .map((entry) =>
      `${entry.name}: ${
        entry.configured ? (entry.models ?? []).join(", ") || "configured, no models" : "not configured"
      }`
    )
    .join("  |  ");
}

/* -------------------------------------------------------- user app mirror ---- */

export function updateUserViewFromState(): void {
  const payload = state.languagesEndpoint;
  if (!payload) return;
  const lines: string[] = [
    `version: ${String(payload.version)}`,
    `jarvisEnabled: ${JSON.stringify(payload.jarvisEnabled ?? null)}`,
    `languages (${(payload.languages ?? []).length}):`
  ];
  for (const language of payload.languages ?? []) {
    lines.push(
      `  ${language.id}  ${language.display_name}  ${language.language_code}` +
        `  default=${language.is_default}  response=${language.response_tag}  recognition=${language.recognition_tag}`
    );
  }
  lines.push(`voices (${(payload.voices ?? []).length}):`);
  for (const voice of payload.voices ?? []) {
    lines.push(`  ${voice.language_id}  ${voice.gender}  ${voice.voice_id}  "${voice.voice_name}"`);
  }
  const sms = payload.smsPolicy;
  const call = payload.callPolicy;
  lines.push(`smsPolicy: ${sms ? JSON.stringify(sms) : "absent — the app uses its shipped defaults"}`);
  lines.push(`callPolicy: ${call ? JSON.stringify(call) : "absent — the app uses its shipped defaults"}`);
  byId("userView").textContent = lines.join("\n");
  /* Whoever fetched it - the dashboard probe or the button - the panel must say
     the mirror is current rather than leaving an empty status next to live data. */
  setInline("userViewStatus", "Fetched just now.", "ok");
}

/* --------------------------------------------------------------- controls ---- */

/**
 * One place that decides which write controls are usable, so no page can be left
 * in a state where a second save can be started on top of a first.
 */
export function setControlsDisabled(disabled: boolean): void {
  const locked = disabled || state.saving;
  (byId("saveLanguages") as HTMLButtonElement).disabled = locked;
  (byId("refreshLanguages") as HTMLButtonElement).disabled = locked;
  (byId("refreshJarvis") as HTMLButtonElement).disabled = locked;
  (byId("jarvisSwitch") as HTMLInputElement).disabled = locked || state.systemState === null;
  (byId("saveAssistantPolicy") as HTMLButtonElement).disabled = locked || state.assistantPolicy === null;
  (byId("refreshAssistantPolicy") as HTMLButtonElement).disabled = locked;
  for (const button of byId("nav").querySelectorAll("button")) {
    (button as HTMLButtonElement).disabled = locked || !state.user;
  }
}