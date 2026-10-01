/*
 * Page navigation.
 *
 * The panel is a single document: switching sections toggles a class rather than
 * changing the URL, so there is no route to break on reload and nothing for the
 * OAuth callback to land on but the site root.
 */
import { byId } from "./dom.ts";

export const PAGE_INFO: Record<string, { title: string; description: string }> = {
  dashboard: {
    title: "Dashboard",
    description: "JARVIS system overview and control center."
  },
  languages: {
    title: "Languages & Voices",
    description: "Configure exactly what languages and voices users can access."
  },
  jarvis: {
    title: "JARVIS",
    description: "Control the main JARVIS system state."
  },
  permissions: {
    title: "Permissions",
    description: "View required JARVIS permissions."
  },
  ai: {
    title: "AI Configuration",
    description: "Manage the active AI configuration."
  },
  settings: {
    title: "Settings",
    description: "Administrative system settings."
  }
};

export const PAGE_IDS = Object.keys(PAGE_INFO);

let currentPage = "dashboard";

export function activePage(): string {
  return currentPage;
}

export function showPage(page: string): void {
  const info = PAGE_INFO[page];
  if (!info) return;
  currentPage = page;
  for (const section of document.querySelectorAll(".page")) {
    section.classList.toggle("active", section.id === page);
  }
  for (const button of byId("nav").querySelectorAll("button")) {
    button.classList.toggle("active", button.getAttribute("data-page") === page);
  }
  byId("pageTitle").textContent = info.title;
  byId("pageDescription").textContent = info.description;
  byId("sidebar").classList.remove("open");
}