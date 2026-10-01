import { describe, expect, it } from "vitest";
import { mountPage, settle, storedSession, textOf } from "./harness.ts";

describe("session boot", () => {
  it("shows the sign-in gate and reads nothing before an administrator signs in", async () => {
    const page = await mountPage();

    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(true);
    expect(page.document.querySelectorAll("article.language")).toHaveLength(0);
    expect(page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/"))).toHaveLength(0);
    expect(textOf(page, "sessionWho")).toBe("not signed in");
    for (const id of ["signOut", "signOut2"]) {
      expect((page.document.getElementById(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("restores an administrator from the stored session and re-verifies the role with the server", async () => {
    const page = await mountPage({ session: storedSession("admin-access-token") });

    expect(page.backend.requests.some((request) => request.path === "/auth/v1/user")).toBe(true);
    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(false);
    expect(textOf(page, "sessionWho")).toBe("admin@jarvis.app");
    expect(textOf(page, "settingsAdmin")).toContain("role=admin");
    expect(page.document.querySelectorAll("article.language")).toHaveLength(3);
  });

  it("reads the role from app_metadata and never from the caller-controlled user_metadata", async () => {
    const forged = JSON.stringify({
      access_token: "user-access-token",
      refresh_token: "user-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: "00000000-0000-4000-8000-000000000000",
        email: "attacker@jarvis.app",
        app_metadata: {},
        user_metadata: { role: "admin" }
      }
    });
    const page = await mountPage({ session: forged });

    expect(textOf(page, "loginMessage")).toContain("not authorized as an administrator");
    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(true);
    expect(page.backend.requests.filter((request) => request.path.startsWith("/rest/v1/"))).toHaveLength(0);
    expect(page.storage.get("jarvis_admin_session")).toBeUndefined();
  });

  it("reports an expired session instead of pretending to be signed in", async () => {
    const page = await mountPage({
      session: storedSession("admin-access-token", {
        expiresAt: Math.floor(Date.now() / 1000) - 600,
        refreshToken: "no-such-refresh-token"
      })
    });
    await settle();

    expect(page.document.getElementById("login")?.classList.contains("show")).toBe(true);
    expect(page.document.querySelectorAll("article.language")).toHaveLength(0);
    expect(textOf(page, "sessionWho")).toBe("not signed in");
  });

  it("shows an OAuth cancellation as a neutral message rather than an error", async () => {
    const page = await mountPage({
      url: "https://jarvis-admin-topaz.vercel.app/?error=access_denied&error_code=otp_cancelled"
    });

    const message = textOf(page, "loginMessage");
    expect(message).toContain("cancelled");
    expect(page.document.getElementById("loginMessage")?.className).not.toContain("error");
  });

  it("strips the authentication parameters out of the address bar once they are consumed", async () => {
    const page = await mountPage({
      session: storedSession("admin-access-token"),
      url: "https://jarvis-admin-topaz.vercel.app/?code=abc123"
    });

    expect((page.window.location.href as unknown as string) ?? "").not.toContain("code=abc123");
  });
});