/*
 * Small DOM helpers.
 *
 * Text is always inserted with createTextNode, never with innerHTML: the values
 * rendered here are database content (display names, attribution text, voice
 * names, error messages), and none of it is ever parsed as markup.
 */

export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The page is missing #${id}.`);
  return node;
}

/** Same as byId but for elements that may legitimately be absent. */
export function maybeById(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function byIdOrThrow<T extends HTMLElement>(id: string, type: new (...args: never[]) => T): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The page is missing #${id}.`);
  const typed = node as unknown as T;
  if (!(node instanceof type)) throw new Error(`#${id} is not the expected element.`);
  return typed;
}

export function text(value: unknown): Text {
  return document.createTextNode(value == null ? "" : String(value));
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  content?: string | number | null
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.appendChild(text(content));
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export type MessageKind = "ok" | "error" | "busy" | "";

/** The block-level status line used under each section. */
export function setMessage(id: string, message: string, kind: MessageKind = ""): void {
  const node = maybeById(id);
  if (!node) return;
  node.textContent = message || "";
  node.className = "message" + (kind ? " " + kind : "");
}

/** The quieter status line used inline next to a control. */
export function setInline(id: string, message: string, kind: MessageKind = ""): void {
  const node = maybeById(id);
  if (!node) return;
  node.textContent = message || "";
  node.className = "inline-status" + (kind ? " " + kind : "");
}

export function timestamp(value: string | null | undefined): string {
  if (!value) return "unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

export function setEnabled(node: HTMLElement | null | undefined, enabled: boolean): void {
  if (!node) return;
  if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
    (node as HTMLButtonElement | HTMLInputElement).disabled = !enabled;
  }
}

export function setChecked(node: HTMLInputElement | null | undefined, checked: boolean): void {
  if (node) node.checked = checked;
}

export function setValue(node: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): void {
  if (node) node.value = value;
}

export function valueOf(node: HTMLInputElement | HTMLTextAreaElement | null | undefined): string {
  return node ? node.value.trim() : "";
}