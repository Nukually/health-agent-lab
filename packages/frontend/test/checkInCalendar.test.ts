import assert from 'node:assert/strict'
import {
  calendarRecordMarker,
  dayKeyOf,
  isFutureCalendarDay,
  resolveSelectedCalendarDay,
} from '../src/lib/checkInCalendar.js'
const calendarModule = await import('../src/lib/checkInCalendar.js')

assert.equal(calendarRecordMarker(0), null)
assert.equal(calendarRecordMarker(1), '✓')
assert.equal(calendarRecordMarker(3), '3')

assert.equal(isFutureCalendarDay('2026-05-20', '2026-05-19'), true)
assert.equal(isFutureCalendarDay('2026-05-19', '2026-05-19'), false)
assert.equal(isFutureCalendarDay('2026-05-18', '2026-05-19'), false)

assert.equal(dayKeyOf(new Date('2026-05-19T10:30:00+08:00')), '2026-05-19')
assert.equal(dayKeyOf('bad-date'), '')

const recordDays = ['2026-05-19']
assert.equal(resolveSelectedCalendarDay('', recordDays, '2026-05-19'), '2026-05-19')
assert.equal(resolveSelectedCalendarDay('2026-05-18', recordDays, '2026-05-19'), '2026-05-18')
assert.equal(resolveSelectedCalendarDay('2026-05-20', recordDays, '2026-05-19'), '2026-05-20')
assert.equal(resolveSelectedCalendarDay('', [], '2026-05-19'), '2026-05-19')

const futureRecordDays = ['2026-05-20']
assert.equal(resolveSelectedCalendarDay('', futureRecordDays, '2026-05-19'), '2026-05-20')
assert.equal(resolveSelectedCalendarDay('2026-05-20', futureRecordDays, '2026-05-19'), '2026-05-20')

const monthKeyOf = (calendarModule as any).monthKeyOf
const shiftCalendarMonth = (calendarModule as any).shiftCalendarMonth
const resolveCalendarMonth = (calendarModule as any).resolveCalendarMonth
const resolveSelectedDayForMonth = (calendarModule as any).resolveSelectedDayForMonth

assert.equal(typeof monthKeyOf, 'function')
assert.equal(typeof shiftCalendarMonth, 'function')
assert.equal(typeof resolveCalendarMonth, 'function')
assert.equal(typeof resolveSelectedDayForMonth, 'function')
assert.equal(monthKeyOf('2026-05-20'), '2026-05')
assert.equal(monthKeyOf('bad-date'), '')
assert.equal(shiftCalendarMonth('2026-05', -1), '2026-04')
assert.equal(shiftCalendarMonth('2026-01', -1), '2025-12')
assert.equal(shiftCalendarMonth('2026-12', 1), '2027-01')
assert.equal(resolveCalendarMonth('', '2026-05-19'), '2026-05')
assert.equal(resolveCalendarMonth('2026-04-30', '2026-05-19'), '2026-04')
assert.equal(resolveSelectedDayForMonth('2026-04', '2026-04-30', ['2026-04-12']), '2026-04-30')
assert.equal(resolveSelectedDayForMonth('2026-04', '2026-05-19', ['2026-04-12']), '2026-04-12')
assert.equal(resolveSelectedDayForMonth('2026-04', '2026-05-19', []), '2026-04-01')

console.log('check-in calendar tests passed')
