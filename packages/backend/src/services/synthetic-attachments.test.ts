import assert from 'node:assert/strict'
import test from 'node:test'
import { SYNTHETIC_TOOL_ATTACHMENT_MARKER } from '../utils/repeated-user-message.js'
import { pruneSyntheticMedicalDocumentAttachmentContent } from './synthetic-attachments.js'

function syntheticContent() {
  const meta = JSON.stringify({
    docs: [
      { docId: 'doc-1', shortId: 'd-1', title: '超声报告', imageCount: 2 },
      { docId: 'doc-2', shortId: 'd-2', title: '病理报告', imageCount: 1 },
    ],
    communicationCards: [
      { cardId: 'card-1', shortId: 'c-1', title: '复诊沟通卡' },
    ],
  })
  return JSON.stringify([
    {
      type: 'text',
      text: `<system-reminder>\n${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n旧来源说明\n<tool-attachment-meta>${meta}</tool-attachment-meta>\n\n用户的原问题是：\n帮我对比报告\n</system-reminder>`,
    },
    { type: 'image_url', image_url: { url: 'image-a' } },
    { type: 'image_url', image_url: { url: 'image-b' } },
    { type: 'image_url', image_url: { url: 'image-c' } },
  ])
}

test('prunes one image from synthetic medical document attachment context', () => {
  const result = pruneSyntheticMedicalDocumentAttachmentContent(
    syntheticContent(),
    { docId: 'doc-1', imageIndex: 1 },
  )

  if (!result.changed) assert.fail('expected synthetic context to change')
  assert.equal(result.removeMessage, false)
  assert.equal(result.removedImageCount, 1)
  assert.ok(result.content)

  const blocks = JSON.parse(result.content!)
  assert.deepEqual(
    blocks.filter((block: any) => block.type === 'image_url').map((block: any) => block.image_url.url),
    ['image-a', 'image-c'],
  )
  const text = blocks[0].text as string
  assert.match(text, /以下 2 张图片来自 saved_content/)
  assert.match(text, /"docId":"doc-1".*"imageCount":1/)
  assert.match(text, /"docId":"doc-2".*"imageCount":1/)
  assert.match(text, /用户的原问题是：\n帮我对比报告/)
})

test('removes synthetic message when the deleted document was its only attachment', () => {
  const meta = JSON.stringify({
    docs: [{ docId: 'doc-1', shortId: 'd-1', title: '超声报告', imageCount: 1 }],
    communicationCards: [],
  })
  const content = JSON.stringify([
    {
      type: 'text',
      text: `<system-reminder>\n${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n<tool-attachment-meta>${meta}</tool-attachment-meta>\n\n请结合这些资料回答用户上一条问题。\n</system-reminder>`,
    },
    { type: 'image_url', image_url: { url: 'image-a' } },
  ])

  const result = pruneSyntheticMedicalDocumentAttachmentContent(content, { docId: 'doc-1' })

  if (!result.changed) assert.fail('expected synthetic context to change')
  assert.equal(result.removeMessage, true)
  assert.equal(result.removedImageCount, 1)
})
