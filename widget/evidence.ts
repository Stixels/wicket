/** An evidence marker: [E1], or a group such as [E1, E4] or [E1–E3]. */
const MARKER = String.raw`\[E\d{1,3}(?:\s*[,–-]\s*E\d{1,3})*\]`;

/**
 * The assistant cites [E1] so it only quotes numbers its tools returned, but the markers just repeat the
 * sentence for the reader, so they're left out; "How we got this" lists the basis instead. A marker
 * followed by "(" is a markdown link's text, which stays.
 */
export function hideEvidenceMarkers(text: string): string {
  return text.replace(new RegExp(`[^\\S\\n]*${MARKER}(?!\\()`, "g"), "");
}
