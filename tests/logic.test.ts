import { describe, expect, it } from "vitest";
import {
  ID_PATTERN,
  LANGUAGE_CODE_PATTERN,
  languageUnchanged,
  validateDrafts,
  voicePayload,
  voiceUnchanged,
  type LanguageDraft
} from "../src/languageDrafts.ts";
import { parsePolicyNumber, validateAttributionText, POLICY_NUMBERS, POLICY_SWITCHES } from "../src/assistantPolicy.ts";
import { identityOf, isAdmin, readOauthResult } from "../src/auth.ts";
import type { LanguageRow, VoiceRow } from "../src/types.ts";

function row(overrides: Partial<LanguageRow> = {}): LanguageRow {
  return {
    id: "english",
    language_code: "en",
    display_name: "English",
    response_tag: "en",
    recognition_tag: "en",
    script_rule: "- Reply in English.",
    enabled: true,
    is_default: true,
    created_at: "2026-09-30T12:00:00.000Z",
    updated_at: "2026-09-30T12:00:00.000Z",
    ...overrides
  };
}

function draft(overrides: Partial<LanguageDraft> = {}): LanguageDraft {
  return {
    id: "english",
    original: row(),
    enabled: true,
    isDefault: true,
    language_code: "en",
    display_name: "English",
    response_tag: "en",
    recognition_tag: "en",
    script_rule: "- Reply in English.",
    voices: {
      male: { existing: null, voice_name: "", voice_id: "", enabled: false },
      female: { existing: null, voice_name: "", voice_id: "", enabled: false }
    },
    ...overrides
  };
}

function voice(overrides: Partial<VoiceRow> = {}): VoiceRow {
  return {
    id: "v-1",
    language_id: "english",
    language_code: "en",
    gender: "male",
    voice_id: "en-us-x-sfg#1",
    voice_name: "English (United States)",
    enabled: true,
    is_primary: true,
    created_at: "2026-09-30T12:00:00.000Z",
    updated_at: "2026-09-30T12:00:00.000Z",
    ...overrides
  };
}

describe("language form rules", () => {
  it("accepts a single valid row and finds nothing wrong with it", () => {
    expect(validateDrafts([draft()])).toEqual([]);
  });

  it("insists on exactly one enabled default", () => {
    expect(validateDrafts([draft({ enabled: false, isDefault: false })])).toContain(
      "At least one language must stay enabled: the User App would have nothing to speak."
    );
    expect(validateDrafts([draft({ isDefault: false })])).toContain("Exactly one enabled language must be the default.");
    expect(
      validateDrafts([
        draft({ id: "hindi", original: row({ id: "hindi", is_default: false }) }),
        draft({ id: "tamil", original: row({ id: "tamil", is_default: false }) })
      ])
    ).toContain("Only one language can be the default.");
  });

  it("refuses to disable the language that is currently the default", () => {
    const problems = validateDrafts([
      draft({ id: "hindi", original: row({ id: "hindi", is_default: true }), enabled: false, isDefault: false }),
      draft({ id: "arabic", original: row({ id: "arabic", is_default: false }), isDefault: true })
    ]);
    expect(problems.some((problem) => problem.includes("choose another enabled language as the default"))).toBe(true);
  });

  it("requires a voice name and an exact voice id together", () => {
    const problems = validateDrafts([
      draft({
        voices: {
          male: { existing: null, voice_name: "English (United States)", voice_id: "", enabled: false },
          female: { existing: null, voice_name: "", voice_id: "", enabled: false }
        }
      })
    ]);
    expect(problems).toContain("English male: a voice needs both a voice name and an exact voice ID.");
  });

  it("will not quietly blank a stored mapping", () => {
    const problems = validateDrafts([
      draft({
        voices: {
          male: { existing: voice(), voice_name: "", voice_id: "", enabled: false },
          female: { existing: null, voice_name: "", voice_id: "", enabled: false }
        }
      })
    ]);
    expect(problems).toContain(
      "English male: restore the voice ID and name, or press Remove mapping to delete the stored row."
    );
  });

  it("refuses a voice enabled under a disabled language", () => {
    const problems = validateDrafts([
      draft({
        enabled: false,
        isDefault: false,
        voices: {
          male: { existing: voice(), voice_name: "English", voice_id: "en-us#1", enabled: true },
          female: { existing: null, voice_name: "", voice_id: "", enabled: false }
        }
      })
    ]);
    expect(problems).toContain("English male: a voice cannot be enabled while its language is disabled.");
  });

  it("names the field for every malformed column", () => {
    const problems = validateDrafts([
      draft({
        id: "Not A Valid Id",
        language_code: "english!",
        display_name: "",
        response_tag: "e",
        recognition_tag: "e",
        script_rule: ""
      })
    ]);
    expect(problems.join("\n")).toContain("the id must match");
    expect(problems.join("\n")).toContain("the language code must look like en, en-IN or hi-IN.");
    expect(problems.join("\n")).toContain("the display name must be 1-80 characters.");
    expect(problems.join("\n")).toContain("the response locale tag must be 2-35 characters.");
    expect(problems.join("\n")).toContain("the recognition locale tag must be 2-35 characters.");
    expect(problems.join("\n")).toContain("the response instruction must be 1-1000 characters.");
  });

  it("accepts the identifier and locale shapes the database allows", () => {
    for (const id of ["en", "en-gb", "pt_br2", "zh-hans"]) {
      expect(ID_PATTERN.test(id)).toBe(true);
    }
    for (const id of ["E", "1en", "en!", "a".repeat(33)]) {
      expect(ID_PATTERN.test(id)).toBe(false);
    }
    for (const code of ["en", "hin", "en-IN", "zh-Hans-CN", "en-GB-oxendict", "es-419"]) {
      expect(LANGUAGE_CODE_PATTERN.test(code)).toBe(true);
    }
    for (const code of ["e", "english", "en-", "en_IN", "en-1", "-en", "en GB"]) {
      expect(LANGUAGE_CODE_PATTERN.test(code)).toBe(false);
    }
  });

  it("notices exactly the fields that were edited", () => {
    expect(languageUnchanged(draft(), row())).toBe(true);
    expect(languageUnchanged(draft({ display_name: "English (UK)" }), row())).toBe(false);
    expect(languageUnchanged(draft({ enabled: false, isDefault: false }), row())).toBe(false);
  });

  it("treats a brand new mapping as changed and keeps is_primary off existing rows", () => {
    const typed = { existing: null, voice_name: "Hindi", voice_id: "hi-in#1", enabled: true };
    expect(voiceUnchanged(typed, null, "hi")).toBe(false);
    expect(voicePayload("hindi", "hi", "female", typed, null)).toEqual({
      language_id: "hindi",
      language_code: "hi",
      gender: "female",
      voice_id: "hi-in#1",
      voice_name: "Hindi",
      enabled: true,
      is_primary: true
    });

    const existing = voice({ is_primary: false });
    const kept = { existing, voice_name: existing.voice_name, voice_id: existing.voice_id, enabled: true };
    expect(voiceUnchanged(kept, existing, "en")).toBe(true);
    expect(voicePayload("english", "en", "male", kept, existing).is_primary).toBe(false);
  });

  it("writes only the columns the voice table accepts", () => {
    const payload = voicePayload(
      "english",
      "en",
      "male",
      { existing: voice(), voice_name: "English", voice_id: "en-us#1", enabled: true },
      voice()
    );
    expect(Object.keys(payload).sort()).toEqual([
      "enabled",
      "gender",
      "is_primary",
      "language_code",
      "language_id",
      "voice_id",
      "voice_name"
    ]);
  });
});

describe("policy field rules", () => {
  it("clamps nothing silently: it names the column and its bounds", () => {
    const field = POLICY_NUMBERS[0]!;
    expect(parsePolicyNumber(" 20000 ", field)).toBe(20000);
    expect(() => parsePolicyNumber("", field)).toThrow(/body_timeout_ms must be a whole number/);
    expect(() => parsePolicyNumber("20 000", field)).toThrow();
    expect(() => parsePolicyNumber("1", field)).toThrow(/between 5000 and 120000/);
    expect(() => parsePolicyNumber("999999", field)).toThrow(/between 5000 and 120000/);
  });

  it("bounds the attribution text the same way the database check does", () => {
    expect(validateAttributionText("x".repeat(120))).toBeNull();
    expect(validateAttributionText("x".repeat(121))).toContain("120 characters or fewer");
  });

  it("covers every negotiable column exactly once", () => {
    expect(POLICY_SWITCHES.map(([, column]) => column)).toEqual([
      "sms_assistant_enabled",
      "announce_incoming",
      "reply_enabled",
      "call_assistant_enabled",
      "announce_incoming_calls",
      "answer_enabled",
      "auto_answer",
      "auto_reject"
    ]);
    expect(new Set(POLICY_NUMBERS.map((field) => field.column)).size).toBe(3);
  });
});

describe("identity", () => {
  it("trusts app_metadata and never user_metadata", () => {
    const promoted = identityOf({
      id: "u-1",
      email: "someone@example.com",
      app_metadata: {},
      user_metadata: { role: "admin" }
    } as never);
    expect(promoted.role).toBeNull();
    expect(isAdmin(promoted)).toBe(false);

    const real = identityOf({
      id: "u-1",
      email: "someone@example.com",
      app_metadata: { role: "admin" },
      user_metadata: {}
    } as never);
    expect(isAdmin(real)).toBe(true);
  });

  it("requires exactly the admin role and nothing else", () => {
    expect(isAdmin(identityOf({ app_metadata: { role: "Admin" } } as never))).toBe(false);
    expect(isAdmin(identityOf({ app_metadata: { role: "administrator" } } as never))).toBe(false);
    expect(isAdmin(identityOf({ app_metadata: { role: "admin", extra: 1 } } as never))).toBe(true);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe("oauth callback parsing", () => {
  const origin = "https://jarvis-admin-topaz.vercel.app";

  it("reads the PKCE code the client is sent back with", () => {
    expect(readOauthResult(`${origin}/?code=abc123`)).toEqual({ problem: null, code: "abc123" });
    expect(readOauthResult(`${origin}/#code=abc123`).code).toBe("abc123");
  });

  it("treats a cancelled consent as neutral, not as a failure", () => {
    const result = readOauthResult(`${origin}/?error=access_denied&error_code=access_denied`);
    expect(result.problem?.kind).toBe("cancelled");
    expect(result.problem?.message).toContain("cancelled");
    expect(result.problem?.message).toContain("Nothing was changed");
  });

  it("tells an expired link apart from a cancellation", () => {
    expect(readOauthResult(`${origin}/?error=access_denied&error_code=otp_expired`).problem?.kind).toBe("expired");
    expect(readOauthResult(`${origin}/?error=server_error&error_code=otp_expired`).problem?.kind).toBe("expired");
    expect(readOauthResult(`${origin}/?error=server_error`).problem?.kind).toBe("unknown");
  });

  it("has nothing to report on a plain page load", () => {
    expect(readOauthResult(`${origin}/`)).toEqual({ problem: null, code: null });
    expect(readOauthResult(`${origin}/settings`)).toEqual({ problem: null, code: null });
    expect(readOauthResult(`${origin}/?page=jarvis`)).toEqual({ problem: null, code: null });
  });
});