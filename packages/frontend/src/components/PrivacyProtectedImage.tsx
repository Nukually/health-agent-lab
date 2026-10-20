import type { CSSProperties, MouseEventHandler, ReactEventHandler } from 'react'

interface Props {
  src: string
  alt: string
  imageStyle?: CSSProperties
  wrapperStyle?: CSSProperties
  badgeStyle?: CSSProperties
  privacyProtected?: boolean
  onClick?: MouseEventHandler<HTMLDivElement>
  onError?: ReactEventHandler<HTMLImageElement>
}

export function PrivacyProtectionBadge({ style }: { style?: CSSProperties }) {
  return (
    <div style={{ ...styles.badge, ...style }} aria-label="隐私保护">
      <span style={styles.badgeIcon} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l7 3v5c0 4.6-2.8 8.3-7 10-4.2-1.7-7-5.4-7-10V6l7-3z" />
          <path d="M9.5 12l1.7 1.7 3.6-4" />
        </svg>
      </span>
      <span>隐私保护</span>
    </div>
  )
}

export default function PrivacyProtectedImage({
  src,
  alt,
  imageStyle,
  wrapperStyle,
  badgeStyle,
  privacyProtected = true,
  onClick,
  onError,
}: Props) {
  const borderRadius = imageStyle?.borderRadius ?? wrapperStyle?.borderRadius ?? 10

  return (
    <div
      style={{
        ...styles.wrap,
        borderRadius,
        cursor: onClick ? 'pointer' : undefined,
        ...wrapperStyle,
      }}
      onClick={onClick}
    >
      <img
        src={src}
        alt={alt}
        style={{
          ...styles.image,
          ...imageStyle,
        }}
        onError={onError}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      {privacyProtected && (
        <PrivacyProtectionBadge style={badgeStyle} />
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    position: 'relative',
    display: 'inline-block',
    overflow: 'hidden',
    maxWidth: '100%',
    lineHeight: 0,
    background: 'var(--color-primary-bg)',
  },
  image: {
    display: 'block',
    maxWidth: '100%',
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 24,
    padding: '0 9px 0 5px',
    borderRadius: 14,
    border: '1px solid rgba(255, 106, 42, 0.20)',
    background: 'rgba(255, 255, 255, 0.94)',
    color: 'var(--color-primary)',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    boxShadow: '0 6px 18px rgba(255, 106, 42, 0.18)',
    pointerEvents: 'none',
  },
  badgeIcon: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-primary)',
    color: '#fff',
    flexShrink: 0,
  },
}
