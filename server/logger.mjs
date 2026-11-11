import { randomUUID } from 'node:crypto'

const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key)/i
const EMAIL_KEY = /(^to$|email$|recipient$)/i

export const newRequestId = () => randomUUID()

export function maskEmail(value) {
  const text = String(value ?? '')
  const at = text.indexOf('@')
  if (at < 1) return text ? `${text.slice(0, 2)}***` : ''
  const local = text.slice(0, at)
  const domain = text.slice(at + 1)
  return `${local.slice(0, 2)}***@${domain}`
}

function clean(value, key = '', depth = 0) {
  if (value === undefined || value === null) return value
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (EMAIL_KEY.test(key)) return maskEmail(value)
  if (depth > 4) return '[TRUNCATED]'
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code ?? null, status: value.status ?? null, stack: String(value.stack ?? '').slice(0, 4000) }
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => clean(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([name, item]) => [name, clean(item, name, depth + 1)]))
  }
  if (typeof value === 'string') return value.slice(0, 1000)
  return value
}

export function logEvent(level, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...clean(fields),
  }
  const line = JSON.stringify(record)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logInfo = (event, fields) => logEvent('info', event, fields)
export const logWarn = (event, fields) => logEvent('warn', event, fields)
export const logError = (event, fields) => logEvent('error', event, fields)
