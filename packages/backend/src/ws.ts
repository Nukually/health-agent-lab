/**
 * WebSocket singleton — avoids circular deps between index.ts and route files.
 *
 * index.ts calls initWebSocket(app) once at startup,
 * route files call getUpgradeWebSocket() to decorate handlers.
 */

import type { Hono } from 'hono'
import { createNodeWebSocket } from '@hono/node-ws'

let _upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'] | null = null
let _injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'] | null = null

export function initWebSocket(app: Hono) {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })
  _upgradeWebSocket = upgradeWebSocket
  _injectWebSocket = injectWebSocket
}

export function getUpgradeWebSocket() {
  if (!_upgradeWebSocket) throw new Error('initWebSocket() not called')
  return _upgradeWebSocket
}

export function getInjectWebSocket() {
  if (!_injectWebSocket) throw new Error('initWebSocket() not called')
  return _injectWebSocket
}
