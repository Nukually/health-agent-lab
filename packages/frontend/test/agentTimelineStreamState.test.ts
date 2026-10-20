import assert from 'node:assert/strict'

const storage = new Map<string, string>()
;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

const { useStore } = await import('../src/stores/index.js')

useStore.setState({
  currentSessionId: 'session-1',
  sessionStreams: {},
  messages: [],
})

useStore.getState().initStream('session-1', 'request-1', 'session-1')
useStore.getState().streamStartAnswer('session-1')
useStore.getState().streamAppendAnswerText('session-1', '我先查一下资料，再继续回答。')
useStore.getState().streamStartToolCall('session-1', {
  toolCallId: 'call-1',
  name: 'medical_literature_search',
  input: { query: '内分泌治疗 关节痛' },
})

const bucket = useStore.getState().sessionStreams['session-1']
assert.ok(bucket)
assert.equal(bucket.answerText, '')
assert.equal(bucket.processTimeline.isAnswering, false)
assert.equal(bucket.processTimeline.answerStartedAt, null)
assert.equal(bucket.processTimeline.steps[0]?.type, 'text')
assert.equal(bucket.processTimeline.steps[0]?.content, '我先查一下资料，再继续回答。')
assert.equal(bucket.processTimeline.steps[1]?.type, 'tool_call')

useStore.getState().streamStartAnswer('session-1')
useStore.getState().streamAppendAnswerText('session-1', '查完后我继续说明。')

const nextBucket = useStore.getState().sessionStreams['session-1']
assert.ok(nextBucket)
assert.equal(nextBucket.answerText, '查完后我继续说明。')

console.log('agent timeline stream state tests passed')
