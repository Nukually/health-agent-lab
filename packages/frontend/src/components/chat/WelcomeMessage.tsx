import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type ApiResponse,
  type AgentRecommendedQuestionsResponse,
  type RecommendedQuestionInteraction,
  isFeatureEnabled,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import { reportAnalyticsEvent } from '../../services/analytics.js'
import { createClientId } from '../../utils/id.js'
import { useStore } from '../../stores/index.js'
import { hasNativeBridge } from '../../lib/nativeBridge.js'
import {
  getAndroidApkUrl,
  getHarmonyBetaUrl,
  getTestFlightUrl,
  readAppInstallCtaDismissed,
  resolveMarketingBannerSequence,
  resolveAppInstallAction,
  shouldShowMarketingBannerIndicators,
  writeAppInstallCtaDismissed,
  type MarketingBannerKind,
} from '../../appInstallCta.js'

const RECOMMENDED_QUESTION_DISPLAY_LIMIT = 3
const RECOMMENDED_QUESTION_POLL_MS = 1000
const RECOMMENDED_QUESTION_MAX_POLLS = 15
const cxLogoUrl = '/assets/agent-demo.svg'
type SuggestionIconKind = 'symptom' | 'record' | 'emotion' | 'care'

interface Props {
  onSuggestionClick: (text: string, interaction: RecommendedQuestionInteraction) => void
  sessionId?: string | null
}

interface RecommendationResponseMeta {
  source: AgentRecommendedQuestionsResponse['source']
  cached: boolean
  generatedAt: string | null
}

type InstallDialogState =
  | { type: 'embeddedBrowserGuide'; url: string; target: 'android_apk' | 'harmony_beta' }
  | { type: 'platforms' }
  | { type: 'iosUnavailable' }
  | { type: 'privateWechat' }

function normalizeSuggestionText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。！？!?,.；;：:“”"'‘’、（）()【】\[\]《》<>]/g, '')
}

function buildRecommendationInteraction(
  question: string,
  rank: number,
  responseMeta: RecommendationResponseMeta | null,
): RecommendedQuestionInteraction {
  return {
    interactionId: createClientId('recommended-question'),
    source: 'agent',
    question,
    rank,
    cached: responseMeta?.cached,
    generatedAt: responseMeta?.generatedAt ?? null,
  }
}

function stableIconFallback(text: string): SuggestionIconKind {
  const icons: SuggestionIconKind[] = ['symptom', 'record', 'emotion', 'care']
  let hash = 0
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return icons[hash % icons.length]
}

function resolveSuggestionIconKind(text: string): SuggestionIconKind {
  const normalized = normalizeSuggestionText(text)
  if (/记录|复查|报告|检查|化验|指标|病历|用药|服药|日记|打卡|整理|保存|上传/.test(normalized)) {
    return 'record'
  }
  if (/担心|害怕|怕|焦虑|情绪|低落|紧张|压力|睡不着|失眠|心慌|拖累|家人|难过|心情|孤独|支持/.test(normalized)) {
    return 'emotion'
  }
  if (/潮热|关节|疼|痛|不适|恶心|乏力|发热|发烧|内分泌|化疗|放疗|副作用|症状|肿胀|水肿|皮疹|麻木|月经|出汗/.test(normalized)) {
    return 'symptom'
  }
  if (/饮食|运动|康复|护理|跟练|伤口|日常|作息|营养|锻炼|恢复/.test(normalized)) {
    return 'care'
  }
  return stableIconFallback(normalized || text)
}

export function AppInstallCtaBanner({ containerStyle }: { containerStyle?: React.CSSProperties } = {}) {
  const [appInstallDismissed, setAppInstallDismissed] = useState(() => readAppInstallCtaDismissed())
  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null)
  const [activeBannerIndex, setActiveBannerIndex] = useState(0)
  const featureSnapshot = useStore((s) => s.features)
  const appDownloads = useStore((s) => s.appDownloads)
  const experience = useStore((s) => s.experience)
  const userSource = useStore((s) => s.userSource)
  const bannerSurface = hasNativeBridge() ? experience.surface : 'h5'
  const bannerSequence = resolveMarketingBannerSequence({
    surface: bannerSurface,
    channelSourceType: userSource?.type ?? null,
    dismissed: appInstallDismissed,
    featureEnabled: isFeatureEnabled(featureSnapshot, 'h5AppDownloadBanner'),
  })
  const activeBanner = bannerSequence[activeBannerIndex] ?? bannerSequence[0] ?? null
  const showBannerIndicators = shouldShowMarketingBannerIndicators(bannerSequence)

  useEffect(() => {
    if (activeBannerIndex < bannerSequence.length) return
    setActiveBannerIndex(0)
  }, [activeBannerIndex, bannerSequence.length])

  useEffect(() => {
    if (bannerSequence.length <= 1) return
    const timer = window.setInterval(() => {
      setActiveBannerIndex((index) => (index + 1) % bannerSequence.length)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [bannerSequence.length])

  const handleDismissAppInstallCta = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    writeAppInstallCtaDismissed()
    setAppInstallDismissed(true)
  }

  const handleOpenAndroidDownload = () => {
    window.location.href = getAndroidApkUrl(appDownloads.android)
  }

  const handleOpenTestFlight = () => {
    const url = getTestFlightUrl(appDownloads.ios)
    if (!url) {
      setInstallDialog({ type: 'iosUnavailable' })
      return
    }
    window.location.href = url
  }

  const handleOpenHarmonyBeta = () => {
    window.location.href = getHarmonyBetaUrl(appDownloads.harmony)
  }

  const handleOpenInstallGuideTarget = () => {
    if (installDialog?.type !== 'embeddedBrowserGuide') return
    window.location.href = installDialog.url
  }

  const handleAppInstallCtaClick = () => {
    const action = resolveAppInstallAction({
      androidApkUrl: appDownloads.android,
      testFlightUrl: appDownloads.ios,
      harmonyBetaUrl: appDownloads.harmony,
    })
    if (action.type === 'download_apk' || action.type === 'open_testflight' || action.type === 'open_harmony_beta') {
      window.location.href = action.url
      return
    }

    if (action.type === 'show_embedded_browser_guide') {
      setInstallDialog({ type: 'embeddedBrowserGuide', url: action.url, target: action.target })
      return
    }

    setInstallDialog({ type: 'platforms' })
  }

  const handleAppInstallCtaKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handleAppInstallCtaClick()
  }

  const handlePrivateWechatClick = () => {
    setInstallDialog({ type: 'privateWechat' })
  }

  const handlePrivateWechatKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    handlePrivateWechatClick()
  }

  const handlePrivateWechatTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    event.preventDefault()
    handlePrivateWechatClick()
  }

  if (!activeBanner) return null

  const appInstallCard = (
    <div
      style={styles.appInstallCard}
      role="button"
      tabIndex={0}
      onClick={handleAppInstallCtaClick}
      onKeyDown={handleAppInstallCtaKeyDown}
    >
      <span style={styles.appInstallGlow} aria-hidden="true" />
      <button
        type="button"
        style={styles.appInstallClose}
        aria-label="关闭 App 推荐"
        onClick={handleDismissAppInstallCta}
      >
        ×
      </button>
      <div style={styles.appInstallCopy}>
        <p style={styles.appInstallEyebrow}>为了更完整的体验</p>
        <h3 style={styles.appInstallTitle}>
          推荐使用 <span style={styles.appInstallTitleAccent}>Health Agent Lab App</span>
        </h3>
        <p style={styles.appInstallDesc}>健康档案 · 提醒管理 · 专属服务</p>
        <span style={styles.appInstallButton}>
          立即前往 App
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>
      <div style={styles.appInstallPhoneWrap} aria-hidden="true">
        <div style={styles.appInstallPhone}>
          <span style={styles.phoneSpeaker} />
          <span style={styles.phoneCardLineWide} />
          <span style={styles.phoneCardLine} />
          <span style={styles.phonePillOne} />
          <span style={styles.phonePillTwo} />
          <span style={styles.phoneBottomDot} />
        </div>
        <span style={styles.appInstallBadge}>更安全 更便捷</span>
      </div>
    </div>
  )

  const privateWechatCard = (
    <div
      style={styles.privateWechatCard}
      role="button"
      tabIndex={0}
      onClick={handlePrivateWechatClick}
      onTouchEnd={handlePrivateWechatTouchEnd}
      onKeyDown={handlePrivateWechatKeyDown}
    >
      <button
        type="button"
        style={styles.appInstallClose}
        aria-label="关闭示例资源推荐"
        onClick={handleDismissAppInstallCta}
        onTouchEnd={(event) => event.stopPropagation()}
      >
        ×
      </button>
      <img
        src="/assets/demo-placeholder.svg"
        alt="技术演示占位图"
        style={styles.privateWechatBannerImage}
      />
    </div>
  )

  const cards: Record<MarketingBannerKind, React.ReactNode> = {
    app_install: appInstallCard,
    private_wechat: privateWechatCard,
  }

  const bannerCarousel = (
    <div style={styles.marketingBannerShell}>
      <div style={styles.marketingBannerViewport}>
        {cards[activeBanner]}
      </div>
      {showBannerIndicators && (
        <div style={styles.marketingBannerIndicators} aria-label="轮播图指示器">
          {bannerSequence.map((banner, index) => (
            <button
              key={`${banner}-${index}`}
              type="button"
              aria-label={`切换到第 ${index + 1} 张 banner`}
              aria-current={index === activeBannerIndex ? 'true' : undefined}
              style={{
                ...styles.marketingBannerIndicatorDot,
                ...(index === activeBannerIndex ? styles.marketingBannerIndicatorDotActive : null),
              }}
              onClick={() => setActiveBannerIndex(index)}
            />
          ))}
        </div>
      )}
    </div>
  )

  const installDialogElement = installDialog ? (
    <div style={styles.installDialogBackdrop} onClick={() => setInstallDialog(null)}>
      <div style={styles.installDialog} onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          style={styles.installDialogClose}
          aria-label="关闭安装引导"
          onClick={() => setInstallDialog(null)}
        >
          ×
        </button>
        {installDialog.type === 'embeddedBrowserGuide' && (
          <>
            <div style={styles.installDialogIcon}>···</div>
            <h3 style={styles.installDialogTitle}>请在浏览器中打开</h3>
            <p style={styles.installDialogText}>
              {installDialog.target === 'harmony_beta'
                ? '当前应用内浏览器可能无法完成安装。请点击「前往内测链接」后，再点击右上角「···」选择「在浏览器打开」。如果你刚加入测试组，请等待约 24 小时后再体验。'
                : '当前应用内浏览器无法直接安装。请点击下方按钮进入 APK 下载链接，再点击右上角「···」，选择「在浏览器打开」后安装Health Agent Lab App。'}
            </p>
            <button type="button" style={styles.wechatDownloadButton} onClick={handleOpenInstallGuideTarget}>
              {installDialog.target === 'harmony_beta' ? '前往内测链接' : '前往下载链接'}
            </button>
          </>
        )}
        {installDialog.type === 'platforms' && (
          <>
            <h3 style={styles.installDialogTitle}>选择你的手机系统</h3>
            <p style={styles.installDialogText}>我们会根据系统打开对应的安装方式。</p>
            <div style={styles.platformActions}>
              <button type="button" style={styles.platformButton} onClick={handleOpenAndroidDownload}>
                <span style={styles.platformEmoji}>🤖</span>
                Android 下载 APK
              </button>
              <button type="button" style={styles.platformButton} onClick={handleOpenTestFlight}>
                <span style={styles.platformEmoji}>🍎</span>
                iOS TestFlight
              </button>
              <button type="button" style={styles.platformButton} onClick={handleOpenHarmonyBeta}>
                <span style={styles.platformEmoji}>🌸</span>
                鸿蒙 5.0+ 内测
              </button>
            </div>
          </>
        )}
        {installDialog.type === 'iosUnavailable' && (
          <>
            <h3 style={styles.installDialogTitle}>iOS 安装链接待配置</h3>
            <p style={styles.installDialogText}>
              当前暂未配置 TestFlight 链接。请由部署者配置自己的安装链接。
            </p>
          </>
        )}
        {installDialog.type === 'privateWechat' && (
          <>
            <h3 style={styles.installDialogTitle}>示例资源</h3>
            <p style={styles.installDialogText}>此处为资源展示示例，默认未启用。</p>
            <img
              src="/assets/demo-placeholder.svg"
              alt="技术演示占位图"
              style={styles.privateWechatLandingImage}
            />
          </>
        )}
      </div>
    </div>
  ) : null

  return (
    <>
      {containerStyle ? <div style={containerStyle}>{bannerCarousel}</div> : bannerCarousel}
      {installDialogElement && typeof document !== 'undefined'
        ? createPortal(installDialogElement, document.body)
        : null}
    </>
  )
}

export default function WelcomeMessage({ onSuggestionClick, sessionId = null }: Props) {
  const [recommendedQuestions, setRecommendedQuestions] = useState<string[]>([])
  const [responseMeta, setResponseMeta] = useState<RecommendationResponseMeta | null>(null)
  const [isLoadingRecommendedQuestions, setIsLoadingRecommendedQuestions] = useState(true)
  const exposedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let pollTimer: number | undefined

    const loadRecommendedQuestions = (pollCount: number) => {
      api.get<ApiResponse<AgentRecommendedQuestionsResponse>>('/chat/recommended-questions')
        .then((response) => {
          if (cancelled) return
          const data = response.data ?? null
          if (data?.status === 'generating' && pollCount < RECOMMENDED_QUESTION_MAX_POLLS) {
            setIsLoadingRecommendedQuestions(true)
            pollTimer = window.setTimeout(
              () => loadRecommendedQuestions(pollCount + 1),
              RECOMMENDED_QUESTION_POLL_MS,
            )
            return
          }

          setRecommendedQuestions(data?.questions?.slice(0, RECOMMENDED_QUESTION_DISPLAY_LIMIT) ?? [])
          setResponseMeta(data
            ? {
                source: data.source,
                cached: data.cached,
                generatedAt: data.generatedAt,
              }
            : null)
          setIsLoadingRecommendedQuestions(false)
        })
        .catch(() => {
          if (!cancelled) {
            setRecommendedQuestions([])
            setResponseMeta(null)
            setIsLoadingRecommendedQuestions(false)
          }
        })
    }

    loadRecommendedQuestions(0)

    return () => {
      cancelled = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [])

  const suggestions = useMemo(() => {
    if (isLoadingRecommendedQuestions) return []

    const seen = new Set<string>()
    return recommendedQuestions
      .map((question) => question.trim())
      .filter((question) => {
        if (!question) return false
        const key = normalizeSuggestionText(question)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, RECOMMENDED_QUESTION_DISPLAY_LIMIT)
  }, [isLoadingRecommendedQuestions, recommendedQuestions])

  useEffect(() => {
    if (isLoadingRecommendedQuestions || suggestions.length === 0) return
    const exposureKey = JSON.stringify({
      source: responseMeta?.source ?? 'agent',
      cached: responseMeta?.cached ?? false,
      generatedAt: responseMeta?.generatedAt ?? null,
      questions: suggestions,
    })
    if (exposedKeyRef.current === exposureKey) return
    exposedKeyRef.current = exposureKey

    reportAnalyticsEvent('recommended_question_exposed', {
      entityType: 'recommended_question_batch',
      entityId: null,
      properties: {
        exposureId: createClientId('recommended-question-exposure'),
        responseSource: responseMeta?.source ?? 'agent',
        cached: responseMeta?.cached ?? false,
        generatedAt: responseMeta?.generatedAt ?? null,
        count: suggestions.length,
        questions: suggestions.map((question, index) => ({ question, rank: index + 1 })),
      },
    })
  }, [isLoadingRecommendedQuestions, responseMeta, suggestions])

  const handleSuggestionClick = (suggestion: string, rank: number) => {
    const interaction = buildRecommendationInteraction(suggestion, rank, responseMeta)
    reportAnalyticsEvent('recommended_question_clicked', {
      dedupeKey: interaction.interactionId,
      sessionId,
      entityType: 'recommended_question',
      entityId: null,
      properties: {
        ...interaction,
        sessionId,
      },
    })
    onSuggestionClick(suggestion, interaction)
  }

  const renderSuggestionIcon = (kind: SuggestionIconKind) => {
    if (kind === 'record') {
      return (
        <svg width={24} height={24} style={styles.suggestionGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4.8h8" />
          <path d="M9 3h6l1 2.5H8L9 3Z" />
          <path d="M6 5.5h12v15H6z" />
          <path d="M9 10h4" />
          <path d="M9 14h3" />
          <path d="m15.4 16.8 1.2 1.2 2.2-2.4" />
        </svg>
      )
    }
    if (kind === 'emotion') {
      return (
        <svg width={24} height={24} style={styles.suggestionGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.2 5.6c-1.8-1.8-4.8-1.5-6.2.6L12 9l-2-2.8c-1.4-2.1-4.4-2.4-6.2-.6-2 2-1.8 5.3.4 7.2L12 20l7.8-7.2c2.2-1.9 2.4-5.2.4-7.2Z" />
        </svg>
      )
    }
    if (kind === 'care') {
      return (
        <svg width={24} height={24} style={styles.suggestionGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 5 6v5.2c0 4.1 2.8 7.8 7 9.8 4.2-2 7-5.7 7-9.8V6l-7-3Z" />
          <path d="M12 8v7" />
          <path d="M8.5 11.5h7" />
        </svg>
      )
    }
    return (
      <svg width={24} height={24} style={styles.suggestionGlyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 14.8a4.5 4.5 0 1 0 4 0V5a2 2 0 1 0-4 0v9.8Z" />
        <path d="M12 5v8" />
        <path d="M9 20h6" />
        <path d="M17.7 10.4c.9.8 1.5 2 1.5 3.3" />
        <path d="M20.2 8c1.3 1.4 2 3.2 2 5.1" />
      </svg>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.backgroundAura} aria-hidden="true">
        <span style={styles.waveLeft} />
        <span style={styles.waveRight} />
        <span style={styles.flower} />
      </div>

      <AppInstallCtaBanner />

      <div style={styles.hero}>
        <img
          src={cxLogoUrl}
          alt="演示助手"
          width={324}
          height={470}
          style={styles.avatarImage}
          draggable={false}
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </div>

      <h2 style={styles.title}>你好，我是<span style={styles.titleAccent}>演示</span>助手</h2>
      <div style={styles.heartRule} aria-hidden="true">
        <span style={styles.ruleLine} />
        <span style={styles.heart}>♥</span>
        <span style={styles.ruleLine} />
      </div>
      <p style={styles.desc}>
        用于学习 Agent 架构的技术演示。
        <br />
        请使用合成数据体验。
      </p>
      <p style={styles.greeting}><span style={styles.greetingMark} />有想问的，我们慢慢聊。</p>
      <div style={styles.suggestions}>
        {isLoadingRecommendedQuestions
          ? Array.from({ length: RECOMMENDED_QUESTION_DISPLAY_LIMIT }, (_, i) => (
              <div
                key={`recommended-question-loading-${i}`}
                aria-hidden="true"
                style={{ ...styles.suggestionSkeleton, animationDelay: `${i * 0.08}s` }}
              />
            ))
          : suggestions.map((suggestion, i) => (
              <button
                key={`${suggestion}-${i}`}
                style={{ ...styles.suggestionCard, animationDelay: `${i * 0.08}s` }}
                onClick={() => handleSuggestionClick(suggestion, i + 1)}
              >
                <span style={styles.suggestionIcon} aria-hidden="true">
                  {renderSuggestionIcon(resolveSuggestionIconKind(suggestion))}
                </span>
                <span style={styles.suggestionText}>{suggestion}</span>
                <svg style={styles.suggestionArrow} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            ))}
      </div>

    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 'var(--chat-welcome-padding, 74px 26px 24px)',
    textAlign: 'center',
    animation: 'fadeIn 0.4s ease',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    WebkitOverflowScrolling: 'touch',
    height: '100%',
    minHeight: 0,
  },
  marketingBannerShell: {
    position: 'relative',
    zIndex: 2,
    width: '100%',
    maxWidth: 'var(--chat-welcome-content-width, 360px)',
    margin: '0 0 24px',
  },
  marketingBannerViewport: {
    position: 'relative',
    width: '100%',
    aspectRatio: '1280 / 440',
    minHeight: 118,
    borderRadius: 28,
    overflow: 'hidden',
    boxShadow: '0 8px 20px rgba(232, 122, 93, 0.08)',
    background: '#FFF4ED',
  },
  marketingBannerIndicators: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  marketingBannerIndicatorDot: {
    width: 6,
    height: 6,
    padding: 0,
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(140, 122, 107, 0.28)',
    cursor: 'pointer',
  },
  marketingBannerIndicatorDotActive: {
    width: 16,
    borderRadius: 999,
    background: '#E87A5D',
  },
  appInstallCard: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '100%',
    margin: 0,
    padding: '14px 18px',
    borderRadius: 28,
    border: '1px solid #EFE5D7',
    background: 'linear-gradient(115deg, #F8F0E6 0%, #F6E5D2 100%)',
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
  },
  privateWechatCard: {
    position: 'relative',
    width: '100%',
    height: '100%',
    margin: 0,
    borderRadius: 28,
    border: '1px solid #F5DED0',
    background: '#FFF4ED',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  privateWechatBannerImage: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  privateWechatLandingImage: {
    display: 'block',
    width: '100%',
    maxHeight: 'min(68vh, 620px)',
    objectFit: 'contain',
    marginTop: 16,
    borderRadius: 18,
    border: '1px solid #F1E5DA',
    background: '#FFF7F0',
  },
  appInstallGlow: {
    position: 'absolute',
    right: -40,
    bottom: -48,
    width: 170,
    height: 170,
    borderRadius: '50%',
    background: 'rgba(232, 122, 93, 0.07)',
    filter: 'blur(20px)',
    pointerEvents: 'none',
  },
  appInstallClose: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 3,
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(0, 0, 0, 0.05)',
    color: '#8C7A6B',
    fontSize: 20,
    lineHeight: '24px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appInstallCopy: {
    position: 'relative',
    zIndex: 2,
    maxWidth: '66%',
  },
  appInstallEyebrow: {
    margin: '0 0 4px',
    fontSize: 11,
    fontWeight: 600,
    color: '#8C7A6B',
    letterSpacing: 0.4,
  },
  appInstallTitle: {
    margin: '0 0 5px',
    color: '#3D2E24',
    fontSize: 17,
    fontWeight: 800,
    lineHeight: 1.25,
  },
  appInstallTitleAccent: {
    color: '#E87A5D',
  },
  appInstallDesc: {
    margin: 0,
    color: '#8C7A6B',
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.45,
  },
  appInstallButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 9,
    padding: '7px 13px',
    borderRadius: 999,
    background: '#E87A5D',
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 800,
    boxShadow: '0 8px 16px rgba(232, 122, 93, 0.20)',
  },
  appInstallPhoneWrap: {
    position: 'absolute',
    right: 10,
    bottom: '-14px',
    zIndex: 1,
    width: 104,
    height: 122,
    transform: 'rotate(-5deg)',
  },
  appInstallPhone: {
    position: 'absolute',
    right: 12,
    bottom: 0,
    width: 58,
    height: 104,
    borderRadius: 13,
    border: '3px solid #FFFFFF',
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FFF6F1 100%)',
    boxShadow: '0 10px 15px rgba(0,0,0,0.15)',
  },
  phoneSpeaker: {
    position: 'absolute',
    top: 6,
    left: '50%',
    width: 18,
    height: 3,
    borderRadius: 99,
    background: '#E7D9CF',
    transform: 'translateX(-50%)',
  },
  phoneCardLineWide: {
    position: 'absolute',
    left: 9,
    top: 20,
    width: 38,
    height: 18,
    borderRadius: 7,
    background: '#FFE7DC',
  },
  phoneCardLine: {
    position: 'absolute',
    left: 9,
    top: 45,
    width: 30,
    height: 5,
    borderRadius: 99,
    background: '#E9DCD3',
  },
  phonePillOne: {
    position: 'absolute',
    left: 9,
    top: 58,
    width: 40,
    height: 8,
    borderRadius: 99,
    background: '#F6B096',
  },
  phonePillTwo: {
    position: 'absolute',
    left: 9,
    top: 72,
    width: 31,
    height: 8,
    borderRadius: 99,
    background: '#FFE1D5',
  },
  phoneBottomDot: {
    position: 'absolute',
    left: '50%',
    bottom: 7,
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: '#E7D9CF',
    transform: 'translateX(-50%)',
  },
  appInstallBadge: {
    position: 'absolute',
    left: -6,
    top: 34,
    padding: '3px 7px',
    borderRadius: 7,
    background: '#FF9E79',
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: 800,
    boxShadow: '0 5px 10px rgba(255, 119, 79, 0.18)',
    transform: 'rotate(-12deg)',
    whiteSpace: 'nowrap',
  },
  installDialogBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '0 16px calc(var(--input-bar-height, 80px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)) + 18px + env(safe-area-inset-bottom))',
    background: 'rgba(0, 0, 0, 0.42)',
  },
  installDialog: {
    position: 'relative',
    width: '100%',
    maxWidth: 390,
    borderRadius: 24,
    padding: '26px 22px 22px',
    background: '#FFFDFB',
    border: '1px solid rgba(255, 255, 255, 0.86)',
    boxShadow: '0 24px 60px rgba(57, 42, 32, 0.22)',
    textAlign: 'center',
    animation: 'fadeIn 0.18s ease both',
  },
  installDialogClose: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: '#F4EEE8',
    color: '#8C7A6B',
    fontSize: 22,
    lineHeight: '28px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  installDialogIcon: {
    width: 58,
    height: 58,
    margin: '0 auto 14px',
    borderRadius: '50%',
    background: 'linear-gradient(145deg, #FFF0E8, #FFE1D4)',
    color: '#E87A5D',
    fontSize: 24,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    letterSpacing: 2,
  },
  installDialogTitle: {
    margin: '0 0 10px',
    color: '#3D2E24',
    fontSize: 18,
    fontWeight: 800,
  },
  installDialogText: {
    margin: 0,
    color: '#6E6057',
    fontSize: 14,
    lineHeight: 1.65,
  },
  platformActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginTop: 18,
  },
  platformButton: {
    width: '100%',
    minHeight: 48,
    border: '1px solid #EFE5D7',
    borderRadius: 16,
    background: '#FAF6F0',
    color: '#3D2E24',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  wechatDownloadButton: {
    width: '100%',
    minHeight: 46,
    marginTop: 18,
    border: 'none',
    borderRadius: 999,
    background: '#E87A5D',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 8px 16px rgba(232, 122, 93, 0.20)',
  },
  platformEmoji: {
    fontSize: 20,
    lineHeight: 1,
  },
  backgroundAura: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  },
  waveLeft: {
    position: 'absolute',
    left: -84,
    top: 206,
    width: 250,
    height: 136,
    borderRadius: '48% 52% 45% 55%',
    background: 'linear-gradient(135deg, rgba(255, 113, 43, 0.13), rgba(255, 182, 122, 0.03))',
    transform: 'rotate(-12deg)',
  },
  waveRight: {
    position: 'absolute',
    right: -80,
    top: 96,
    width: 250,
    height: 220,
    borderRadius: '52% 48% 55% 45%',
    background: 'radial-gradient(circle at 50% 45%, rgba(255, 116, 42, 0.12), rgba(255, 218, 190, 0.02) 68%)',
    transform: 'rotate(8deg)',
  },
  flower: {
    position: 'absolute',
    right: 34,
    top: 315,
    width: 116,
    height: 96,
    opacity: 0.38,
    background:
      'radial-gradient(ellipse at 48% 70%, rgba(255, 130, 68, 0.16) 0 24%, transparent 25%), radial-gradient(ellipse at 32% 52%, rgba(255, 130, 68, 0.13) 0 26%, transparent 27%), radial-gradient(ellipse at 60% 46%, rgba(255, 130, 68, 0.12) 0 26%, transparent 27%), radial-gradient(ellipse at 74% 60%, rgba(255, 130, 68, 0.11) 0 24%, transparent 25%)',
    filter: 'blur(0.2px)',
  },
  hero: {
    position: 'relative',
    zIndex: 1,
    width: 'var(--chat-welcome-hero-width, 206px)',
    height: 'var(--chat-welcome-hero-height, 238px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 'var(--chat-welcome-hero-margin-bottom, 24px)',
  },
  avatarImage: {
    width: 'var(--chat-welcome-logo-width, 184px)',
    height: 'auto',
    display: 'block',
    objectFit: 'contain',
    filter: 'drop-shadow(0 16px 20px rgba(139, 70, 44, 0.10))',
    transform: 'translateY(var(--chat-welcome-logo-offset-y, 34px))',
  },
  titleAccent: {
    color: 'var(--color-brand)',
  },
  title: {
    position: 'relative',
    zIndex: 1,
    fontSize: 'var(--chat-welcome-title-size, 32px)',
    fontWeight: 800,
    color: '#24211F',
    margin: 'var(--chat-welcome-title-margin, 0 0 14px)',
    letterSpacing: 0,
    lineHeight: 1.18,
    textShadow: '0 5px 12px rgba(74, 63, 58, 0.10)',
  },
  heartRule: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 'var(--chat-welcome-rule-margin-bottom, 18px)',
  },
  ruleLine: {
    width: 38,
    height: 1,
    background: 'linear-gradient(90deg, transparent, rgba(255, 99, 35, 0.22))',
  },
  heart: {
    color: 'var(--color-brand)',
    fontSize: 17,
    lineHeight: 1,
  },
  desc: {
    position: 'relative',
    zIndex: 1,
    fontSize: 'var(--chat-welcome-desc-size, 18px)',
    color: '#3E3A36',
    lineHeight: 'var(--chat-welcome-desc-line-height, 1.72)',
    margin: 'var(--chat-welcome-desc-margin, 0 0 52px)',
    maxWidth: 330,
    fontWeight: 500,
  },
  greeting: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: 'var(--chat-welcome-content-width, 360px)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontSize: 'var(--chat-welcome-greeting-size, 20px)',
    fontWeight: 800,
    color: '#282521',
    lineHeight: 1.35,
    margin: 'var(--chat-welcome-greeting-margin, 0 0 18px)',
    textAlign: 'left',
  },
  greetingMark: {
    width: 4,
    height: 'var(--chat-welcome-greeting-mark-height, 24px)',
    borderRadius: 999,
    background: 'var(--color-brand)',
    boxShadow: '0 6px 12px rgba(255, 92, 28, 0.24)',
    flexShrink: 0,
  },
  suggestions: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--chat-welcome-suggestions-gap, 12px)',
    width: '100%',
    maxWidth: 'var(--chat-welcome-content-width, 360px)',
  },
  suggestionCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minHeight: 'var(--chat-suggestion-min-height, 70px)',
    padding: 'var(--chat-suggestion-padding, 12px 18px 12px 16px)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.86)',
    background: 'rgba(255, 255, 255, 0.92)',
    color: '#26211E',
    fontSize: 'var(--chat-suggestion-font-size, var(--font-size-chat))',
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'transform 0.2s, box-shadow 0.2s, background 0.2s',
    width: '100%',
    lineHeight: 1.4,
    boxShadow: '0 14px 32px rgba(124, 83, 58, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.72)',
    animation: 'fadeIn 0.4s ease both',
  },
  suggestionIcon: {
    flexShrink: 0,
    width: 'var(--chat-suggestion-icon-size, 44px)',
    height: 'var(--chat-suggestion-icon-size, 44px)',
    borderRadius: '50%',
    background: 'linear-gradient(145deg, rgba(255, 239, 229, 0.96), rgba(255, 247, 241, 0.88))',
    color: 'var(--color-brand)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92)',
  },
  suggestionGlyph: {
    width: 'var(--chat-suggestion-glyph-size, 27px)',
    height: 'var(--chat-suggestion-glyph-size, 27px)',
    display: 'block',
    flexShrink: 0,
  },
  suggestionText: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  suggestionArrow: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: 'var(--color-brand)',
    width: 'var(--chat-suggestion-arrow-size, 22px)',
    height: 'var(--chat-suggestion-arrow-size, 22px)',
  },
  suggestionSkeleton: {
    height: 'var(--chat-suggestion-min-height, 70px)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.82)',
    background: 'linear-gradient(90deg, rgba(255,255,255,0.62) 0%, rgba(255,247,241,0.92) 50%, rgba(255,255,255,0.62) 100%)',
    opacity: 0.7,
    animation: 'fadeIn 0.4s ease both',
  },
}
