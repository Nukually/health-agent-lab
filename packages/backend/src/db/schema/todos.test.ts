import assert from 'node:assert/strict'
import test from 'node:test'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { todoItems, todoPlans } from './todos.js'

test('todos schema exposes plan and item tables', () => {
  assert.equal(getTableName(todoPlans), 'todo_plans')
  assert.equal(getTableName(todoItems), 'todo_items')
})

test('todo item schema uses one explicit status field for runtime state', () => {
  const columns = getTableColumns(todoItems)

  assert.ok(columns.status)
  assert.ok(columns.notifiedAt)
  assert.ok(columns.startedAt)
  assert.ok(columns.completedAt)
  assert.ok(columns.closedReason)
  assert.equal('userDecision' in columns, false)
  assert.equal('isDone' in columns, false)
})
