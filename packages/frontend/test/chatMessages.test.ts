import assert from 'node:assert/strict'
import type { MessageRecord } from '@health-agent/shared'
import {
  appendOrReplaceInterruptedAssistantMessage,
  mergeLatestSessionMessages,
} from '../src/utils/chatMessages.js'

function message(
  id: string,
  role: MessageRecord['role'],
  content: string,
  createdAt: string,
  images?: string[],
): MessageRecord {
  return {
    id,
    role,
    content,
    images,
    thinking: null,
    toolCalls: null,
    createdAt,
  }
}

function interruptedAssistant(
  id: string,
  content: string,
  createdAt: string,
): MessageRecord {
  return {
    ...message(id, 'assistant', content, createdAt),
    interrupted: true,
  }
}

const optimisticUser = message(
  'local-user',
  'user',
  '今天有点恶心',
  '2026-05-09T10:00:00.000Z',
)
const serverUser = message(
  'server-user',
  'user',
  '今天有点恶心',
  '2026-05-09T10:00:02.000Z',
)
const assistant = message(
  'assistant-1',
  'assistant',
  '先少量多餐。',
  '2026-05-09T10:00:08.000Z',
)

{
  const merged = mergeLatestSessionMessages(
    [optimisticUser, assistant],
    [serverUser, assistant],
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'server-user')
  assert.equal(merged[1].id, 'assistant-1')
}

{
  const current = [
    message('local-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z', ['a.jpg']),
  ]
  const latest = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:01.000Z', ['a.jpg']),
  ]
  const merged = mergeLatestSessionMessages(current, latest)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'server-user')
  assert.deepEqual(merged[0].images, ['a.jpg'])
}

{
  const current = [optimisticUser]
  const differentServerUser = message(
    'server-user',
    'user',
    '今天有点头痛',
    '2026-05-09T10:00:02.000Z',
  )
  const merged = mergeLatestSessionMessages(current, [differentServerUser])

  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'local-user')
  assert.equal(merged[1].id, 'server-user')
}

{
  const current = [optimisticUser]
  const serverAssistant = message(
    'server-assistant',
    'assistant',
    '收到。',
    '2026-05-09T10:00:02.000Z',
  )
  const merged = mergeLatestSessionMessages(current, [serverAssistant])

  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'local-user')
  assert.equal(merged[1].id, 'server-assistant')
}

{
  const current = [
    message('assistant-1', 'assistant', '旧回答', '2026-05-09T10:00:00.000Z'),
  ]
  const latest = [
    message('assistant-1', 'assistant', '新回答', '2026-05-09T10:00:00.000Z'),
  ]
  const merged = mergeLatestSessionMessages(current, latest)

  assert.equal(merged.length, 1)
  assert.equal(merged[0].content, '新回答')
}

{
  const current = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    message('assistant-1', 'assistant', '先少量多餐。', '2026-05-09T10:00:08.000Z'),
  ]
  const latest = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    message('assistant-1', 'assistant', '先少量多餐。', '2026-05-09T10:00:08.000Z'),
  ]
  const merged = mergeLatestSessionMessages(current, latest)

  assert.equal(merged, current)
}

{
  const current = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    interruptedAssistant(
      'local-interrupted-assistant',
      '可以先少量多餐，避免油腻食物',
      '2026-05-09T10:00:08.000Z',
    ),
  ]
  const latest = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    interruptedAssistant(
      'server-interrupted-assistant',
      '可以先少量多餐，避免油腻食物。',
      '2026-05-09T10:00:10.000Z',
    ),
  ]
  const merged = mergeLatestSessionMessages(current, latest)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 'server-user')
  assert.equal(merged[1].id, 'server-interrupted-assistant')
  assert.equal(merged[1].interrupted, true)
}

{
  const current = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    interruptedAssistant(
      'local-interrupted-assistant',
      '可以先少量多餐',
      '2026-05-09T10:00:08.000Z',
    ),
  ]
  const latest = [
    message('server-user', 'user', '今天有点恶心', '2026-05-09T10:00:00.000Z'),
    message(
      'server-assistant-final',
      'assistant',
      '可以先少量多餐，并观察症状。',
      '2026-05-09T10:00:10.000Z',
    ),
  ]
  const merged = mergeLatestSessionMessages(current, latest)

  assert.equal(merged.length, 3)
  assert.equal(merged[1].id, 'local-interrupted-assistant')
  assert.equal(merged[2].id, 'server-assistant-final')
}

{
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:00:08.000Z'),
    thinking: '思考中...\n\n正在分析',
    interrupted: true,
  }
  const serverInterrupted = {
    ...message('server-assistant', 'assistant', '', '2026-05-09T10:00:10.000Z'),
    thinking: '思考中...   正在分析',
    interrupted: true,
  }
  const merged = mergeLatestSessionMessages(
    [serverUser, localInterrupted],
    [serverUser, serverInterrupted],
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[1].id, 'server-assistant')
  assert.equal(merged[1].thinking, '思考中...   正在分析')
}

{
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:00:08.000Z'),
    thinking: '思考中',
    interrupted: true,
  }
  const serverInterrupted = {
    ...message('server-assistant', 'assistant', '', '2026-05-09T10:00:10.000Z'),
    thinking: '思考中，正在分析停止前的上下文',
    interrupted: true,
  }
  const merged = mergeLatestSessionMessages(
    [serverUser, localInterrupted],
    [serverUser, serverInterrupted],
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[1].id, 'server-assistant')
  assert.equal(merged[1].thinking, '思考中，正在分析停止前的上下文')
}

{
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:00:08.000Z'),
    thinking: '思考中',
    interrupted: true,
  }
  const serverInterrupted = {
    ...message('server-assistant', 'assistant', '已经收到。', '2026-05-09T10:00:10.000Z'),
    thinking: '思考中，正在组织回答',
    interrupted: true,
  }
  const merged = mergeLatestSessionMessages(
    [serverUser, localInterrupted],
    [serverUser, serverInterrupted],
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[1].id, 'server-assistant')
  assert.equal(merged[1].content, '已经收到。')
  assert.equal(merged[1].thinking, '思考中，正在组织回答')
}

{
  const firstUser = message(
    'server-user-1',
    'user',
    '今天有点恶心',
    '2026-05-09T10:00:00.000Z',
  )
  const secondUser = message(
    'server-user-2',
    'user',
    '再问一个问题',
    '2026-05-09T10:01:00.000Z',
  )
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:01:08.000Z'),
    thinking: '思考中',
    interrupted: true,
  }
  const serverInterrupted = {
    ...message('server-assistant', 'assistant', '', '2026-05-09T10:00:10.000Z'),
    thinking: '思考中，正在分析停止前的上下文',
    interrupted: true,
  }
  const merged = mergeLatestSessionMessages(
    [firstUser, secondUser, localInterrupted],
    [firstUser, serverInterrupted, secondUser],
  )

  assert.equal(merged.length, 4)
  assert.equal(merged[1].id, 'server-user-2')
  assert.equal(merged[2].id, 'local-assistant')
  assert.equal(merged[3].id, 'server-assistant')
}

{
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:00:08.000Z'),
    thinking: '第一轮思考',
    interrupted: true,
  }
  const differentInterrupted = {
    ...message('server-assistant', 'assistant', '', '2026-05-09T10:00:10.000Z'),
    thinking: '第二轮思考',
    interrupted: true,
  }
  const merged = mergeLatestSessionMessages(
    [serverUser, localInterrupted],
    [serverUser, differentInterrupted],
  )

  assert.equal(merged.length, 3)
  assert.equal(merged[1].id, 'local-assistant')
  assert.equal(merged[2].id, 'server-assistant')
}

{
  const localInterrupted = {
    ...message('local-assistant', 'assistant', '', '2026-05-09T10:00:08.000Z'),
    thinking: '思考中',
    interrupted: true,
  }
  const serverInterrupted = {
    ...message('server-assistant', 'assistant', '', '2026-05-09T10:00:10.000Z'),
    thinking: '思考中，正在分析停止前的上下文',
    interrupted: true,
  }
  const merged = appendOrReplaceInterruptedAssistantMessage(
    [serverUser, localInterrupted],
    serverInterrupted,
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[1].id, 'server-assistant')
}

console.log('chatMessages tests passed')
