import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('chat send does not clear homepage recommendation cache after saving a normal user message', () => {
  const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
  const saveMessageIndex = source.indexOf('const userMessageDbId = await saveMessage(sessionId, userMessage, logger)')
  assert.notEqual(saveMessageIndex, -1)

  const nextStepIndex = source.indexOf('if (shouldGenerateTitleFromUserMessage)', saveMessageIndex)
  assert.notEqual(nextStepIndex, -1)

  const afterSaveBlock = source.slice(saveMessageIndex, nextStepIndex)
  assert.doesNotMatch(afterSaveBlock, /clearRecommendedQuestionAgentCacheForUser/)
})
