// minimal-eigenlösung: keine vue-i18n o. ä. — nur eine t()-funktion mit
// dot-notation-keys, interpolation und fallback. locale wird einmal beim
// start aus navigator.language abgeleitet, kein UI-toggle, keine persistenz.
//
// struktur: neue locale = neue datei in diesem ordner + eintrag in `tables`.
// typ-sicherheit: die keys werden aus `de` abgeleitet, ein tippfehler ist
// damit ein TS-fehler.

import { de } from "./de.js";
import { en } from "./en.js";

export type Locale = "de" | "en";
export type Dict = typeof de;

const tables: Record<Locale, Dict> = { de, en };

function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

let activeLocale: Locale = detectLocale();

/** nur für tests — produktion ruft das nie auf. */
export function setLocale(l: Locale): void {
  activeLocale = l;
}

export function getLocale(): Locale {
  return activeLocale;
}

// dot-pfad aus einem nested-dict. liefert den string, oder undefined wenn
// der pfad nicht (oder nicht zu einem string) auflöst.
function lookup(table: Dict, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = table;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

// {name}, {n}, {size} etc. → stringified wert. fehlt ein parameter, bleibt
// der platzhalter stehen (so fällt der fehler im UI sichtbar auf).
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : `{${k}}`,
  );
}

// rekursiv: baut einen union-typ aus dot-pfaden aller string-blätter.
//   { a: "x", b: { c: "y" } }  →  "a" | "b.c"
type DotPath<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends object
      ? DotPath<T[K], `${P}${K}.`>
      : never;
}[keyof T & string];

export type Key = DotPath<Dict>;

/** übersetzt einen key. interpolations-platzhalter {name} im string werden ersetzt. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const value = lookup(tables[activeLocale], key) ?? lookup(tables.en, key);
  if (value === undefined) return key; // letzter ausweg: key als literaler hinweis
  return params ? interpolate(value, params) : value;
}
