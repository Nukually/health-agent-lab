/**
 * 实时 ASR 路由 —— 通过 ASRProvider 抽象对接多厂商（默认火山，可切阿里 DashScope）
 *
 *   Browser  ←WS→  Backend  ←Provider→  Upstream
 *   (PCM 16kHz)    (proxy)              (realtime ASR)
 *
 * 对前端协议保持不变：ClientASRMessage / ServerASRMessage（shared types）
 */

import { Hono } from 'hono'
import { getUpgradeWebSocket } from '../ws.js'
import { rootLogger } from '../lib/logger.js'
import { getASRProvider } from '../providers/factory.js'
import { consumeWsTicket } from '../services/ws-ticket.js'
import type { ASRSession } from '../providers/types.js'
import type { ClientASRMessage, ServerASRMessage } from '@health-agent/shared'

const MAX_SESSION_MS = 90_000

const activeConnections = new Map<string, true>()
const logger = rootLogger.child({ module: 'asr' })

function send(ws: { send: (data: string) => void }, msg: ServerASRMessage) {
  ws.send(JSON.stringify(msg))
}

export function createAsrRoutes() {
  const asrRoutes = new Hono()

  asrRoutes.get(
    '/',
    getUpgradeWebSocket()((c) => {
      const ticket = new URL(c.req.url, 'http://localhost').searchParams.get('ticket')
      let userId: string | null = null
      let session: ASRSession | null = null
      let sessionTimer: ReturnType<typeof setTimeout> | null = null
      let fullTranscript = ''
      let wsClosed = false
      let sessionOpening = true
      const pendingAudio: string[] = []
      let pendingFinish = false

      return {
        onOpen(_event, ws) {
          if (!ticket) {
            send(ws, { type: 'error', message: '缺少认证信息' })
            ws.close(4401, 'missing ticket')
            return
          }

          ;(async () => {
            try {
              const payload = await consumeWsTicket(ticket, 'asr', logger)
              if (!payload) {
                send(ws, { type: 'error', message: '认证失败' })
                ws.close(4401, 'invalid ticket')
                return
              }
              userId = payload.userId

              if (activeConnections.has(userId)) {
                send(ws, { type: 'error', message: '已有一个语音识别会话在进行中' })
                ws.close(4409, 'concurrent session')
                return
              }
              activeConnections.set(userId, true)

              sessionTimer = setTimeout(() => {
                logger.warn({ userId }, 'ASR session timeout, force closing')
                cleanup()
              }, MAX_SESSION_MS)

              const provider = getASRProvider()
              const s = await provider.openSession({ requestId: userId! })
              if (wsClosed) {
                await s.cancel()
                return
              }
              session = s
              session.onReady(() => {
                if (wsClosed) return
                send(ws, { type: 'ready' })
                logger.info({ userId, provider: provider.name }, 'ASR session ready')
                sessionOpening = false
                // flush pending
                for (const audio of pendingAudio) session!.appendAudio(audio)
                pendingAudio.length = 0
                if (pendingFinish) session!.finish()
              })
              session.onPartial((text) => {
                if (!wsClosed) send(ws, { type: 'transcript_partial', text })
              })
              session.onFinal((text) => {
                fullTranscript += text
                if (!wsClosed) send(ws, { type: 'transcript_final', text })
              })
              session.onDone((full) => {
                fullTranscript = full || fullTranscript
                if (!wsClosed) send(ws, { type: 'done', text: fullTranscript })
                logger.info({ userId, textLength: fullTranscript.length }, 'ASR session finished')
                cleanup()
              })
              session.onError((err) => {
                logger.error({ userId, err: err.message }, 'ASR provider error')
                if (!wsClosed) send(ws, { type: 'error', message: err.message || '语音识别服务异常' })
                cleanup()
              })
            } catch (err) {
              logger.error({ userId, err: (err as Error).message }, 'failed to open ASR session')
              if (!wsClosed) send(ws, { type: 'error', message: (err as Error).message || '语音识别服务连接失败' })
              cleanup()
            }
          })()
        },

        onMessage(event) {
          let msg: ClientASRMessage
          try {
            msg = JSON.parse(
              typeof event.data === 'string' ? event.data : event.data.toString(),
            )
          } catch {
            return
          }

          switch (msg.type) {
            case 'audio_append':
              if (sessionOpening) {
                pendingAudio.push(msg.audio)
              } else {
                session?.appendAudio(msg.audio)
              }
              break
            case 'session_finish':
              if (sessionOpening) {
                pendingFinish = true
              } else {
                session?.finish()
              }
              break
          }
        },

        onClose() {
          cleanup()
        },

        onError(event) {
          logger.error({ userId, error: String(event) }, 'client ws error')
        },
      }

      function cleanup() {
        wsClosed = true
        if (sessionTimer) {
          clearTimeout(sessionTimer)
          sessionTimer = null
        }
        if (session) {
          session.cancel().catch(() => { /* ignore */ })
          session = null
        }
        if (userId) activeConnections.delete(userId)
      }
    }),
  )

  return asrRoutes
}
