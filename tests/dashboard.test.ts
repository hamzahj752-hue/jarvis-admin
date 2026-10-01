import { describe, expect, it } from "vitest";
import { click, mountPage, settle, storedSession, textOf, waitFor } from "./harness.ts";
import { seedDb } from "./fakeBackend.ts";

async function signedIn() {
  return mountPage({ session: storedSession("admin-access-token") });
}

describe("dashboard", () => {
  it("counts what the database holds and nothing it does not", async () => {
    const page = await signedIn();

    expect(textOf(page, "dashJarvis")).toBe("ON");
    expect(textOf(page, "dashLanguages")).toBe("3");
    expect(textOf(page, "dashVoices")).toBe("1");
    expect(textOf(page, "dashVoicesSub")).toBe("1 of 1 stored mappings are active");
    expect(textOf(page, "dashBackend")).toBe("OK");
    expect(textOf(page, "connectionText")).toBe("Backend verified just now");
  });

  it("does not count a disabled language as available to devices", async () => {
    const page = await signedIn();
    const arabic = page.document.querySelectorAll("article.language")[2] as HTMLElement;
    (arabic.querySelector(".toggle input[type=checkbox]") as HTMLInputElement).checked = false;
    click(page, "saveLanguages");
    await waitFor(() => textOf(page, "languageStatus").startsWith("Saved."), "the language save");
    click(page, "refreshDashboard");
    await waitFor(() => textOf(page, "dashLanguages") === "2", "the refreshed count");

    expect(textOf(page, "dashLanguages")).toBe("2");
    expect(textOf(page, "dashLanguagesSub")).toContain("1 of 3 configured languages are disabled");
  });

  it("reports the live endpoints from their answers, not from an assumption", async () => {
    const page = await signedIn();

    expect(textOf(page, "aiProvider")).toBe("gemini");
    expect(textOf(page, "aiModel")).toContain("gemini-3.8-flash (chat)");
    expect(textOf(page, "aiSearch")).toBe("wikipedia");
    expect(textOf(page, "aiModels")).toContain("gemini: gemini-3.8-flash");
    expect(textOf(page, "userViewStatus")).not.toBe("");
    expect(textOf(page, "userView")).toContain("version: 1");
  });

  it("says the gateway is unreachable instead of showing a green light", async () => {
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      healthStatus: 502
    });

    expect(textOf(page, "dashBackend")).toBe("—");
    expect(textOf(page, "dashBackendSub")).toContain("jarvis-health has not answered");
    expect(textOf(page, "connectionText")).toContain("Gateway unreachable");
    expect(textOf(page, "dashboardMessage")).toContain("jarvis-health could not be reached");
    /* The rest of the dashboard is still true. */
    expect(textOf(page, "dashJarvis")).toBe("ON");
    expect(textOf(page, "dashLanguages")).toBe("3");
  });

  it("one broken section never blanks the others", async () => {
    /* The concrete failure that motivated per-section loading: the assistant
       policy table was not in the deployed schema, and one 404 used to take the
       language list, the JARVIS switch and the dashboard with it. */
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      db: { tables: new Set(["jarvis_languages", "jarvis_language_voices", "jarvis_system_state"]) }
    });

    expect(page.document.querySelectorAll("article.language")).toHaveLength(3);
    expect((page.document.getElementById("jarvisSwitch") as HTMLInputElement).checked).toBe(true);
    expect(textOf(page, "dashLanguages")).toBe("3");
    expect(textOf(page, "dashboardMessage")).toContain("jarvis_assistant_policy");
    expect(textOf(page, "languageStatus")).toBe("");
  });

  it("re-reads after a tab comes back, because a stale session is the likeliest fault", async () => {
    const page = await signedIn();
    const before = page.backend.requests.filter((request) => request.path.includes("/rest/v1/")).length;
    (page.document as unknown as { visibilityState: string }).visibilityState = "visible";
    (page.window as unknown as { document: Document }).document.dispatchEvent(
      new (page.window as unknown as { Event: typeof Event }).Event("visibilitychange")
    );
    await waitFor(
      () => page.backend.requests.filter((request) => request.path.includes("/rest/v1/")).length > before,
      "the re-read"
    );
    expect(textOf(page, "dashboardMessage")).toContain("Configuration re-read after returning to this tab.");
  });

  it("shows the policy snapshot the devices will actually receive", async () => {
    const page = await signedIn();
    click(page, "refreshUserView");
    await waitFor(() => textOf(page, "userViewStatus") === "Fetched just now.", "the User App view");

    const view = textOf(page, "userView");
    expect(view).toContain("english  English  en  default=true");
    expect(view).toContain("english  male  en-us-x-sfg#1");
    expect(view).toContain('"attribution_text":"- Hamzah ka Assistant"');
  });

  it("reports the User App endpoint being down without inventing a snapshot", async () => {
    const page = await signedIn();
    click(page, "refreshUserView");
    await waitFor(() => textOf(page, "userViewStatus") === "Fetched just now.", "the User App view");

    /* Take the endpoint away and refresh it. */
    page.backend.offline = "Failed to fetch";
    click(page, "refreshUserView");
    await waitFor(() => textOf(page, "userView").startsWith("Unavailable:"), "the failure");

    expect(textOf(page, "userViewStatus")).toContain("Failed to fetch");
    expect(textOf(page, "userView")).not.toContain("version: 1");
  });

  it("clears the panel when the session ends under it", async () => {
    const page = await signedIn();
    expect(textOf(page, "dashLanguages")).toBe("3");

    click(page, "signOut2");
    await waitFor(() => textOf(page, "connectionText") === "Signed out", "the reset panel");

    expect(textOf(page, "dashLanguages")).toBe("0");
    expect(textOf(page, "dashJarvis")).toBe("—");
    expect(textOf(page, "dashBackend")).toBe("—");
    expect(page.document.querySelectorAll("article.language")).toHaveLength(0);
    expect(page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/")).length).toBeGreaterThan(0);
  });
});

describe("settings and secrets", () => {
  it("names the project and the sign-in method without printing a key", async () => {
    const page = await signedIn();

    expect(textOf(page, "settingsProject")).toContain("https://ggwriczikznaceanqarn.supabase.co");
    const key = textOf(page, "settingsKey");
    expect(key).toContain("sb_publishable_");
    /* Enough to confirm which key is deployed, not enough to paste anywhere. */
    expect(key).toContain("…");
    expect(key).not.toContain("sb_publishable_gMKX-O5QO2wmQeqomJEf4Q_Qag-BXH2");
    expect(textOf(page, "settingsSignIn")).toContain("Google");
  });

  it("tells the operator where the callback returns to", async () => {
    const page = await signedIn();

    const redirect = textOf(page, "settingsRedirect");
    expect(redirect).toContain("https://jarvis-admin-topaz.vercel.app");
  });

  it("reports the trusted role and the server-side re-check", async () => {
    const page = await signedIn();

    expect(textOf(page, "settingsAdmin")).toContain("admin@jarvis.app");
    expect(textOf(page, "settingsAdmin")).toContain("role=admin");
    expect(textOf(page, "settingsSessionDescription")).toContain("row-level security");
  });

  it("carries no privileged key anywhere in the page or the bundle", async () => {
    const page = await signedIn();
    const html = page.document.documentElement.outerHTML;

    for (const forbidden of ["service_role", "sb_secret", "SUPABASE_SERVICE", "private_key", "client_secret"]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    /* The publishable key belongs in the bundle and is safe there, but only the
       publishable half: nothing that looks like the service JWT. */
    const settings = textOf(page, "settings");
    expect(settings).not.toContain("eyJhbGciOi");
  });

  it("signs out from the settings page as well as the header", async () => {
    const page = await signedIn();
    const settingsPage = page.document.getElementById("settings");
    expect(settingsPage?.querySelector("#signOut2")).not.toBeNull();

    (settingsPage?.querySelector("#signOut2") as HTMLButtonElement).click();
    await waitFor(() => page.document.getElementById("login")?.classList.contains("show") === true, "the gate");

    expect(textOf(page, "settingsAdmin")).toBe("—");
    expect(textOf(page, "settingsSessionDescription")).toBe("—");
  });

  it("keeps the dashboard honest when the languages table is gone", async () => {
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      db: { tables: new Set(["jarvis_system_state", "jarvis_assistant_policy"]) }
    });

    expect(page.document.querySelectorAll("article.language")).toHaveLength(0);
    expect(textOf(page, "languageStatus")).toContain("jarvis_languages");
    expect(textOf(page, "dashLanguages")).toBe("0");
    expect(textOf(page, "dashVoicesSub")).toBe("No voice mappings configured yet");
    /* The JARVIS switch is independent and still real. */
    expect((page.document.getElementById("jarvisSwitch") as HTMLInputElement).checked).toBe(true);
  });

  it("still signs in when there is nothing to show yet", async () => {
    /* The panel is unusable, not the gate: the session is still established and
       the failure is reported per section rather than as a sign-in failure. */
    const page = await mountPage({
      db: { tables: new Set() },
      session: storedSession("admin-access-token")
    });

    await settle();
    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(false);
    expect(textOf(page, "sessionWho")).toBe("admin@jarvis.app");
    expect(textOf(page, "dashboardMessage")).toContain("jarvis_languages");
    expect(textOf(page, "dashboardMessage")).toContain("jarvis_system_state");
    expect(textOf(page, "dashboardMessage")).toContain("jarvis_assistant_policy");
    expect(seedDb().tables.size).toBe(4);
  });
});