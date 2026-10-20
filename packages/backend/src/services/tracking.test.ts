import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTrackingEventContract } from '@health-agent/shared'
import { backendTrackingEventFromAnalyticsInput, trackingRequestContextFromHeaders } from './tracking.js'
import { sanitizeTrackingObject } from './tracking-sanitizer.js'

test('sanitizeTrackingObject removes sensitive tracking fields', () => {
  const result = sanitizeTrackingObject({
    token: 'secret',
    accessToken: 'secret',
    registrationId: 'full-registration-id',
    pageUrl: 'https://example.test/path?token=secret',
    phoneNumber: '13800138000',
    latitude: 31.2,
    safeStatus: 'ok',
    nested: { prompt: 'medical text', step: 'ready' },
  })

  assert.deepEqual(result, {
    safeStatus: 'ok',
    nested: { step: 'ready' },
  })
})

test('backendTrackingEventFromAnalyticsInput creates a server tracking event', () => {
  const result = backendTrackingEventFromAnalyticsInput({
    userId: '6d90f809-7f35-46a8-a3f0-11b122f27db7',
    eventName: 'chat_request_completed',
    dedupeKey: 'req-1',
    sessionId: 'f3e558f2-88b5-4db3-91f1-6b8b6cc9df4f',
    entityType: 'api_route',
    entityId: '/api/chat/stream',
    endedAt: new Date('2026-05-26T10:00:00.000Z'),
    durationMs: 120,
    properties: {
      route: '/chat',
      status: 200,
      authorization: 'Bearer secret',
    },
  }, { requestId: 'req-1' })

  assert.equal(result.eventId, 'bt_6d90f809-7f35-46a8-a3f0-11b122f27db7_chat_request_completed_req-1')
  assert.equal(result.source, 'backend')
  assert.equal(result.platform, 'server')
  assert.equal(result.userId, '6d90f809-7f35-46a8-a3f0-11b122f27db7')
  assert.equal(result.requestId, 'req-1')
  assert.equal(result.chatSessionId, 'f3e558f2-88b5-4db3-91f1-6b8b6cc9df4f')
  assert.equal(result.eventTime, '2026-05-26T10:00:00.000Z')
  assert.deepEqual(result.properties, {
    route: '/chat',
    status: 200,
    durationMs: 120,
    backendDedupeKey: 'req-1',
  })
})

test('trackingRequestContextFromHeaders extracts shared session and trace headers', () => {
  const result = trackingRequestContextFromHeaders((name) => ({
    'x-install-id': ' install-1 ',
    'x-app-session-id': ' app-session-1 ',
    'x-web-session-id': ' web-session-1 ',
    'x-tracking-trace-id': ' 4bf92f3577b34da6a3ce929d0e0e4736 ',
  })[name], ' request-1 ')

  assert.deepEqual(result, {
    installId: 'install-1',
    appSessionId: 'app-session-1',
    webSessionId: 'web-session-1',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    requestId: 'request-1',
  })
})

test('trackingRequestContextFromHeaders extracts W3C trace id from traceparent', () => {
  const result = trackingRequestContextFromHeaders((name) => ({
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  })[name], 'request-1')

  assert.equal(result.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('trackingRequestContextFromHeaders prefers standard traceparent over legacy trace header', () => {
  const result = trackingRequestContextFromHeaders((name) => ({
    'x-tracking-trace-id': 'tr_legacy',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  })[name], 'request-1')

  assert.equal(result.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('backendTrackingEventFromAnalyticsInput propagates request tracking context', () => {
  const result = backendTrackingEventFromAnalyticsInput({
    userId: '6d90f809-7f35-46a8-a3f0-11b122f27db7',
    eventName: 'communication_card_save_clicked',
    dedupeKey: 'card-1',
    sessionId: 'f3e558f2-88b5-4db3-91f1-6b8b6cc9df4f',
    entityType: 'communication_card',
    entityId: 'card-1',
  }, {
    installId: 'install-1',
    appSessionId: 'app-session-1',
    webSessionId: 'web-session-1',
    traceId: 'trace-1',
    requestId: 'request-1',
  })

  assert.equal(result.installId, 'install-1')
  assert.equal(result.appSessionId, 'app-session-1')
  assert.equal(result.webSessionId, 'web-session-1')
  assert.equal(result.traceId, 'trace-1')
  assert.equal(result.requestId, 'request-1')
})

test('validateTrackingEventContract reports warning-only contract gaps', () => {
  const warnings = validateTrackingEventContract({
    eventId: 'evt_1',
    eventName: 'page_view',
    eventVersion: '1.0',
    eventTime: '2026-05-26T10:00:00.000Z',
    source: 'backend',
    platform: 'server',
  })

  assert.deepEqual(warnings, [
    'source backend is not allowed for page_view',
    'missing required field webSessionId',
    'missing required field route',
  ])
})
