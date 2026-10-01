/*
 * Headless harness: loads the real page, points it at the fake Supabase, and
 * imports the real application modules.
 *
 * Nothing is mocked below the network boundary. The page's own markup, its
 * event wiring, the Supabase client and every query go through exactly the code
 * that ships, so a passing check means the wiring works, not that a stub agrees.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { vi } from "vitest";
import { createFakeBackend, seedDb, storedSession, type FakeBackend, type FakeDb } from "./fakeBackend.ts";
import type * as PanelModule from "../src/main.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, "..", "index.html");

export interface MountedPage {
  document: Document;
  window: Window & typeof globalThis;
  backend: FakeBackend;
  api: typeof PanelModule;
  storage: Map<string, string>;
  clicks: string[];
  confirmed: string[];
  /** Detaches the mounted app from the session stream. */
  dispose: () => void;
}

/** The most recently mounted app, torn down before the next one is installed. */
let active: MountedPage | null = null;

export interface MountOptions {
  db?: Partial<FakeDb>;
  session?: string | null;
  url?: string;
  healthStatus?: number;
  /** Make every request fail the way an unreachable host does, from the start. */
  offline?: string;
}

export async function mountPage(options: MountOptions = {}): Promise<MountedPage> {
  /* One mount per test: the previous app stops listening before the next one is
     installed, so a panel left open in an earlier test cannot react to (or repaint)
     the panel under test now. */
  active?.dispose();
  active = null;

  const html = readFileSync(pagePath, "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  const { window } = parseHTML(html) as unknown as { window: Window & typeof globalThis };

  const db = seedDb(options.db ?? {});
  const backend = createFakeBackend({ db, ...(options.healthStatus ? { healthStatus: options.healthStatus } : {}) });
  if (options.offline) backend.offline = options.offline;

  const storage = new Map<string, string>();
  if (options.session) storage.set("jarvis_admin_session", options.session);
  const fakeStorage = {
    getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
    setItem: (key: string, value: string) => void storage.set(key, String(value)),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    }
  };

  const clicks: string[] = [];
  const confirmed: string[] = [];
  const baseUrl = options.url ?? "https://jarvis-admin-topaz.vercel.app/";

  const win = window as unknown as Record<string, unknown>;
  win.localStorage = fakeStorage;
  win.sessionStorage = fakeStorage;
  win.confirm = (message: string) => {
    confirmed.push(String(message));
    return true;
  };
  win.alert = () => undefined;
  win.innerWidth = 1440;
  win.innerHeight = 900;
  win.scrollTo = () => undefined;
  /*
   * Supabase uses BroadcastChannel to keep open tabs in step. Node ships one
   * global implementation that every channel in the process shares, so without
   * this each mounted app would see itself as a second tab and start reporting
   * the previous one's sign-ins and sign-outs. A real browser tab never hears its
   * own channel, which is what this reproduces.
   */
  win.BroadcastChannel = makeSilentBroadcastChannel();
  win.matchMedia =
    win.matchMedia ??
    (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));

  /* A stable, non-redirecting location the OAuth path can write to. */
  let currentHref = baseUrl;
  win.location = makeLocation(() => currentHref, (href: string) => {
    clicks.push(href);
  });
  win.history = {
    replaceState: (_data: unknown, _unused: string, url?: string) => {
      currentHref = new URL(String(url ?? "/"), baseUrl).toString();
      (win.location as { href: string }).href = currentHref;
    },
    pushState: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    length: 1,
    scrollRestoration: "auto",
    state: null
  };

  installGlobals(window);
  define("BroadcastChannel", win.BroadcastChannel);
  globalThis.fetch = backend.fetchStub as unknown as typeof fetch;

  vi.resetModules();
  const api = (await import("../src/main.ts")) as typeof PanelModule;

  const document = window.document as unknown as Document;
  await waitFor(() => document.getElementById("boot")?.classList.contains("hidden") === true);

  const page: MountedPage = {
    document,
    window: window as Window & typeof globalThis,
    backend,
    api,
    storage,
    clicks,
    confirmed,
    dispose: () => {
      if (active !== page) return;
      api.dispose();
      active = null;
    }
  };
  active = page;
  return page;
}

/** A BroadcastChannel that accepts messages and delivers none: one tab, not two. */
function makeSilentBroadcastChannel(): typeof BroadcastChannel {
  class SilentBroadcastChannel implements BroadcastChannel {
    readonly name: string;
    onmessage: BroadcastChannel["onmessage"] = null;
    onmessageerror: BroadcastChannel["onmessageerror"] = null;

    constructor(name: string) {
      this.name = name;
    }

    addEventListener(): void {
      /* Nothing is ever delivered, so there is nothing to register. */
    }

    removeEventListener(): void {
      /* Nothing is ever delivered, so there is nothing to remove. */
    }

    dispatchEvent(): boolean {
      return true;
    }

    postMessage(): void {
      /* A channel does not receive its own messages. */
    }

    close(): void {
      /* Nothing to release. */
    }
  }
  return SilentBroadcastChannel as unknown as typeof BroadcastChannel;
}

function makeLocation(href: () => string, onNavigate: (href: string) => void) {
  const parsed = new URL(href());
  return {
    get href() {
      return href();
    },
    set href(value: string) {
      onNavigate(value);
    },
    get protocol() {
      return parsed.protocol;
    },
    get host() {
      return parsed.host;
    },
    get hostname() {
      return parsed.hostname;
    },
    get origin() {
      return parsed.origin;
    },
    get port() {
      return parsed.port;
    },
    get pathname() {
      return new URL(href()).pathname;
    },
    get search() {
      return new URL(href()).search;
    },
    get hash() {
      return new URL(href()).hash;
    },
    assign: (value: string) => onNavigate(value),
    replace: (value: string) => onNavigate(value),
    reload: () => undefined,
    toString: () => href()
  };
}

/** Publishes the DOM classes the app and the Supabase client test against. */
function installGlobals(window: Window & typeof globalThis): void {
  const source = window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    "HTMLElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "HTMLTextAreaElement",
    "HTMLLabelElement",
    "HTMLSelectElement",
    "Element",
    "Node",
    "NodeList",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "StorageEvent",
    "DOMParser",
    "DocumentFragment",
    "getComputedStyle"
  ]) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  target.window = window;
  target.document = window.document;
  define("localStorage", source.localStorage);
  define("sessionStorage", source.sessionStorage);
  define("location", source.location);
  define("history", source.history);
  define("navigator", source.navigator ?? { userAgent: "jarvis-admin-tests", language: "en-GB" });
}

/**
 * Node exposes some of these as getter-only globals, so a plain assignment throws.
 * Redefining the property is the only way to point them at the test window.
 */
function define(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

export async function waitFor(predicate: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Lets every pending microtask and timer callback run. */
export async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function textOf(page: MountedPage, id: string): string {
  return page.document.getElementById(id)?.textContent ?? "";
}

export function click(page: MountedPage, id: string): void {
  const node = page.document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing`);
  const EventCtor = (page.window as unknown as { Event: new (type: string) => Event }).Event;
  node.dispatchEvent(new EventCtor("click"));
}

export function setChecked(page: MountedPage, id: string, value: boolean): void {
  const node = page.document.getElementById(id) as HTMLInputElement | null;
  if (!node) throw new Error(`#${id} is missing`);
  node.checked = value;
}

export function setField(page: MountedPage, id: string, value: string): void {
  const node = page.document.getElementById(id) as HTMLInputElement | null;
  if (!node) throw new Error(`#${id} is missing`);
  node.value = value;
}

export function languageCard(page: MountedPage, displayName: string): HTMLElement {
  const card = [...page.document.querySelectorAll("article.language")].find(
    (node) => node.querySelector(".language-name")?.textContent === displayName
  );
  if (!card) throw new Error(`No language card named ${displayName}.`);
  return card as HTMLElement;
}

export { storedSession };