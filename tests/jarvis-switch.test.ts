import { describe, expect, it } from "vitest";
import { click, mountPage, settle, storedSession, textOf, waitFor } from "./harness.ts";

async function signedIn() {
  return mountPage({ session: storedSession("admin-access-token") });
}

function jarvisSwitch(page: Awaited<ReturnType<typeof signedIn>>): HTMLInputElement {
  return page.document.getElementById("jarvisSwitch") as HTMLInputElement;
}

function stateWrites(page: Awaited<ReturnType<typeof signedIn>>, from: number) {
  return page.backend.requests
    .slice(from)
    .filter((request) => request.path.includes("jarvis_system_state") && request.method !== "GET");
}

describe("the JARVIS switch", () => {
  it("draws the switch from the stored row, not from a default", async () => {
    const page = await signedIn();
    expect(jarvisSwitch(page).checked).toBe(true);
    expect(textOf(page, "jarvisStateMeta")).toContain("jarvis_enabled=true");
    expect(textOf(page, "jarvisStateMeta")).toContain("row id=default");

    click(page, "refreshJarvis");
    await settle(6);
    expect(jarvisSwitch(page).checked).toBe(true);
  });

  it("turns JARVIS off in the database and says so from the row that was saved", async () => {
    const page = await signedIn();
    const before = page.backend.requests.length;

    jarvisSwitch(page).checked = false;
    jarvisSwitch(page).dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event("change"));
    await waitFor(() => textOf(page, "jarvisMessage").startsWith("Saved."), "the JARVIS save");

    const update = stateWrites(page, before).find((request) => request.method === "PATCH");
    expect(update).toBeDefined();
    expect(JSON.parse(update!.body ?? "{}")).toEqual({ jarvis_enabled: false });
    expect(page.backend.db.systemState.jarvis_enabled).toBe(false);
    expect(textOf(page, "jarvisMessage")).toContain("JARVIS is now OFF");
    expect(textOf(page, "dashJarvis")).toBe("OFF");
  });

  it("reaches the User App snapshot, not just the row this page wrote", async () => {
    const page = await signedIn();
    jarvisSwitch(page).checked = false;
    jarvisSwitch(page).dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event("change"));
    await waitFor(() => textOf(page, "jarvisMessage").startsWith("Saved."), "the JARVIS save");

    /* jarvisEnabled is what the devices actually read. */
    expect(page.backend.snapshot().jarvisEnabled).toBe(false);
    expect(page.backend.requests.some((request) => request.path.endsWith("/functions/v1/jarvis-languages"))).toBe(
      true
    );
  });

  it("puts the switch back when the database refuses the write", async () => {
    const page = await signedIn();
    jarvisSwitch(page).checked = false;
    /* This is what removing app_metadata.role looks like to the database. */
    page.backend.db.tokens.set("admin-access-token", { email: "admin@jarvis.app", app_metadata: {} });

    jarvisSwitch(page).dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event("change"));
    await waitFor(() => textOf(page, "jarvisMessage").includes("row-level security"), "the refusal");

    expect(page.backend.db.systemState.jarvis_enabled).toBe(true);
    expect(jarvisSwitch(page).checked).toBe(true);
    expect(textOf(page, "jarvisMessage")).not.toContain("Saved.");
  });

  it("keeps the switch locked and says why when the row is not there", async () => {
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      db: { tables: new Set(["jarvis_languages", "jarvis_language_voices", "jarvis_assistant_policy"]) }
    });

    expect(jarvisSwitch(page).disabled).toBe(true);
    expect(jarvisSwitch(page).checked).toBe(false);
    expect(textOf(page, "dashJarvis")).toBe("—");
    expect(textOf(page, "dashJarvisSub")).toContain("jarvis_system_state");
  });

  it("disables the switch entirely while signed out", async () => {
    const page = await mountPage();

    expect(jarvisSwitch(page).disabled).toBe(true);
    expect(textOf(page, "dashJarvis")).toBe("—");
    expect(textOf(page, "connectionText")).toBe("Signed out");
    expect(page.backend.requests.filter((request) => request.path.includes("jarvis_system_state"))).toHaveLength(0);
  });

  it("never sends a second write while the first is still in flight", async () => {
    const page = await signedIn();
    const before = page.backend.requests.length;

    const toggle = jarvisSwitch(page);
    toggle.checked = false;
    const fire = () =>
      toggle.dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event("change"));
    fire();
    /* A second change event from a double tap must not reach the database. */
    fire();
    await waitFor(() => textOf(page, "jarvisMessage").startsWith("Saved."), "the JARVIS save");

    expect(stateWrites(page, before).filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(toggle.disabled).toBe(false);
  });

  it("carries the administrator's own token on the write", async () => {
    const page = await signedIn();
    const before = page.backend.requests.length;
    jarvisSwitch(page).checked = false;
    jarvisSwitch(page).dispatchEvent(new (page.window as unknown as { Event: typeof Event }).Event("change"));
    await waitFor(() => textOf(page, "jarvisMessage").startsWith("Saved."), "the JARVIS save");

    const update = stateWrites(page, before).find((request) => request.method === "PATCH")!;
    expect(update.token).toBe("admin-access-token");
    expect(update.path).toContain("id=eq.default");
  });
});