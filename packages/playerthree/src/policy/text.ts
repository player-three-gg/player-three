/** UTF-8 byte-bounded text helpers for engine messages and logs crossing the policy sandbox boundary. */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Engine messages about the caller's own artifact are capped at this many UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 1024;

/** Longest prefix of `bytes` that is at most `max` bytes and does not split a UTF-8 sequence. */
export function utf8Prefix(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = Math.max(0, max);
  // Back off continuation bytes (10xxxxxx) so the cut lands on a sequence boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/** Decodes UTF-8 (invalid sequences become U+FFFD) and truncates to at most `maxBytes` UTF-8 bytes. */
export function decodeTruncated(bytes: Uint8Array, maxBytes: number): string {
  const s = decoder.decode(bytes);
  return truncateUtf8(s, maxBytes);
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so short strings always fit.
  if (s.length * 3 <= maxBytes) return s;
  // …and to at least 1 byte, so the first `maxBytes` units are all that can survive.
  let head = s.length > maxBytes ? s.slice(0, maxBytes) : s;
  const last = head.charCodeAt(head.length - 1);
  if (head.length < s.length && last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  const bytes = encoder.encode(head);
  if (bytes.length <= maxBytes && head.length === s.length) return s;
  return decoder.decode(utf8Prefix(bytes, maxBytes));
}
