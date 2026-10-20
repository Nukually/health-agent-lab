/**
 * Strip model-leaked XML/HTML-ish tag literals from Markdown-only A2UI text.
 *
 * This intentionally runs after the A2UI parser has already consumed valid
 * semantic tags. That keeps legal tags renderable while preventing malformed
 * leftovers like `<recommendation priority="high">` or `</response>` from
 * showing as user-visible text.
 */
const XML_LIKE_TAG_RE =
  /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|[^\s"'=<>`]+))?)*\s*\/?>/g

export function stripInvalidXmlLikeTags(text: string): string {
  return text.replace(XML_LIKE_TAG_RE, '')
}
