import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSensitiveLogText } from './log-redaction.js'

test('redacts signed URLs and image data URLs from log text', () => {
  const input = 'unsupported image url: https://oss.example.com/a.jpg?OSSAccessKeyId=key&Expires=1&Signature=secret and data:image/png;base64,abcdef=='
  const redacted = redactSensitiveLogText(input)

  assert.doesNotMatch(redacted, /Signature=secret/)
  assert.doesNotMatch(redacted, /base64,abcdef/)
  assert.match(redacted, /\[SIGNED_URL_QUERY_REDACTED\]/)
  assert.match(redacted, /\[IMAGE_DATA_URL_REDACTED\]/)
})
