// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusFirstFocusable, restoreFocus, trapFocus } from "../../src/ui/a11y";

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
}

/** dialog-ähnliche struktur: zwei buttons + ein input im root. */
function buildDialog(): {
  root: HTMLElement;
  first: HTMLButtonElement;
  input: HTMLInputElement;
  last: HTMLButtonElement;
} {
  const root = document.createElement("div");
  const first = document.createElement("button");
  first.textContent = "first";
  const input = document.createElement("input");
  const last = document.createElement("button");
  last.textContent = "last";
  root.append(first, input, last);
  document.body.appendChild(root);
  return { root, first, input, last };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusFirstFocusable", () => {
  it("fokussiert das erste fokussierbare element", () => {
    const { root, first } = buildDialog();
    expect(focusFirstFocusable(root)).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("überspringt disabled, aria-hidden und tabindex=-1", () => {
    const root = document.createElement("div");
    const disabled = document.createElement("button");
    disabled.disabled = true;
    const hidden = document.createElement("button");
    hidden.setAttribute("aria-hidden", "true");
    const skipped = document.createElement("button");
    skipped.tabIndex = -1;
    const real = document.createElement("button");
    root.append(disabled, hidden, skipped, real);
    document.body.appendChild(root);

    focusFirstFocusable(root);
    expect(document.activeElement).toBe(real);
  });

  it("ohne fokussierbare elemente fällt es auf den root zurück", () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    root.textContent = "nur text";
    document.body.appendChild(root);

    expect(focusFirstFocusable(root)).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("null-root → false, kein crash", () => {
    expect(focusFirstFocusable(null)).toBe(false);
  });
});

describe("trapFocus", () => {
  it("ignoriert andere tasten als Tab", () => {
    const { root, first } = buildDialog();
    first.focus();
    const e = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("Tab auf dem letzten element springt zum ersten", () => {
    const { root, first, last } = buildDialog();
    last.focus();
    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab auf dem ersten element springt zum letzten", () => {
    const { root, first, last } = buildDialog();
    first.focus();
    const e = tabEvent(true);
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("Tab in der mitte läuft normal weiter (kein eingriff)", () => {
    const { root, first } = buildDialog();
    first.focus();
    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(false);
  });

  it("fokus außerhalb des roots wird wieder hereingeholt", () => {
    const { root, first } = buildDialog();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("leerer root: Tab wird abgefangen, root bekommt den fokus", () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.appendChild(root);

    const e = tabEvent();
    trapFocus(e, root);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root);
  });

  it("null-root: kein eingriff", () => {
    const e = tabEvent();
    trapFocus(e, null);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("restoreFocus", () => {
  it("fokussiert das gespeicherte element, wenn es noch im DOM ist", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    restoreFocus(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("fallback-kette bei entferntem element: [aria-current=page] zuerst", () => {
    const ghost = document.createElement("button");
    document.body.appendChild(ghost);
    ghost.remove(); // disconnected

    const nav = document.createElement("button");
    nav.setAttribute("aria-current", "page");
    document.body.appendChild(nav);
    const h1 = document.createElement("h1");
    h1.tabIndex = -1;
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(h1);
    document.body.appendChild(content);

    restoreFocus(ghost);
    expect(document.activeElement).toBe(nav);
  });

  it("fallback ohne nav: .content h1", () => {
    const h1 = document.createElement("h1");
    h1.tabIndex = -1;
    const content = document.createElement("div");
    content.className = "content";
    content.appendChild(h1);
    document.body.appendChild(content);

    restoreFocus(null);
    expect(document.activeElement).toBe(h1);
  });

  it("letzter fallback: body", () => {
    restoreFocus(null);
    expect(document.activeElement).toBe(document.body);
  });
});
