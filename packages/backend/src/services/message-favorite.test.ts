import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMessageFavoritePreview,
  extractFavoriteUserQuestionSnapshot,
} from './message-favorite.js'
import { selectFocusedMessageWindow } from './message.js'

test('favorite preview strips answer protocol tags and collapses whitespace', () => {
  const preview = buildMessageFavoritePreview('<final_answer>\n  补好了，\n\n可以继续记录疼痛程度。  </final_answer>', 18)
  assert.equal(preview, '补好了，可以继续记录疼痛程度。')
})

test('favorite preview is capped with an ellipsis when content is long', () => {
  const preview = buildMessageFavoritePreview('今天可以先记录一下乳房感觉和休息情况。'.repeat(4), 20)
  assert.equal(preview, '今天可以先记录一下乳房感觉和休息情况。…')
})

test('favorite user question snapshot reads text from stored multimodal content', () => {
  const snapshot = extractFavoriteUserQuestionSnapshot('[{"type":"text","text":"<system-reminder>\\nignore\\n</system-reminder>\\n\\n今天乳房隐痛怎么办？"},{"type":"image_url","image_url":{"url":"oss://x"}}]')
  assert.equal(snapshot, '今天乳房隐痛怎么办？')
})

test('focused message window keeps target centered when enough rows exist', () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    id: `m${index + 1}`,
    createdAt: new Date(`2026-06-02T08:0${index}:00.000Z`),
  }))

  const result = selectFocusedMessageWindow(rows, 'm5', 5)

  assert.deepEqual(result.rows.map((row) => row.id), ['m3', 'm4', 'm5', 'm6', 'm7'])
  assert.equal(result.hasMoreBefore, true)
  assert.equal(result.hasMoreAfter, true)
  assert.equal(result.oldestCreatedAt, '2026-06-02T08:02:00.000Z')
})

test('focused message window fills from the available side near edges', () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    id: `m${index + 1}`,
    createdAt: new Date(`2026-06-02T08:0${index}:00.000Z`),
  }))

  const result = selectFocusedMessageWindow(rows, 'm2', 5)

  assert.deepEqual(result.rows.map((row) => row.id), ['m1', 'm2', 'm3', 'm4', 'm5'])
  assert.equal(result.hasMoreBefore, false)
  assert.equal(result.hasMoreAfter, true)
  assert.equal(result.oldestCreatedAt, '2026-06-02T08:00:00.000Z')
})
