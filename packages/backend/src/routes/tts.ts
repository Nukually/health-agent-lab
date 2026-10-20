/**
 * 实时 TTS via Provider 抽象（默认火山双向流式）
 *
 *   Browser  ←WS→  Backend  ←WS→  Volcengine
 *   (text)         (proxy)        (Bidirectional TTS)
 *
 * 协议：
 *   Client → Server（JSON）：ClientTTSMessage（text_delta / text_end / cancel）
 *   Server → Client：
 *     - JSON 控制帧：ServerTTSMessage（audio_start / audio_end / error）
 *     - 二进制帧：MP3 音频片段
 *
 * 并发：一 userId 只允许一条 TTS 连接，新的覆盖旧的（与 ASR 的"拒绝新连接"不同，
 * 因为喇叭按钮点得快时应该"最新一次胜出"）。
 */

import { Hono } from 'hono'
import { getUpgradeWebSocket } from '../ws.js'
import { rootLogger } from '../lib/logger.js'
import { getTTSProvider } from '../providers/factory.js'
import { consumeWsTicket } from '../services/ws-ticket.js'
import type { TTSSession } from '../providers/types.js'
import type { ClientTTSMessage, ServerTTSMessage } from '@health-agent/shared'

const MAX_SESSION_MS = 120_000

const logger = rootLogger.child({ module: 'tts' })

// userId → 当前活跃 session 的 cleanup 函数（新连接到来时调用，挤掉旧的）
const activeSessions = new Map<string, (reason?: string) => void>()

function sendJson(ws: { send: (data: string | ArrayBuffer) => void }, msg: ServerTTSMessage) {
  ws.send(JSON.stringify(msg))
}

export function createTtsRoutes() {
  const routes = new Hono()

  routes.get(
    '/',
    getUpgradeWebSocket()((c) => {
      const ticket = new URL(c.req.url, 'http://localhost').searchParams.get('ticket')
      let userId: string | null = null
      let session: TTSSession | null = null
      let sessionTimer: ReturnType<typeof setTimeout> | null = null
      let wsClosed = false
      let sessionOpening = true
      let currentCleanup: ((reason?: string) => void) | null = null
      let textSegmentCount = 0
      let textCharCount = 0
      let audioChunkCount = 0
      let audioBytes = 0
      const pendingUpstream: ClientTTSMessage[] = []

      return {
        onOpen(_event, ws) {
          if (!ticket) {
            sendJson(ws, { type: 'error', message: '缺少认证信息' })
            ws.close(4401, 'missing ticket')
            return
          }

          const cleanup = (reason = 'cleanup') => {
            if (sessionTimer) {
              clearTimeout(sessionTimer)
              sessionTimer = null
            }
            if (session) {
              session.cancel().catch(() => { /* ignore */ })
              session = null
            }
            if (userId && activeSessions.get(userId) === cleanup) {
              activeSessions.delete(userId)
            }
            if (!wsClosed) {
              try {
                ws.close()
              } catch {
                // already closed
              }
            }
            logger.info(
              { userId, reason, textSegmentCount, textCharCount, audioChunkCount, audioBytes },
              'TTS session cleanup',
            )
          }
          currentCleanup = cleanup

          ;(async () => {
            try {
              const payload = await consumeWsTicket(ticket, 'tts', logger)
              if (!payload) {
                sendJson(ws, { type: 'error', message: '认证失败' })
                ws.close(4401, 'invalid ticket')
                return
              }
              userId = payload.userId

              // "最新一次胜出"：新连接到来时挤掉同一用户的旧 session
              const prev = activeSessions.get(userId)
              if (prev) {
                try {
                  prev('superseded')
                } catch {
                  // ignore
                }
              }

              activeSessions.set(userId, cleanup)

              sessionTimer = setTimeout(() => {
                logger.warn({ userId }, 'TTS session timeout')
                cleanup('timeout')
              }, MAX_SESSION_MS)

              const provider = getTTSProvider()
              const s = await provider.openSession({ requestId: userId! })
              if (wsClosed) {
                await s.cancel()
                return
              }
              session = s
              session.onAudio((chunk) => {
                if (wsClosed) return
                try {
                  const audio = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                  audioChunkCount += 1
                  audioBytes += chunk.byteLength
                  ws.send(audio)
                } catch (err) {
                  logger.error({ err: (err as Error).message }, 'failed to forward audio chunk')
                }
              })
              session.onEnd(() => {
                if (wsClosed) return
                logger.info(
                  { userId, textSegmentCount, textCharCount, audioChunkCount, audioBytes },
                  'TTS upstream ended',
                )
                sendJson(ws, { type: 'audio_end' })
                cleanup('upstream_end')
              })
              session.onError((err) => {
                logger.error({ userId, err: err.message }, 'TTS upstream error')
                if (!wsClosed) sendJson(ws, { type: 'error', message: err.message || '语音合成服务异常' })
                cleanup('upstream_error')
              })

              if (!wsClosed) sendJson(ws, { type: 'audio_start', format: 'mp3', sampleRate: 24000 })

              sessionOpening = false
              // flush pending
              while (pendingUpstream.length) {
                const m = pendingUpstream.shift()!
                handleClientMessage(m)
              }
            } catch (err) {
              logger.error({ userId, err: (err as Error).message }, 'failed to open TTS session')
              if (!wsClosed) sendJson(ws, { type: 'error', message: (err as Error).message || '语音合成服务连接失败' })
              cleanup()
            }
          })()

          function handleClientMessage(msg: ClientTTSMessage) {
            if (!session) return
            switch (msg.type) {
              case 'text_delta':
                if (msg.text) {
                  textSegmentCount += 1
                  textCharCount += msg.text.length
                  session.sendText(msg.text)
                }
                break
              case 'text_end':
                session.finish()
                break
              case 'cancel':
                cleanup('client_cancel')
                break
            }
          }

          // 把 handler 挂到 closure 上，onMessage 里用
          ;(ws as unknown as { __handle: (m: ClientTTSMessage) => void }).__handle = handleClientMessage
        },

        onMessage(event, ws) {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString()
          let msg: ClientTTSMessage
          try {
            msg = JSON.parse(raw)
          } catch {
            return
          }
          if (sessionOpening) {
            pendingUpstream.push(msg)
            return
          }
          const handler = (ws as unknown as { __handle?: (m: ClientTTSMessage) => void }).__handle
          handler?.(msg)
        },

        onClose() {
          wsClosed = true
          logger.info(
            { userId, textSegmentCount, textCharCount, audioChunkCount, audioBytes },
            'TTS client websocket closed',
          )
          if (session) {
            session.cancel().catch(() => { /* ignore */ })
            session = null
          }
          if (sessionTimer) {
            clearTimeout(sessionTimer)
            sessionTimer = null
          }
          if (userId) {
            // 只在仍归属当前 closure 时清理，避免抹掉挤占者
            if (currentCleanup && activeSessions.get(userId) === currentCleanup) {
              activeSessions.delete(userId)
            }
          }
        },

        onError(event) {
          logger.error({ userId, error: String(event) }, 'client ws error')
        },
      }
    }),
  )

  return routes
}
