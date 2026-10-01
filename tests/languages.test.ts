import { describe, expect, it } from "vitest";
import { click, languageCard, mountPage, settle, storedSession, textOf, waitFor } from "./harness.ts";

async function signedIn() {
  return mountPage({ session: storedSession("admin-access-token") });
}

function voiceBoxes(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll(".voicebox")] as HTMLElement[];
}

function textInputs(card: HTMLElement): HTMLInputElement[] {
  return [...card.querySelectorAll("input[type=text]")] as HTMLInputElement[];
}

describe("languages and voices", () => {
  it("renders one card per database row and exactly one voice box per gender", async () => {
    const page = await signedIn();

    expect(page.document.querySelectorAll("article.language")).toHaveLength(3);
    expect(page.document.querySelectorAll("#languageList .voicebox")).toHaveLength(6);
    expect(textOf(page, "dashLanguages")).toBe("3");
  });

  it("shows the stored voice id verbatim and never invents a mapping that is not there", async () => {
    const page = await signedIn();

    const english = voiceBoxes(languageCard(page, "English"))[0];
    expect(textInputs(english)[1].value).toBe("en-us-x-sfg#1");

    const hindi = languageCard(page, "Hindi");
    expect(hindi.textContent).toContain("No mapping stored");
    expect(hindi.textContent).not.toContain("undefined");
  });

  it("inserts a newly typed mapping in one save and keeps the exact voice id", async () => {
    const page = await signedIn();
    const hindi = languageCard(page, "Hindi");
    const female = voiceBoxes(hindi)[1];
    textInputs(female)[0].value = "Hindi (India) - Google";
    textInputs(female)[1].value = "hi-in-x-efb#1";
    (female.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;

    const before = page.backend.requests.length;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");

    const writes = page.backend.requests
      .slice(before)
      .filter((request) => request.path.startsWith("/rest/v1/") && request.method !== "GET");

    const inserts = writes.filter((request) => request.method === "POST");
    expect(inserts).toHaveLength(1);
    const body = JSON.parse(inserts[0]!.body ?? "{}");
    expect(body.voice_id).toBe("hi-in-x-efb#1");
    expect(body.voice_name).toBe("Hindi (India) - Google");
    expect(body.enabled).toBe(true);
    expect(body.language_id).toBe("hindi");
    expect(body.gender).toBe("female");

    /* An untouched language must not be rewritten. */
    expect(
      writes.some((request) => request.method === "PATCH" && request.path.includes("jarvis_languages"))
    ).toBe(false);

    /* And the re-read card holds what the database now holds. */
    expect(textInputs(voiceBoxes(languageCard(page, "Hindi"))[1])[1].value).toBe("hi-in-x-efb#1");
  });

  it("updates an existing mapping by language and gender, never by upsert", async () => {
    const page = await signedIn();
    const english = voiceBoxes(languageCard(page, "English"))[0];
    textInputs(english)[1].value = "en-us-x-sfg#2";

    const before = page.backend.requests.length;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");

    const writes = page.backend.requests.slice(before).filter((request) => request.method !== "GET");
    expect(writes.some((request) => (request.path ?? "").includes("on_conflict"))).toBe(false);
    const patch = writes.find((request) => request.method === "PATCH" && request.path.includes("jarvis_language_voices"));
    expect(patch).toBeDefined();
    expect(patch!.path).toContain("language_id=eq.english");
    expect(patch!.path).toContain("gender=eq.male");
    expect(JSON.parse(patch!.body ?? "{}").voice_id).toBe("en-us-x-sfg#2");
  });

  it("disabling a language switches its mappings off instead of failing the save", async () => {
    const page = await signedIn();
    const arabic = languageCard(page, "Arabic");
    (arabic.querySelectorAll(".toggle input[type=checkbox]")[0] as HTMLInputElement).checked = false;

    const before = page.backend.requests.length;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");

    const patch = page.backend.requests
      .slice(before)
      .find((request) => request.method === "PATCH" && request.path.includes("jarvis_languages"));
    expect(JSON.parse(patch!.body ?? "{}").enabled).toBe(false);
    expect(page.backend.snapshot().languages?.some((row) => row.id === "arabic")).toBe(false);
    /* The default language must not have moved. */
    expect(page.backend.snapshot().languages?.find((row) => row.id === "english")?.is_default).toBe(true);
  });

  it("clears the incumbent default before setting another one", async () => {
    const page = await signedIn();
    const hindi = languageCard(page, "Hindi");
    /* Radio inputs only clear each other on a real click, so do both by hand:
       a page holding two defaults is rejected before anything is sent. */
    for (const radio of page.document.querySelectorAll(
      "#languageList input[type=radio]"
    ) as NodeListOf<HTMLInputElement>) {
      radio.checked = false;
    }
    (hindi.querySelectorAll(".toggle input")[1] as HTMLInputElement).checked = true;

    const before = page.backend.requests.length;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");

    const writes = page.backend.requests.slice(before).filter((request) => request.method === "PATCH");
    const cleared = writes.find((request) => request.path.includes("neq.hindi"));
    expect(cleared).toBeDefined();
    expect(JSON.parse(cleared!.body ?? "{}").is_default).toBe(false);
    expect(page.backend.snapshot().languages?.filter((row) => row.is_default)).toHaveLength(1);
  });

  it("refuses to disable every language before anything is sent", async () => {
    const page = await signedIn();
    for (const card of page.document.querySelectorAll("article.language")) {
      (card.querySelector(".toggle input[type=checkbox]") as HTMLInputElement).checked = false;
    }

    const before = page.backend.requests.length;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").length > 0, "validation feedback");

    expect(textOf(page, "languageStatus")).toContain("At least one language");
    expect(page.backend.requests.slice(before).filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("removes a stored mapping only after an explicit confirmation", async () => {
    const page = await signedIn();
    const remove = [...languageCard(page, "English").querySelectorAll("button")].find(
      (node) => node.textContent === "Remove mapping"
    ) as HTMLButtonElement;
    expect(remove).toBeDefined();

    click(page, "saveLanguages"); // no-op: nothing changed, proves empty saves are silent
    await settle(2);
    remove.click();
    await waitFor(() => textOf(page, "languageStatus").includes("removed"), "the removal");

    expect(page.confirmed[0]).toContain("English male voice");
    expect(page.backend.db.voices.some((voice) => voice.language_id === "english")).toBe(false);
  });

  it("every language write carries the administrator's token, so RLS is the authority", async () => {
    const page = await signedIn();
    const hindi = languageCard(page, "Hindi");
    const male = voiceBoxes(hindi)[0];
    textInputs(male)[0].value = "Hindi (India)";
    textInputs(male)[1].value = "hi-in-x-efb#0";
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");

    const rest = page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/"));
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((request) => request.token === "admin-access-token")).toBe(true);
  });

  it("surfaces a row-level security rejection instead of reporting a save that did not happen", async () => {
    const page = await signedIn();
    /* The database is the authority: revoke the admin role the server is willing
       to honour, exactly as removing app_metadata.role would, and the write that
       still goes out must come back refused and be reported as refused. */
    page.backend.db.tokens.set("admin-access-token", { email: "admin@jarvis.app", app_metadata: {} });

    const male = voiceBoxes(languageCard(page, "Hindi"))[0];
    textInputs(male)[0].value = "Hindi (India)";
    textInputs(male)[1].value = "hi-in-x-efb#0";
    click(page, "saveLanguages");
    await waitFor(
      () => textOf(page, "languageStatus").includes("row-level security"),
      "the refusal to reach the status line"
    );

    expect(page.backend.db.voices.some((voice) => voice.voice_id === "hi-in-x-efb#0")).toBe(false);
    expect(textOf(page, "languageStatus")).not.toContain("Saved.");
    /* The form is re-read from the database, so nothing half-written is shown. */
    expect(textInputs(voiceBoxes(languageCard(page, "Hindi"))[0])[1].value).toBe("");
  });
});