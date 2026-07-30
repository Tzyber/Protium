/** rust-commands rejecten mit einem rohen string (kein Error-objekt) →
 *  `(e as Error).message` wäre dann `undefined` und die echte ursache weg. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
