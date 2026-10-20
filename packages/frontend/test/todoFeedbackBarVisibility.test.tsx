import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
}

const { default: TodoFeedbackBar } = await import('../src/components/chat/TodoFeedbackBar.js')

test('TodoFeedbackBar renders practice feedback without a scheduled message when visible', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoFeedbackBar, {
      visible: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      todoContext: {
        planId: 'plan-1',
        todoId: 'todo-1',
        feedback: null,
        status: 'pending',
      },
    }),
  )

  assert.match(html, /先休息一下，现在感觉怎么样/)
  assert.match(html, /好一些了/)
  assert.match(html, /差不多/)
  assert.match(html, /更不舒服/)
})

test('TodoFeedbackBar stays hidden before practice feedback is triggered', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoFeedbackBar, {
      visible: false,
      sessionId: '11111111-1111-4111-8111-111111111111',
      todoContext: {
        planId: 'plan-1',
        todoId: 'todo-1',
        feedback: null,
        status: 'pending',
      },
    }),
  )

  assert.equal(html, '')
})

for (const status of ['completed', 'not_practiced'] as const) {
  test(`TodoFeedbackBar stays hidden for ${status} todo context`, () => {
    const html = renderToStaticMarkup(
      React.createElement(TodoFeedbackBar, {
        visible: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
        todoContext: {
          planId: 'plan-1',
          todoId: 'todo-1',
          scheduledMessageId: 'scheduled-1',
          feedback: null,
          status,
        },
      }),
    )

    assert.equal(html, '')
  })
}

test('TodoFeedbackBar renders for scheduled todo context', () => {
  const html = renderToStaticMarkup(
    React.createElement(TodoFeedbackBar, {
      visible: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      todoContext: {
        planId: 'plan-1',
        todoId: 'todo-1',
        scheduledMessageId: 'scheduled-1',
        feedback: null,
        status: 'pending',
      },
    }),
  )

  assert.match(html, /先休息一下，现在感觉怎么样/)
  assert.match(html, /好一些了/)
  assert.match(html, /差不多/)
  assert.match(html, /更不舒服/)
})
