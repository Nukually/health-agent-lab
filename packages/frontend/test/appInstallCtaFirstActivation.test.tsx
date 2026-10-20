import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as typeof globalThis & { React?: typeof React }).React = React

const storage = new Map<string, string>()
;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

const { default: MessageList } = await import('../src/components/chat/MessageList.js')

const html = renderToStaticMarkup(
  <MessageList
    messages={[]}
    isStreaming={false}
    isCompacting={false}
    processTimeline={[]}
    answerText=""
    streamingToolCalls={undefined}
    responseStartTime={null}
    onSuggestionClick={() => undefined}
    sessionId={null}
    feedbackMap={{}}
    processDurationMap={{}}
    onRequireHealthProfileConsent={() => undefined}
    firstActivationWelcome={{ content: '你好，我是演示助手', streaming: false }}
  />,
)

assert.doesNotMatch(html, /立即前往 App/)
assert.match(html, /你好，我是演示助手/)

console.log('app install CTA first activation tests passed')
