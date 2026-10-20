import type { Logger } from '../lib/logger.js'
import { autoApproveExpiredDoctorUnbinds } from '../services/doctor-binding.js'

const DOCTOR_UNBIND_AUTO_APPROVE_MS = 7 * 24 * 60 * 60 * 1000

export async function runDoctorBindingAutoApprove(logger: Logger): Promise<number> {
  return autoApproveExpiredDoctorUnbinds({
    cutoff: new Date(Date.now() - DOCTOR_UNBIND_AUTO_APPROVE_MS),
    logger,
  })
}
