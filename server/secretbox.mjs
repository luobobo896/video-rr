/**
 * 敏感配置加密：AES-256-GCM，主密钥来自环境变量（不入库、不入仓）。
 * 支持密钥版本，便于轮换：MH_CONFIG_KEYS="1:<base64>,2:<base64>"，MH_CONFIG_KEY_VERSION 指定当前版本。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY_FILE = join(process.env.MH_CONFIG_KEY_FILE ?? join(ROOT, 'storage', 'config.key'))

/**
 * 兜底主密钥落盘：优先 MH_CONFIG_KEYS；否则读 storage/config.key；没有就生成一份 32 字节随机密钥并 0600 落盘。
 * 这样即使 MH_SECRET 轮换，已加密的支付/邮件/收款配置也不会变成无法解密的一堆废数据。
 */
function fallbackKey() {
  try {
    if (existsSync(KEY_FILE)) {
      const raw = readFileSync(KEY_FILE, 'utf8').trim()
      const key = Buffer.from(raw, 'base64')
      if (key.length === 32) return key
    }
  } catch { /* 读不到就重新生成 */ }
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(KEY_FILE), { recursive: true })
    writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
    console.warn(`[secretbox] 已生成配置加密密钥：${KEY_FILE}（请随备份一起保管，丢失将无法解密已保存的渠道密钥）`)
  } catch (error) {
    console.warn(`[secretbox] 无法写入密钥文件（${error.message}），回退到由 MH_SECRET 派生；轮换 MH_SECRET 会让已加密配置失效`)
    return createHash('sha256').update(process.env.MH_SECRET ?? 'dev-secret').digest()
  }
  return key
}

const parseKeys = () => {
  const map = new Map()
  const raw = process.env.MH_CONFIG_KEYS ?? ''
  for (const item of raw.split(',')) {
    const [version, key] = item.split(':')
    if (version && key) map.set(Number(version), Buffer.from(key, 'base64'))
  }
  if (map.size === 0) map.set(1, fallbackKey())
  return map
}

const KEYS = parseKeys()
const CURRENT_VERSION = Number(process.env.MH_CONFIG_KEY_VERSION ?? Math.max(...KEYS.keys()))

export class SecretError extends Error {}

/** 加密 JSON 对象 → `v<version>:<iv>:<tag>:<cipher>`（base64url 分段）。 */
export function sealSecret(value) {
  const key = KEYS.get(CURRENT_VERSION)
  if (!key) throw new SecretError(`缺少密钥版本 ${CURRENT_VERSION}`)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v${CURRENT_VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`
}

export function openSecret(payload) {
  if (!payload) return {}
  const [versionTag, ivTag, tagTag, dataTag] = String(payload).split(':')
  if (!versionTag || !ivTag || !tagTag || !dataTag) throw new SecretError('密文格式不正确')
  const version = Number(versionTag.replace(/^v/, ''))
  const key = KEYS.get(version)
  if (!key) throw new SecretError(`未知密钥版本 ${version}（请配置 MH_CONFIG_KEYS）`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivTag, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagTag, 'base64url'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataTag, 'base64url')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

/** 判断某字段是否属于需要加密的敏感字段（用于入库前拆分明文/密文）。 */
export const SENSITIVE_KEYS = ['appId', 'appSecret', 'privateKey', 'publicKey', 'apiKey', 'mchId', 'apiV3Key', 'walletAddress', 'serialNo']

/** 脱敏：列表/详情只回显掩码，私钥类字段永不回传明文。 */
export function maskConfig(config = {}) {
  const masked = {}
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') { masked[key] = ''; continue }
    if (!SENSITIVE_KEYS.includes(key)) { masked[key] = value; continue }
    const text = String(value)
    if (/key|secret/i.test(key)) {
      masked[key] = `${text.slice(0, 4)}****${text.slice(-4)}（已加密）`
    } else if (/address/i.test(key)) {
      masked[key] = `${text.slice(0, 6)}…${text.slice(-4)}`
    } else {
      masked[key] = text.length <= 6 ? `${text.slice(0, 2)}****` : `${text.slice(0, 4)}****${text.slice(-4)}`
    }
  }
  return masked
}

export function keyVersions() {
  return [...KEYS.keys()].sort((a, b) => a - b)
}

export function currentKeyVersion() {
  return CURRENT_VERSION
}
