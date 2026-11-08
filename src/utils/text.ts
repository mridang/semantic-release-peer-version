/**
 * Shorten foreign text before it goes into an error message or a log line.
 *
 * @param text Text of any length.
 * @param max The most characters to keep.
 * @returns The text itself, or its first `max` characters followed by a
 * marker when it was longer.
 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... (truncated)` : text;
}
