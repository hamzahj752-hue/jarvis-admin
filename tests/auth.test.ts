import { describe, expect, it } from "vitest";
import { click, mountPage, setField, settle, storedSession, textOf, waitFor } from "./harness.ts";

describe("signing in", () => {
  it("sends the browser to Google through Supabase Auth with PKCE and the running origin", async () => {
    const page = await mountPage();
    click(page, "googleButton");
    await waitFor(() => page.clicks.length > 0, "the OAuth redirect");

    const target = new URL(page.clicks[0]!);
    expect(`${target.origin}${target.pathname}`).toBe(
      "https://ggwriczikznaceanqarn.supabase.co/auth/v1/authorize"
    );
    expect(target.searchParams.get("provider")).toBe("google");
    /* PKCE: the authorization request carries a challenge, never a secret. */
    expect(target.searchParams.get("code_challenge_method")).toBe("s256");
    expect((target.searchParams.get("code_challenge") ?? "").length).toBeGreaterThan(20);
    expect(target.searchParams.get("redirect_to")).toBe("https://jarvis-admin-topaz.vercel.app");
    expect(target.searchParams.get("scopes")).toContain("email");
    expect(textOf(page, "loginMessage")).toContain("Opening Google sign-in");
  });

  it("never puts a client secret or a service key in the redirect", async () => {
    const page = await mountPage();
    click(page, "googleButton");
    await waitFor(() => page.clicks.length > 0, "the OAuth redirect");

    const target = new URL(page.clicks[0]!);
    /* The authorization request is public: it carries no key of any kind. */
    expect(target.searchParams.get("apikey")).toBeNull();
    expect(target.searchParams.get("client_secret")).toBeNull();
    expect(target.searchParams.get("code")).toBeNull();
    expect(target.searchParams.get("code_verifier")).toBeNull();
    for (const forbidden of ["sb_secret", "service_role", "SUPABASE_SERVICE_ROLE", "eyJhbGciOi"]) {
      expect(page.clicks[0]).not.toContain(forbidden);
    }
    /* The verifier that the exchange will use is kept in this browser only. */
    expect([...page.storage.keys()].some((key) => key.includes("code-verifier"))).toBe(true);
  });

  it("signs in with a password for an administrator and opens the panel", async () => {
    const page = await mountPage();
    setField(page, "loginEmail", "admin@jarvis.app");
    setField(page, "loginPassword", "correct-horse");
    click(page, "loginButton");
    await waitFor(
      () => page.document.getElementById("login")?.classList.contains("show") === false,
      "the panel to open"
    );

    expect(textOf(page, "sessionWho")).toBe("admin@jarvis.app");
    expect(page.document.querySelectorAll("article.language")).toHaveLength(3);
  });

  it("clears the typed password whether or not sign-in succeeds", async () => {
    const page = await mountPage();
    setField(page, "loginEmail", "admin@jarvis.app");
    setField(page, "loginPassword", "correct-horse");
    click(page, "loginButton");
    await waitFor(
      () => page.document.getElementById("login")?.classList.contains("show") === false,
      "the panel to open"
    );

    expect((page.document.getElementById("loginPassword") as HTMLInputElement).value).toBe("");
  });

  it("rejects a wrong password in plain language and stores no session", async () => {
    const page = await mountPage();
    setField(page, "loginEmail", "admin@jarvis.app");
    setField(page, "loginPassword", "wrong");
    click(page, "loginButton");
    await waitFor(() => textOf(page, "loginMessage").includes("not accepted"), "the refusal");

    expect(textOf(page, "loginMessage")).toBe(
      "That email and password were not accepted. Check them and try again."
    );
    expect(page.storage.get("jarvis_admin_session")).toBeUndefined();
    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(true);
  });

  it("refuses a non-administrator at the password door and ends the session it just made", async () => {
    const page = await mountPage();
    /* The credentials are right, so the auth server issues a real session - and
       then the panel finds the account carries no admin role. The session it was
       just handed has to be ended again. */
    page.backend.db.tokens.set("admin-access-token", { email: "user@jarvis.app", app_metadata: {} });
    setField(page, "loginEmail", "user@jarvis.app");
    setField(page, "loginPassword", "correct-horse");
    click(page, "loginButton");
    await waitFor(() => textOf(page, "loginMessage").includes("not authorized"), "the refusal");

    expect(page.storage.get("jarvis_admin_session")).toBeUndefined();
    expect(page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/"))).toHaveLength(0);
  });

  it("reports an unreachable auth server without throwing away a saved session", async () => {
    const page = await mountPage({ session: storedSession("admin-access-token"), offline: "Failed to fetch" });

    const message = textOf(page, "loginMessage");
    expect(page.document.getElementById("loginMessage")?.className).toContain("error");
    /* "Sign in again" would be wrong advice here: the saved session is probably
       still perfectly good, the server is simply not answering. */
    expect(message).toContain("could not be reached");
    expect(message).not.toContain("Sign in again");
    expect(page.storage.get("jarvis_admin_session")).toBeUndefined();
    expect((page.document.getElementById("googleButton") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not attempt any configuration read while signed out, even when the network is down", async () => {
    const page = await mountPage({ offline: "Failed to fetch" });

    /* Nothing failed and nothing was asked for, so there is no error to show:
       a first-time visitor with no network simply gets the gate. */
    expect(textOf(page, "loginMessage")).toBe("");
    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(true);
    expect(page.backend.requests).toHaveLength(0);
  });

  it("does not attempt any configuration read while signed out", async () => {
    const page = await mountPage();

    expect(page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/"))).toHaveLength(0);
    expect(page.backend.requests.filter((request) => request.path.startsWith("/functions/"))).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("revokes the session, clears the panel and shows the gate again", async () => {
    const page = await mountPage({ session: storedSession("admin-access-token") });

    click(page, "signOut");
    await waitFor(
      () => page.document.getElementById("login")?.classList.contains("show") === true,
      "the sign-in gate"
    );
    await settle();

    expect(page.storage.get("jarvis_admin_session")).toBeUndefined();
    /* The scope=global in the request is what revokes the refresh token server-side,
       so a stolen copy of the handle is worthless after sign-out. */
    const logout = page.backend.requests.filter((request) => request.path.includes("/auth/v1/logout"));
    expect(logout).toHaveLength(1);
    expect(logout[0]!.path).toContain("scope=global");
    expect(logout[0]!.token).toBe("admin-access-token");
    expect(page.document.querySelectorAll("article.language")).toHaveLength(0);
    expect(textOf(page, "sessionWho")).toBe("not signed in");
    expect(textOf(page, "userView")).toBe("Not fetched yet.");
    expect((page.document.getElementById("signOut") as HTMLButtonElement).disabled).toBe(true);
    for (const button of page.document.querySelectorAll("#nav button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("cannot start a second sign-out on top of the first", async () => {
    const page = await mountPage({ session: storedSession("admin-access-token") });

    click(page, "signOut");
    click(page, "signOut");
    await waitFor(
      () => page.document.getElementById("login")?.classList.contains("show") === true,
      "the sign-in gate"
    );

    expect(page.backend.requests.filter((request) => request.path.includes("/auth/v1/logout"))).toHaveLength(1);
  });
});

describe("navigation", () => {
  it("switches sections and refuses to while signed out", async () => {
    const page = await mountPage({ session: storedSession("admin-access-token") });

    const languages = page.document.querySelector('#nav button[data-page="languages"]') as HTMLButtonElement;
    languages.click();
    expect(page.document.getElementById("languages")?.classList.contains("active")).toBe(true);
    expect(textOf(page, "pageTitle")).toBe("Languages & Voices");
    expect(languages.classList.contains("active")).toBe(true);

    const jarvis = page.document.querySelector('#nav button[data-page="jarvis"]') as HTMLButtonElement;
    jarvis.click();
    expect(page.document.getElementById("jarvis")?.classList.contains("active")).toBe(true);
    expect(textOf(page, "pageTitle")).toBe("JARVIS");
  });
});