import { useEffect, useRef } from 'react'
import { useStore } from '../stores/index.js'
import { CHAT_FONT_SIZE_PX, type ChatFontScale } from '../stores/slices/settings.js'
import { reportAnalyticsEvent } from '../services/analytics.js'
import {
  applyStableChatFontSize,
  collectFontEnvironmentSnapshot,
  type FontEnvironmentSnapshot,
} from '../utils/fontEnvironment.js'

function round(value: number, digits = 2): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function bucket(value: number, size: number): number {
  return Math.round(value / size) * size
}

function buildDedupeKey(snapshot: FontEnvironmentSnapshot): string {
  const day = new Date().toISOString().slice(0, 10)
  const viewport = `${bucket(snapshot.viewportWidth, 10)}x${bucket(snapshot.viewportHeight, 10)}`
  const measured = round(snapshot.measuredTextScale, 2)
  const visualScale = round(snapshot.visualViewportScale ?? 1, 2)
  return [
    'font-env',
    day,
    snapshot.trigger,
    snapshot.chatFontScale,
    viewport,
    measured,
    visualScale,
  ].join(':')
}

export function useFontEnvironmentTelemetry() {
  const token = useStore((s) => s.token)
  const authEpoch = useStore((s) => s.authEpoch)
  const chatFontScale = useStore((s) => s.chatFontScale)
  const prevScaleRef = useRef<ChatFontScale | null>(null)
  const lastDedupeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const targetPx = CHAT_FONT_SIZE_PX[chatFontScale]
    applyStableChatFontSize(targetPx)

    let timer: number | null = null
    const trigger = prevScaleRef.current && prevScaleRef.current !== chatFontScale
      ? 'settings_change'
      : 'app_start'
    prevScaleRef.current = chatFontScale

    timer = window.setTimeout(() => {
      if (!token) return
      const snapshot = collectFontEnvironmentSnapshot(trigger, chatFontScale, targetPx)
      const dedupeKey = buildDedupeKey(snapshot)
      if (lastDedupeKeyRef.current === dedupeKey) return
      lastDedupeKeyRef.current = dedupeKey
      reportAnalyticsEvent('font_environment_snapshot', {
        dedupeKey,
        entityType: 'client_environment',
        properties: { ...snapshot },
      })
    }, 120)

    return () => {
      if (timer != null) window.clearTimeout(timer)
    }
  }, [authEpoch, chatFontScale, token])

  useEffect(() => {
    const targetPx = CHAT_FONT_SIZE_PX[chatFontScale]
    let timer: number | null = null

    const reapply = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        applyStableChatFontSize(targetPx)
      }, 80)
    }

    window.addEventListener('resize', reapply)
    window.addEventListener('orientationchange', reapply)
    window.addEventListener('pageshow', reapply)
    window.addEventListener('cx-font-environment-change', reapply)
    window.visualViewport?.addEventListener('resize', reapply)

    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener('resize', reapply)
      window.removeEventListener('orientationchange', reapply)
      window.removeEventListener('pageshow', reapply)
      window.removeEventListener('cx-font-environment-change', reapply)
      window.visualViewport?.removeEventListener('resize', reapply)
    }
  }, [chatFontScale])
}
