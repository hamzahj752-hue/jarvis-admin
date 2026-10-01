/*
 * JARVIS Admin: boot, wiring, and the operations that sit between the pages and
 * the backend.
 *
 * Two rules run through this file:
 *
 *  * Nothing is rendered from a guess. Every section reports its own failure and
 *    the others still load, so a table that has not been migrated yet cannot
 *    blank the whole panel.
 *  * No privileged work happens on the browser's say-so. Every write goes through
 *    the Supabase client with the administrator's own token, and is accepted only
 *    if the database confirms it.
 */
import { POLICY_ROW_ID, SUPABASE_ANON_KEY, SUPABASE_URL, SYSTEM_STATE_ROW_ID } from "./config.ts";
import { byId, clear, maybeById, setInline, setMessage, timestamp, valueOf } from "./dom.ts";
import {
  isAdmin,
  onAuthStateChange,
  resolveSession,
  signInWithGoogle,
  signInWithPassword,
  signOut,
  storedSessionKeys,
  type AuthProblem
} from "./auth.ts";
import { fetchAssistantPolicy, fetchHealth, fetchSystemState, fetchUserAppConfiguration, updateAssistantPolicy, updateSystemState } from "./backend.ts";
import { POLICY_ENFORCED, POLICY_NUMBERS, POLICY_SWITCHES, parsePolicyNumber, validateAttributionText } from "./assistantPolicy.ts";
import { PAGE_IDS, showPage } from "./navigation.ts";
import { lockForm, readLanguageDrafts, renderLanguages, reloadLanguageRows, saveLanguages } from "./languagesView.ts";
import { resetConfiguration, state } from "./state.ts";
import { renderAi, renderAssistantPolicy, renderDashboard, renderJarvis, setControlsDisabled, updateUserViewFromState } from "./views.ts";
import type { AdminIdentity } from "./types.ts";

/* ------------------------------------------------------------- chrome ---- */

/**
 * The publishable key is public - it ships in the bundle - but it is still a
 * credential, and half of it printed on a page invites someone to copy it into
 * something. Only the scheme and the last four characters are shown: enough to
 * confirm which key is deployed, not enough to paste anywhere.
 */
function maskKey(key: string): string {
  const scheme = key.startsWith("sb_publishable_") ? "sb_publishable_" : "";
  const body = key.slice(scheme.length);
  return `${scheme}${body.slice(0, 2)}…${key.slice(-4)} (${key.length} characters)`;
}

function setAuthenticated(authenticated: boolean): void {
  byId("login").classList.toggle("show", !authenticated);
  for (const button of byId("nav").querySelectorAll("button")) {
    (button as HTMLButtonElement).disabled = !authenticated;
  }
  (byId("signOut") as HTMLButtonElement).disabled = !authenticated;
  (byId("signOut2") as HTMLButtonElement).disabled = !authenticated;
}

function showLogin(problem: AuthProblem | null): void {
  byId("login").classList.add("show");
  if (problem) setMessage("loginMessage", problem.message, problem.kind === "cancelled" ? "busy" : "error");
  /* Nothing is polled or written while the gate is up, so the connection
     indicator must not keep claiming it is connecting to something. */
  renderDashboard();
  const email = maybeById("loginEmail") as HTMLInputElement | null;
  email?.focus();
}

function hideLogin(): void {
  byId("login").classList.remove("show");
}

function applySession(identity: AdminIdentity): void {
  state.user = identity;
  byId("sessionWho").textContent = identity.email ?? identity.userId ?? "signed in";
  byId("settingsAdmin").textContent =
    `${identity.email ?? "unknown"} · role=${identity.role ?? "none"} · user id=${identity.userId ?? "unknown"}`;
  const description = maybeById("settingsSessionDescription");
  if (description) {
    description.textContent =
      "Held by the Supabase client in this browser under " +
      storedSessionKeys()
        .map((key) => key)
        .join(", ") +
      ". The role above is re-read from the server on every load, and every write is checked again by database row-level security.";
  }
}

function clearSessionChrome(): void {
  byId("sessionWho").textContent = "not signed in";
  byId("settingsAdmin").textContent = "—";
  const description = maybeById("settingsSessionDescription");
  if (description) description.textContent = "—";
}

/* --------------------------------------------------------------- loading ---- */

/** Probes the two public endpoints. Never invents a status for either. */
async function refreshDashboardData(): Promise<string[]> {
  const problems: string[] = [];
  const health = await fetchHealth().then(
    (value) => {
      state.health = value;
      state.healthError = null;
      return value;
    },
    (error: unknown) => {
      state.health = null;
      state.healthError = error instanceof Error ? error.message : String(error);
      return null;
    }
  );

  await fetchUserAppConfiguration().then(
    (value) => {
      state.languagesEndpoint = value;
      state.languagesEndpointError = null;
      /* The mirror panel is fed by this probe, so it must not keep saying "not
         fetched yet" after the dashboard has already read the endpoint. */
      updateUserViewFromState();
    },
    (error: unknown) => {
      state.languagesEndpoint = null;
      state.languagesEndpointError = error instanceof Error ? error.message : String(error);
    }
  );

  if (!health) problems.push(`jarvis-health could not be reached: ${state.healthError}`);
  if (state.languagesEndpointError) {
    problems.push(`jarvis-languages could not be reached: ${state.languagesEndpointError}`);
  }

  setMessage(
    "dashboardMessage",
    problems.length === 0 ? "" : problems.join("\n"),
    problems.length === 0 ? "" : "error"
  );

  renderDashboard();
  renderAi();
  return problems;
}

/**
 * Loads every section, each independently.
 *
 * A failure in one section is recorded against that section and shown on it. The
 * reason for `Promise.allSettled` rather than `Promise.all` is concrete: the
 * assistant-policy table did not exist in the deployed database for a while, and
 * with `Promise.all` one 404 blanked the dashboard, the language list and every
 * control at the same time.
 */
async function reloadEverything(message?: string): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  setControlsDisabled(true);
  setMessage("dashboardMessage", "Loading configuration from Supabase…", "busy");

  try {
    await Promise.allSettled([loadLanguageSection(), loadSystemStateSection(), loadAssistantPolicySection()]);
    const probeProblems = await refreshDashboardData();

    renderLanguages();
    renderJarvis();
    renderAssistantPolicy();
    lockForm(false);

    /* Both sets of failures are reported together. The probe failures live on
       dashboardMessage already, and replacing them with "read successfully" here
       would report a healthy backend while its health endpoint is down. */
    const sections = [state.languagesError, state.systemStateError, state.assistantPolicyError].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
    if (sections.length > 0 || probeProblems.length > 0) {
      setMessage(
        "dashboardMessage",
        [...probeProblems, ...sections].join("\n"),
        "error"
      );
      setInline("languageStatus", state.languagesError ?? "", state.languagesError ? "error" : "");
    } else {
      setMessage(
        "dashboardMessage",
        message ?? "Configuration read from the database and the live endpoints.",
        "ok"
      );
    }
  } finally {
    state.loading = false;
    setControlsDisabled(false);
    lockForm(false);
  }
}

async function loadLanguageSection(): Promise<void> {
  try {
    await reloadLanguageRows();
  } catch (error) {
    state.languages = [];
    state.voices = [];
    state.languagesError = error instanceof Error ? error.message : String(error);
    renderLanguages();
  }
}

async function loadSystemStateSection(): Promise<void> {
  try {
    state.systemState = await fetchSystemState(SYSTEM_STATE_ROW_ID);
    state.systemStateError = null;
  } catch (error) {
    state.systemState = null;
    state.systemStateError = error instanceof Error ? error.message : String(error);
  }
  renderJarvis();
}

async function loadAssistantPolicySection(): Promise<void> {
  try {
    state.assistantPolicy = await fetchAssistantPolicy(POLICY_ROW_ID);
    state.assistantPolicyError = null;
  } catch (error) {
    state.assistantPolicy = null;
    state.assistantPolicyError = describePolicyProblem(error);
  }
  renderAssistantPolicy();
}

function describePolicyProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/PGRST205|could not find the table|relation .* does not exist/i.test(message)) {
    return (
      "public.jarvis_assistant_policy is not in this database yet. Run the pending Supabase migration " +
      "(supabase/migrations/202610010001_assistant_policy.sql) and reload. Until then the SMS and call " +
      "assistants run on their shipped defaults and cannot be changed from here."
    );
  }
  return message;
}

/* ---------------------------------------------------------------- saving ---- */

async function saveJarvisState(enabled: boolean): Promise<void> {
  if (state.saving) return;
  state.saving = true;
  renderJarvis();
  setMessage("jarvisMessage", "Saving to Supabase…", "busy");
  try {
    const saved = await updateSystemState(SYSTEM_STATE_ROW_ID, { jarvis_enabled: enabled });
    state.systemState = saved;
    renderJarvis();
    renderDashboard();
    setMessage(
      "jarvisMessage",
      `Saved. JARVIS is now ${saved.jarvis_enabled ? "ON" : "OFF"} for every device, from the database row changed ${timestamp(saved.updated_at)}.`,
      "ok"
    );
    await refreshDashboardData();
  } catch (error) {
    setMessage("jarvisMessage", error instanceof Error ? error.message : String(error), "error");
    /* Put the switch back to whatever the database actually holds. */
    try {
      await loadSystemStateSection();
    } catch {
      /* The save failure is the one worth showing. */
    }
  } finally {
    state.saving = false;
    renderJarvis();
  }
}

async function saveAssistantPolicy(): Promise<void> {
  if (state.saving) return;

  let body: Record<string, boolean | number | string>;
  try {
    const attribution = valueOf(byId("policyAttributionText") as HTMLInputElement);
    const attributionProblem = validateAttributionText(attribution);
    if (attributionProblem) throw new Error(attributionProblem);

    const draft: Record<string, boolean | number | string> = {};
    for (const [id, column] of POLICY_SWITCHES) {
      draft[column] = (byId(id) as HTMLInputElement).checked;
    }
    draft.attribution_text = attribution;
    for (const field of POLICY_NUMBERS) {
      draft[field.column] = parsePolicyNumber((byId(field.id) as HTMLInputElement).value, field);
    }
    /* The two confirmation gates and the attribution flag are not admin-settable.
       Writing them as their enforced value means a row edited by hand cannot leave
       them false and have that read as intent. */
    Object.assign(draft, POLICY_ENFORCED);
    body = draft;
  } catch (error) {
    setMessage("policyMessage", error instanceof Error ? error.message : String(error), "error");
    return;
  }

  state.saving = true;
  renderAssistantPolicy();
  setMessage("policyMessage", "Saving assistant policy…", "busy");
  try {
    const saved = await updateAssistantPolicy(POLICY_ROW_ID, body);
    state.assistantPolicy = saved;
    state.assistantPolicyError = null;
    renderAssistantPolicy();
    renderDashboard();
    setMessage("policyMessage", "Saved. Every device picks this up on its next configuration fetch.", "ok");
    /* Re-fetched so the snapshot shown next to this form is what the apps will
       read, rather than what this page believes it wrote. */
    await refreshDashboardData();
  } catch (error) {
    setMessage("policyMessage", error instanceof Error ? error.message : String(error), "error");
    try {
      await loadAssistantPolicySection();
    } catch {
      /* The save failure is the one worth showing. */
    }
  } finally {
    state.saving = false;
    renderAssistantPolicy();
  }
}

/* ---------------------------------------------------------------- events ---- */

byId("nav").addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest("button[data-page]");
  if (!button) return;
  if ((button as HTMLButtonElement).disabled) return;
  const page = button.getAttribute("data-page");
  if (page && PAGE_IDS.includes(page)) showPage(page);
});

byId("menuButton").addEventListener("click", () => {
  byId("sidebar").classList.toggle("open");
});

byId("googleButton").addEventListener("click", async () => {
  const button = byId("googleButton") as HTMLButtonElement;
  if (button.disabled) return;
  button.disabled = true;
  setMessage("loginMessage", "Opening Google sign-in…", "busy");
  try {
    const problem = await signInWithGoogle();
    if (problem) {
      /* No redirect happened: tell the operator why instead of leaving a spinner. */
      setMessage("loginMessage", problem.message, "error");
    }
  } finally {
    button.disabled = false;
  }
});

byId("loginButton").addEventListener("click", async () => {
  const button = byId("loginButton") as HTMLButtonElement;
  if (button.disabled) return;
  const email = valueOf(byId("loginEmail") as HTMLInputElement);
  const passwordInput = byId("loginPassword") as HTMLInputElement;
  const password = passwordInput.value;
  passwordInput.value = "";
  if (!email || !password) {
    setMessage("loginMessage", "Enter the administrator email and password.", "error");
    return;
  }
  button.disabled = true;
  setMessage("loginMessage", "Signing in with Supabase Auth…", "busy");
  try {
    const problem = await signInWithPassword(email, password);
    if (problem) {
      setMessage("loginMessage", problem.message, problem.kind === "unauthorized" ? "error" : "error");
      return;
    }
    await enterPanel();
    setMessage("loginMessage", "Signed in.", "ok");
  } finally {
    button.disabled = false;
  }
});

(byId("loginPassword") as HTMLInputElement).addEventListener("keydown", (event) => {
  if (event.key === "Enter") (byId("loginButton") as HTMLButtonElement).click();
});

for (const id of ["signOut", "signOut2"]) {
  byId(id).addEventListener("click", async () => {
    await endSession("Signed out.");
  });
}

byId("saveLanguages").addEventListener("click", () => {
  void saveLanguages();
});
byId("refreshLanguages").addEventListener("click", () => {
  void reloadEverything("Reloaded from the database.");
});
byId("refreshDashboard").addEventListener("click", () => {
  void reloadEverything("Refreshed from the database and the live endpoints.");
});

byId("refreshJarvis").addEventListener("click", async () => {
  setControlsDisabled(true);
  try {
    await loadSystemStateSection();
    setMessage("jarvisMessage", "Re-read from the database.", "ok");
  } finally {
    setControlsDisabled(false);
  }
});

(byId("jarvisSwitch") as HTMLInputElement).addEventListener("change", (event) => {
  void saveJarvisState((event.target as HTMLInputElement).checked);
});

byId("saveAssistantPolicy").addEventListener("click", () => {
  void saveAssistantPolicy();
});
byId("refreshAssistantPolicy").addEventListener("click", async () => {
  setControlsDisabled(true);
  try {
    await loadAssistantPolicySection();
    setMessage("policyMessage", "Re-read from the database.", "ok");
  } finally {
    setControlsDisabled(false);
  }
});

byId("refreshAi").addEventListener("click", async () => {
  setInline("aiStatus", "Checking the gateway…");
  try {
    state.health = await fetchHealth();
    state.healthError = null;
    renderAi();
    renderDashboard();
    setInline("aiStatus", "Checked just now.", "ok");
    setMessage("aiMessage", "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.health = null;
    state.healthError = message;
    renderAi();
    renderDashboard();
    setInline("aiStatus", "");
    setMessage("aiMessage", `jarvis-health could not be reached: ${message}`, "error");
  }
});

byId("refreshUserView").addEventListener("click", async () => {
  const button = byId("refreshUserView") as HTMLButtonElement;
  button.disabled = true;
  setInline("userViewStatus", "Fetching…", "busy");
  try {
    state.languagesEndpoint = await fetchUserAppConfiguration();
    state.languagesEndpointError = null;
    updateUserViewFromState();
    renderDashboard();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.languagesEndpoint = null;
    state.languagesEndpointError = message;
    byId("userView").textContent = `Unavailable: ${message}`;
    setInline("userViewStatus", message, "error");
    renderDashboard();
  } finally {
    button.disabled = false;
  }
});

/* ------------------------------------------------------------- lifecycle ---- */

/** Called after the session is known good: hides the gate and loads everything. */
async function enterPanel(): Promise<void> {
  const resolution = await resolveSession();
  if (resolution.status !== "administrator" || !resolution.user) {
    showLogin(resolution.problem);
    return;
  }
  applySession(resolution.user);
  hideLogin();
  setAuthenticated(true);
  await reloadEverything();
}

let endingSession = false;

async function endSession(message: string): Promise<void> {
  /* Two Sign out buttons, and a session-end event arriving while the operator is
     already leaving: signing out twice would revoke an already-revoked session
     and could leave the second attempt to report a failure over a success. */
  if (endingSession) return;
  endingSession = true;
  try {
    await signOut();
    resetConfiguration();
    state.user = null;
    clearSessionChrome();
    clear(byId("languageList"));
    byId("userView").textContent = "Not fetched yet.";
    renderDashboard();
    renderJarvis();
    renderAssistantPolicy();
    renderAi();
    setControlsDisabled(true);
    setAuthenticated(false);
    showLogin(null);
    setMessage("loginMessage", message, "ok");
  } finally {
    endingSession = false;
  }
}

/**
 * Keeps the panel honest while it is left open.
 *
 * A token that stops being accepted (revoked in Supabase, role removed, refresh
 * token rotated) produces a SIGNED_OUT event, and the panel returns to the gate
 * with an explanation rather than continuing to look signed in while every write
 * fails.
 */
const stopWatchingSession = onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    if (state.user) {
      void endSession("Your session ended. Sign in again to continue.");
    }
    return;
  }
  if (event === "TOKEN_REFRESHED" && session && state.user) {
    void refreshDashboardData();
  }
});

const onVisibilityChange = () => {
  if (document.visibilityState !== "visible" || !state.user || state.loading) return;
  /* Coming back to a tab that has been in the background is the most likely moment
     for a session to have gone stale, so re-verify rather than assume. */
  void reloadEverything("Configuration re-read after returning to this tab.");
};

document.addEventListener("visibilitychange", onVisibilityChange);

/**
 * Detaches the page from the session stream.
 *
 * The panel is a one-page app: in a browser this runs once, when the tab closes,
 * and there is nothing to detach. It exists so that a reload of the module during
 * development, or a second copy of the app in the same JavaScript context, cannot
 * leave an orphan listener behind that keeps writing to a panel nobody is looking
 * at any more.
 */
export function dispose(): void {
  stopWatchingSession();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  resetConfiguration();
}

if (import.meta.hot) import.meta.hot.dispose(dispose);

/* ------------------------------------------------------------------ boot ---- */

byId("settingsProject").textContent = SUPABASE_URL;
byId("settingsKey").textContent = maskKey(SUPABASE_ANON_KEY);
byId("settingsRedirect").textContent = window.location.origin;
byId("settingsSignIn").textContent = "Google (Supabase Auth, PKCE)";

async function boot(): Promise<void> {
  setAuthenticated(false);
  showPage("dashboard");

  try {
    const resolution = await resolveSession();
    if (resolution.status === "administrator" && resolution.user && isAdmin(resolution.user)) {
      applySession(resolution.user);
      hideLogin();
      setAuthenticated(true);
      await reloadEverything();
      if (resolution.problem) {
        setInline("userViewStatus", resolution.problem.message, resolution.problem.kind === "cancelled" ? "busy" : "error");
      }
      return;
    }
    if (resolution.status === "rejected") {
      resetConfiguration();
      clearSessionChrome();
      setControlsDisabled(true);
      showLogin(resolution.problem);
      return;
    }
    resetConfiguration();
    clearSessionChrome();
    setControlsDisabled(true);
    showLogin(resolution.problem);
  } catch (error) {
    /* A failure this early is a configuration problem, not a session problem, and
       it must be visible rather than leaving a blank panel. */
    const message = error instanceof Error ? error.message : String(error);
    resetConfiguration();
    clearSessionChrome();
    setControlsDisabled(true);
    showLogin({ kind: "configuration", message: `JARVIS Admin could not start: ${message}` });
  } finally {
    byId("boot").classList.add("hidden");
  }
}

void boot();

/* Exposed for the headless tests only; nothing in the page reads these. */
export { readLanguageDrafts, renderLanguages, state };