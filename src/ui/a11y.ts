const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // der selector ist eine union: <button tabindex="-1"> matcht über den
    // button-zweig, obwohl es aus der tab-reihenfolge entfernt wurde. ein
    // focus-trap darf solche elemente nicht anspringen.
    if (el.tabIndex < 0) return false;
    return true;
  });
}

export function focusFirstFocusable(root: HTMLElement | null): boolean {
  if (!root) return false;
  const [first] = getFocusableElements(root);
  const target = first ?? root;
  target.focus({ preventScroll: true });
  return true;
}

export function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== "Tab" || !root) return;

  const focusable = getFocusableElements(root);
  if (!focusable.length) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }

  const current = document.activeElement;
  // focusable ist garantiert nicht leer (guard oben), ?? root macht TS happy
  const first = focusable[0] ?? root;
  const last = focusable[focusable.length - 1] ?? root;

  if (event.shiftKey) {
    if (current === first || !root.contains(current)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    }
    return;
  }

  if (current === last || !root.contains(current)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

export function restoreFocus(target: HTMLElement | null): void {
  if (target?.isConnected) {
    target.focus({ preventScroll: true });
    return;
  }
  // nach unmount: aktiver sidebar-tab → view-h1 → body
  const nav = document.querySelector<HTMLElement>('[aria-current="page"]');
  if (nav) {
    nav.focus({ preventScroll: true });
    return;
  }
  const h1 = document.querySelectorAll<HTMLElement>(".content h1").item(0) ?? null;
  if (h1) {
    h1.focus({ preventScroll: true });
    return;
  }
  document.body.focus({ preventScroll: true });
}
