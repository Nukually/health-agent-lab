import pino from 'pino'

const usePretty = process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV === 'development'

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: usePretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
    : undefined,
  base: { service: 'health-agent-lab' },
  serializers: {
    medicalRecord: () => '[REDACTED]',
    phone: (phone: string) =>
      typeof phone === 'string' ? phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : phone,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

export type Logger = pino.Logger
