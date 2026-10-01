/*
 * The Languages & Voices page: the cards, the form state, and the save.
 *
 * The save is deliberately ordered and deliberately partial:
 *
 *  * Only rows that actually changed are written. Re-saving an untouched page
 *    produces no requests at all, so a mis-click cannot rewrite settings nobody
 *    meant to change.
 *  * Each write is checked for confirmation. PostgREST reports a row-level
 *    security rejection or a constraint violation as "no rows returned", and a
 *    page that treated that as success would report a save that never happened.
 *  * After every save the page re-reads the database instead of trusting the
 *    form, so what is on screen is what the User App will be served.
 */
import { GENDERS, type Gender } from "./config.ts";
import { byId, clear, element, setInline, text, timestamp } from "./dom.ts";
import { BackendError } from "./errors.ts";
import {
  clearOtherDefaults,
  deleteVoice,
  fetchLanguages,
  insertVoice,
  syncVoiceLanguageCode,
  updateLanguage,
  updateVoice
} from "./backend.ts";
import { state, voiceRow } from "./state.ts";
import {
  languageUnchanged,
  validateDrafts,
  voicePayload,
  voiceUnchanged,
  type LanguageDraft,
  type VoiceDraft
} from "./languageDrafts.ts";
import { updateUserViewFromState } from "./views.ts";
import type { LanguageRow } from "./types.ts";

interface Field {
  wrap: HTMLLabelElement;
  input: HTMLInputElement;
}

function buildField(labelText: string, value: string, disabled: boolean): Field {
  const wrap = element("label", "field");
  wrap.appendChild(element("span", null, labelText));
  const input = document.createElement("input");
  input.type = "text";
  input.value = value == null ? "" : value;
  input.disabled = !!disabled;
  input.spellcheck = false;
  input.autocomplete = "off";
  wrap.appendChild(input);
  return { wrap, input };
}

function buildTextArea(labelText: string, value: string, disabled: HTMLTextAreaElement["disabled"]) {
  const wrap = element("label", "field");
  wrap.appendChild(element("span", null, labelText));
  const area = document.createElement("textarea");
  area.value = value == null ? "" : value;
  area.disabled = !!disabled;
  area.rows = 3;
  area.style.minHeight = "72px";
  area.style.resize = "vertical";
  area.style.background = "#080d14";
  area.style.color = "white";
  area.style.border = "1px solid rgba(255,255,255,.08)";
  area.style.borderRadius = "9px";
  area.style.padding = "10px";
  area.style.outline = "none";
  wrap.appendChild(area);
  return { wrap, input: area };
}

function buildToggle(labelText: string, checked: boolean, disabled: boolean): Field {
  const label = element("label", "toggle");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.disabled = !!disabled;
  label.appendChild(input);
  label.appendChild(text(labelText));
  return { wrap: label, input };
}

export interface VoiceCardControls {
  name: HTMLInputElement;
  id: HTMLInputElement;
  enabled: HTMLInputElement;
  remove: HTMLButtonElement | null;
}

export interface LanguageCardControls {
  enable: HTMLInputElement;
  isDefault: HTMLInputElement;
  displayName: HTMLInputElement;
  languageCode: HTMLInputElement;
  responseTag: HTMLInputElement;
  recognitionTag: HTMLInputElement;
  scriptRule: HTMLTextAreaElement;
  voices: Record<Gender, VoiceCardControls>;
  syncVoiceAvailability: () => void;
}

/**
 * The live controls of each rendered card, keyed by language id.
 *
 * Kept beside the rows rather than attached to them: the row objects are exactly
 * what the database returned and must not gain anything this page made up.
 */
const cardControls = new Map<string, LanguageCardControls>();

export function languageCardControls(id: string): LanguageCardControls | undefined {
  return cardControls.get(id);
}

/** Builds one language card from the database row it was given. */
function buildLanguageCard(language: LanguageRow): HTMLElement {
  const card = element("article", "language");

  const head = element("div", "language-head");
  const identity = element("div");
  identity.appendChild(element("div", "language-name", language.display_name));
  identity.appendChild(
    element(
      "div",
      "language-code",
      `${language.language_code || "?"} · id ${language.id} · updated ${timestamp(language.updated_at)}`
    )
  );
  head.appendChild(identity);

  const toggles = element("div", "language-toggles");
  const enableToggle = buildToggle("Enabled", language.enabled, false);
  toggles.appendChild(enableToggle.wrap);

  const defaultLabel = element("label", "toggle");
  const defaultRadio = document.createElement("input");
  defaultRadio.type = "radio";
  defaultRadio.name = "jarvis-default-language";
  defaultRadio.value = language.id;
  defaultRadio.checked = !!language.is_default;
  defaultRadio.disabled = state.saving;
  defaultLabel.appendChild(defaultRadio);
  defaultLabel.appendChild(text("Default"));
  toggles.appendChild(defaultLabel);
  head.appendChild(toggles);
  card.appendChild(head);

  const detail = element("div", "voicegrid");
  const displayName = buildField("Display name", language.display_name, state.saving);
  const code = buildField("Language code", language.language_code, state.saving);
  const responseTag = buildField("Response locale tag", language.response_tag, state.saving);
  const recognitionTag = buildField("Recognition locale tag", language.recognition_tag, state.saving);
  detail.appendChild(displayName.wrap);
  detail.appendChild(code.wrap);
  detail.appendChild(responseTag.wrap);
  detail.appendChild(recognitionTag.wrap);

  const rule = buildTextArea("Language response instruction", language.script_rule, state.saving);
  detail.appendChild(rule.wrap);
  card.appendChild(detail);

  const voiceGrid = element("div", "voicegrid");
  voiceGrid.style.marginTop = "13px";
  const voices = {} as Record<Gender, VoiceCardControls>;

  for (const gender of GENDERS) {
    const existing = voiceRow(language.id, gender);
    const box = element("div", "voicebox");
    box.appendChild(element("strong", null, gender.charAt(0).toUpperCase() + gender.slice(1) + " voice"));

    const name = buildField("Voice name", existing ? existing.voice_name : "", state.saving);
    const id = buildField("Exact Android voice ID", existing ? existing.voice_id : "", state.saving);
    box.appendChild(name.wrap);
    box.appendChild(id.wrap);

    const mappingToggle = buildToggle(
      "Mapping enabled",
      existing ? existing.enabled : false,
      state.saving || !existing
    );
    box.appendChild(mappingToggle.wrap);

    let remove: HTMLButtonElement | null = null;
    if (existing) {
      box.appendChild(
        element(
          "div",
          "language-code",
          `In the database since ${timestamp(existing.created_at)} · changed ${timestamp(existing.updated_at)}`
        )
      );
      remove = element("button", "btn danger", "Remove mapping");
      remove.type = "button";
      remove.disabled = state.saving;
      remove.addEventListener("click", () => {
        void removeVoice(language, gender);
      });
      box.appendChild(remove);
    } else {
      box.appendChild(element("div", "language-code", "No mapping stored for this language and gender."));
    }

    voices[gender] = { name: name.input, id: id.input, enabled: mappingToggle.input, remove };
    voiceGrid.appendChild(box);
  }

  card.appendChild(voiceGrid);

  /*
   * A voice cannot exist for a disabled language: the database refuses the row.
   * Disabling the fields keeps the form from offering an unsaveable edit.
   */
  const syncVoiceAvailability = (): void => {
    const editable = language.enabled && !state.saving;
    for (const gender of GENDERS) {
      const voice = voices[gender];
      voice.name.disabled = !editable;
      voice.id.disabled = !editable;
      voice.enabled.disabled = !editable;
      if (voice.remove) voice.remove.disabled = state.saving;
    }
  };

  enableToggle.input.addEventListener("change", () => {
    syncVoiceAvailability();
    setInline(
      "languageStatus",
      language.enabled
        ? `${language.display_name} is still disabled in the database until you save. Saving will also switch off its voice mappings.`
        : `${language.display_name} is still enabled in the database until you save. Its voices stay switched off while it is disabled.`,
      ""
    );
  });
  defaultRadio.addEventListener("change", () => {
    if (defaultRadio.checked && !enableToggle.input.checked) {
      enableToggle.input.checked = true;
      syncVoiceAvailability();
      setInline("languageStatus", `Making ${language.display_name} the default enabled it too. Save to apply.`, "");
    }
  });

  syncVoiceAvailability();

  cardControls.set(language.id, {
    enable: enableToggle.input,
    isDefault: defaultRadio,
    displayName: displayName.input,
    languageCode: code.input,
    responseTag: responseTag.input,
    recognitionTag: recognitionTag.input,
    scriptRule: rule.input,
    voices,
    syncVoiceAvailability
  });

  return card;
}

export function renderLanguages(): void {
  const list = byId("languageList");
  clear(list);
  cardControls.clear();

  for (const language of state.languages) {
    list.appendChild(buildLanguageCard(language));
  }

  if (state.languages.length === 0) {
    const empty = element("div", "service");
    empty.appendChild(
      element(
        "small",
        null,
        state.languagesError ? state.languagesError : "The database returned no language rows."
      )
    );
    list.appendChild(empty);
  }

  updateUserViewFromState();
}

/** Reads every card into a draft, so one save can compare and write all of it. */
export function readLanguageDrafts(): LanguageDraft[] {
  const drafts: LanguageDraft[] = [];
  for (const language of state.languages) {
    const controls = cardControls.get(language.id);
    if (!controls) continue;
    const enabled = controls.enable.checked;
    const voices = {} as Record<Gender, VoiceDraft>;
    for (const gender of GENDERS) {
      const voice = controls.voices[gender];
      voices[gender] = {
        existing: voiceRow(language.id, gender),
        voice_name: voice.name.value.trim(),
        voice_id: voice.id.value.trim(),
        /* A disabled language cannot have an enabled voice, so saving a disabled
           language switches its stored mappings off instead of refusing the whole
           save. The id and name are preserved either way. */
        enabled: enabled ? voice.enabled.checked : false
      };
    }
    drafts.push({
      id: language.id,
      original: language,
      enabled,
      isDefault: controls.isDefault.checked,
      language_code: controls.languageCode.value.trim(),
      display_name: controls.displayName.value.trim(),
      response_tag: controls.responseTag.value.trim(),
      recognition_tag: controls.recognitionTag.value.trim(),
      script_rule: controls.scriptRule.value.trim(),
      voices
    });
  }
  return drafts;
}

/** Re-reads languages and voices, replacing the cards. */
export async function reloadLanguageRows(): Promise<void> {
  const { languages, voices } = await fetchLanguages();
  state.languages = languages;
  state.voices = voices;
  state.languagesError = null;
  renderLanguages();
}

/**
 * Writes every changed value on the page.
 *
 * Nothing is written for a row that did not change, and every write is confirmed
 * by the server before the page reports success.
 */
export async function saveLanguages(): Promise<void> {
  if (state.saving) return;
  const drafts = readLanguageDrafts();
  const problems = validateDrafts(drafts);
  if (problems.length > 0) {
    setInline("languageStatus", problems.join("\n"), "error");
    return;
  }

  state.saving = true;
  lockForm(true);
  setInline("languageStatus", "Saving to Supabase…", "busy");

  try {
    for (const draft of drafts) {
      const language = draft.original;
      const label = draft.display_name || language.id;

      if (!languageUnchanged(draft, language)) {
        /* One default at a time: clear the incumbent first, because the database
           enforces a single default and will refuse two of them. */
        if (draft.isDefault && !language.is_default) {
          await clearOtherDefaults(draft.id);
        }

        const saved = await updateLanguage(draft.id, {
          language_code: draft.language_code,
          display_name: draft.display_name,
          response_tag: draft.response_tag,
          recognition_tag: draft.recognition_tag,
          script_rule: draft.script_rule,
          enabled: draft.enabled,
          is_default: draft.isDefault
        });

        if (draft.language_code !== language.language_code) {
          await syncVoiceLanguageCode(draft.id, draft.language_code);
        }
        /* `saved` is what the database echoed; the reload below is what the rest
           of the page should trust, so nothing here depends on it beyond the
           write having been accepted. */
        void saved;
      }

      for (const gender of GENDERS) {
        const voice = draft.voices[gender];
        const blank = voice.voice_id.length === 0 && voice.voice_name.length === 0;

        /* Nothing typed and nothing stored is not a request: an empty row would
           be refused by the database, and inventing one is not an option. */
        if (blank && !voice.existing) continue;
        if (blank && voice.existing) {
          throw new BackendError(
            `The ${gender} voice for ${label} has no voice ID or name. Restore them, or press Remove mapping.`,
            {}
          );
        }
        if (voiceUnchanged(voice, voice.existing, draft.language_code)) continue;

        const payload = voicePayload(draft.id, draft.language_code, gender, voice, voice.existing);
        if (voice.existing) {
          await updateVoice(draft.id, gender, payload);
        } else {
          await insertVoice(payload);
        }
      }
    }

    /* The database is the source of truth: re-read it rather than trusting the
       form, so what is on screen is what the User App will get. */
    await reloadLanguageRows();
    setInline("languageStatus", "Saved. The User App picks this up on its next configuration refresh.", "ok");
  } catch (error) {
    setInline("languageStatus", error instanceof Error ? error.message : String(error), "error");
    /* Whatever was written before the failure is applied; the form is re-read so
       the administrator sees the real state and can retry only what is left. */
    try {
      await reloadLanguageRows();
    } catch {
      /* The save failure is the one worth showing. */
    }
  } finally {
    state.saving = false;
    lockForm(false);
  }
}

/** Deletes one stored voice mapping, after an explicit confirmation. */
export async function removeVoice(language: LanguageRow, gender: Gender): Promise<void> {
  if (state.saving) return;
  const label = `${language.display_name || language.id} ${gender} voice`;
  if (!window.confirm(`Remove the ${label} mapping? The User App will stop receiving it.`)) return;

  state.saving = true;
  lockForm(true);
  setInline("languageStatus", `Removing the ${label} mapping…`, "busy");
  try {
    await deleteVoice(language.id, gender);
    await reloadLanguageRows();
    setInline("languageStatus", `${label} mapping removed.`, "ok");
  } catch (error) {
    setInline("languageStatus", error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.saving = false;
    lockForm(false);
  }
}

/** Locks every editable control on this page while a write is in flight. */
export function lockForm(locked: boolean): void {
  (byId("saveLanguages") as HTMLButtonElement).disabled = locked;
  (byId("refreshLanguages") as HTMLButtonElement).disabled = locked;
  for (const language of state.languages) {
    const controls = cardControls.get(language.id);
    if (!controls) continue;
    controls.enable.disabled = locked;
    controls.isDefault.disabled = locked;
    controls.displayName.disabled = locked;
    controls.languageCode.disabled = locked;
    controls.responseTag.disabled = locked;
    controls.recognitionTag.disabled = locked;
    controls.scriptRule.disabled = locked;
    for (const gender of GENDERS) {
      const voice = controls.voices[gender];
      const exists = voiceRow(language.id, gender) !== null;
      voice.name.disabled = locked || !language.enabled;
      voice.id.disabled = locked || !language.enabled;
      voice.enabled.disabled = locked || !language.enabled || !exists;
      if (voice.remove) voice.remove.disabled = locked;
    }
  }
}