/**
 * Sanitizes strings by stripping ASCII control characters.
 */

// Strip control characters but allow normal whitespace \t, \n, \r for multiline text like bio
const CONTROL_CHARS_ALLOW_LINEBREAKS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Strip all control characters including newlines/tabs for single-line text like name
const ALL_CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

export function sanitizeName(name: string): string {
  return name.replace(ALL_CONTROL_CHARS, '').trim();
}

export function sanitizeBio(bio: string): string {
  return bio.replace(CONTROL_CHARS_ALLOW_LINEBREAKS, '').trim();
}
