import { describe, expect, it } from "vitest";
import { click, mountPage, settle, storedSession, textOf, waitFor } from "./harness.ts";
import type { AssistantPolicyRow } from "../src/types.ts";
import { seedDb } from "./fakeBackend.ts";

async function signedIn() {
  return mountPage({ session: storedSession("admin-access-token") });
}

function policyRow(page: Awaited<ReturnType<typeof signedIn>>): AssistantPolicyRow | null {
  return page.backend.db.assistantPolicy;
}

function writesSince(page: Awaited<ReturnType<typeof signedIn>>, index: number) {
  return page.backend.requests
    .slice(index)
    .filter((request) => request.path.includes("jarvis_assistant_policy"));
}

describe("assistant policy", () => {
  it("shows every switch and timeout the database row actually holds", async () => {
    const page = await signedIn();

    expect((page.document.getElementById("policySmsEnabled") as HTMLInputElement).checked).toBe(true);
    expect((page.document.getElementById("policyCallAutoAnswer") as HTMLInputElement).checked).toBe(false);
    expect((page.document.getElementById("policyBodyTimeout") as HTMLInputElement).value).toBe("20000");
    expect((page.document.getElementById("policyConfirmTimeout") as HTMLInputElement).value).toBe("30000");
    expect((page.document.getElementById("policyCallDecisionTimeout") as HTMLInputElement).value).toBe("25000");
    expect((page.document.getElementById("policyAttributionText") as HTMLInputElement).value).toBe(
      "- Hamzah ka Assistant"
    );
    expect(textOf(page, "policyMeta")).toContain("row id=default");
  });

  it("writes every switch, timeout and the attribution in one save", async () => {
    const page = await signedIn();
    (page.document.getElementById("policySmsReply") as HTMLInputElement).checked = false;
    (page.document.getElementById("policyCallAutoAnswer") as HTMLInputElement).checked = true;
    (page.document.getElementById("policyBodyTimeout") as HTMLInputElement).value = "45000";
    (page.document.getElementById("policyAttributionText") as HTMLInputElement).value = "- Hamzah";

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").startsWith("Saved."), "the policy save");

    const update = writesSince(page, before).find((request) => request.method === "PATCH");
    expect(update).toBeDefined();
    const body = JSON.parse(update!.body ?? "{}") as Record<string, unknown>;
    expect(body.reply_enabled).toBe(false);
    expect(body.auto_answer).toBe(true);
    expect(body.body_timeout_ms).toBe(45000);
    expect(body.attribution_text).toBe("- Hamzah");
    expect(body.sms_assistant_enabled).toBe(true);

    /* The published row, not the form, is what the User App will read back. */
    expect(page.backend.snapshot().jarvisEnabled).toBe(true);
    expect(page.backend.db.assistantPolicy?.auto_answer).toBe(true);
  });

  it("never sends the two confirmation gates as admin-settable", async () => {
    const page = await signedIn();
    /* A row edited by hand could leave a confirmation gate false. The clients
       ignore an explicit false for both, so a control here would look live and
       do nothing. Every save writes them as true instead. */
    page.backend.db.assistantPolicy = {
      ...seedDb().assistantPolicy!,
      confirmation_required: false,
      confirmation_required_before_answering: false,
      attribution_enabled: false
    };
    click(page, "refreshAssistantPolicy");
    await settle(4);

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").startsWith("Saved."), "the policy save");

    const body = JSON.parse(writesSince(page, before).find((request) => request.method === "PATCH")!.body ?? "{}");
    expect(body.confirmation_required).toBe(true);
    expect(body.confirmation_required_before_answering).toBe(true);
    expect(body.attribution_enabled).toBe(true);
  });

  it("names the field and sends nothing when a timeout is out of bounds", async () => {
    const page = await signedIn();
    (page.document.getElementById("policyConfirmTimeout") as HTMLInputElement).value = "999999";

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").includes("confirmation_timeout_ms"), "the refusal");

    expect(textOf(page, "policyMessage")).toContain("between 5000 and 120000");
    expect(writesSince(page, before)).toHaveLength(0);
    expect(textOf(page, "policyMessage")).not.toContain("Saved.");
  });

  it("refuses an empty timeout instead of sending a null the column would reject", async () => {
    const page = await signedIn();
    (page.document.getElementById("policyCallDecisionTimeout") as HTMLInputElement).value = "";

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").includes("decision_timeout_ms"), "the refusal");

    expect(writesSince(page, before)).toHaveLength(0);
  });

  it("refuses attribution text longer than the database allows", async () => {
    const page = await signedIn();
    (page.document.getElementById("policyAttributionText") as HTMLInputElement).value = "x".repeat(121);

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").includes("120"), "the refusal");

    expect(writesSince(page, before)).toHaveLength(0);
  });

  it("says the table is missing instead of drawing an empty form as if it were empty", async () => {
    /* Exactly what production answered before the migration was applied. */
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      db: { tables: new Set(["jarvis_languages", "jarvis_language_voices", "jarvis_system_state"]) }
    });

    expect(textOf(page, "policyMeta")).toContain("202610010001_assistant_policy.sql");
    expect(textOf(page, "dashboardMessage")).toContain("202610010001_assistant_policy.sql");
    expect((page.document.getElementById("saveAssistantPolicy") as HTMLButtonElement).disabled).toBe(true);
    /* And the rest of the panel still loaded. */
    expect(page.document.querySelectorAll("article.language")).toHaveLength(3);
    expect(textOf(page, "dashJarvis")).toBe("ON");
  });

  it("never presents the confirmation gates as controls", async () => {
    const page = await signedIn();

    /* Eight switches, no more: the two confirmation gates and the attribution flag
       are explained in the page text instead of being offered as controls. */
    const switches = [...page.document.querySelectorAll("input[type=checkbox][id^=policy]")];
    expect(new Set(switches.map((node) => node.id))).toEqual(new Set([
      "policyCallAnswer",
      "policyCallAnnounce",
      "policyCallAutoAnswer",
      "policyCallAutoReject",
      "policyCallEnabled",
      "policySmsAnnounce",
      "policySmsEnabled",
      "policySmsReply"
    ]));
    expect(page.document.getElementById("policyConfirmationRequired")).toBeNull();
    expect(page.document.getElementById("policyConfirmationRequiredBeforeAnswering")).toBeNull();
  });

  it("reports a refused write and puts the stored values back", async () => {
    const page = await signedIn();
    (page.document.getElementById("policySmsEnabled") as HTMLInputElement).checked = false;
    /* The database refuses: this is what removing app_metadata.role looks like. */
    page.backend.db.tokens.set("admin-access-token", { email: "admin@jarvis.app", app_metadata: {} });

    click(page, "saveAssistantPolicy");
    await waitFor(
      () => textOf(page, "policyMessage").includes("row-level security"),
      "the refusal to reach the message line"
    );

    expect(textOf(page, "policyMessage")).not.toContain("Saved.");
    expect(policyRow(page)?.sms_assistant_enabled).toBe(true);
    expect((page.document.getElementById("policySmsEnabled") as HTMLInputElement).checked).toBe(true);
  });

  it("carries the administrator's token so RLS decides, and never a service key", async () => {
    const page = await signedIn();
    (page.document.getElementById("policyCallAutoReject") as HTMLInputElement).checked = true;

    const before = page.backend.requests.length;
    click(page, "saveAssistantPolicy");
    await waitFor(() => textOf(page, "policyMessage").startsWith("Saved."), "the policy save");

    const update = writesSince(page, before).find((request) => request.method === "PATCH")!;
    expect(update.token).toBe("admin-access-token");
    expect(update.body ?? "").not.toContain("sb_secret");
  });

  it("starts a second save only after the first has finished", async () => {
    const page = await signedIn();
    (page.document.getElementById("policySmsAnnounce") as HTMLInputElement).checked = false;

    const save = page.document.getElementById("saveAssistantPolicy") as HTMLButtonElement;
    const before = page.backend.requests.length;
    save.click();
    /* While the write is in flight the button is locked, so a second click from a
       double-tap cannot send the same row twice. */
    expect(save.disabled).toBe(true);
    save.click();
    await waitFor(() => textOf(page, "policyMessage").startsWith("Saved."), "the policy save");

    expect(writesSince(page, before).filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(save.disabled).toBe(false);
  });
});