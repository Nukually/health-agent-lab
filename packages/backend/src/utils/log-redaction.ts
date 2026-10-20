export function redactSensitiveLogText(value: string): string {
  return value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[IMAGE_DATA_URL_REDACTED]')
    .replace(
      /(https?:\/\/[^\s"'<>?]+)\?([^\s"'<>]*(?:Signature|OSSAccessKeyId|Expires|X-Amz-Signature|X-Amz-Credential)[^\s"'<>]*)/gi,
      '$1?[SIGNED_URL_QUERY_REDACTED]',
    )
}
