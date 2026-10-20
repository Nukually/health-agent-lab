import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoundDoctor } from '@health-agent/shared'
import {
  DOCTOR_BINDING_LIMIT,
  planInviteBindDoctor,
  resolveDoctorInitiatedUnbind,
  resolvePatientInitiatedUnbind,
} from './doctor-binding.js'

function makeBinding(doctorId: string, status: BoundDoctor['status'], unbindRequestedBy: BoundDoctor['unbindRequestedBy'] = null): BoundDoctor {
  return {
    bindingId: `binding-${doctorId}`,
    status,
    unbindRequestedBy,
    createdAt: '2026-05-25T00:00:00.000Z',
    confirmedAt: status === 'confirmed' ? '2026-05-25T00:00:00.000Z' : null,
    unboundAt: null,
    doctor: {
      id: doctorId,
      doctorInviteCode: null,
      name: '王医生',
      avatarUrl: null,
      hospital: null,
      department: null,
      title: null,
      phone: null,
    },
  }
}

test('invite binding reuses the same active doctor binding instead of creating a duplicate', () => {
  const existing = makeBinding('doctor-a', 'confirmed')

  assert.deepEqual(planInviteBindDoctor([existing], 'doctor-a'), {
    type: 'reuse_existing',
    binding: existing,
  })
})

test('invite binding allows a different doctor while existing doctors remain active', () => {
  assert.deepEqual(planInviteBindDoctor([makeBinding('doctor-a', 'confirmed')], 'doctor-b'), {
    type: 'create_pending',
    doctorId: 'doctor-b',
  })
})

test('invite binding blocks new doctors after reaching the active binding limit', () => {
  const existing = Array.from({ length: DOCTOR_BINDING_LIMIT }, (_, index) => makeBinding(`doctor-${index}`, 'confirmed'))

  assert.deepEqual(planInviteBindDoctor(existing, 'doctor-new'), {
    type: 'max_reached',
    limit: DOCTOR_BINDING_LIMIT,
  })
})

test('patient unbind immediately unbinds when doctor already requested unbind', () => {
  assert.deepEqual(resolvePatientInitiatedUnbind(makeBinding('doctor-a', 'pending_unbind', 'doctor')), {
    status: 'unbound',
    unbindRequestedBy: 'doctor',
  })
})

test('doctor unbind immediately unbinds when patient already requested unbind', () => {
  assert.deepEqual(resolveDoctorInitiatedUnbind(makeBinding('doctor-a', 'pending_unbind', 'patient')), {
    status: 'unbound',
    unbindRequestedBy: 'patient',
  })
})
