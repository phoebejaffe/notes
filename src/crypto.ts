export interface EncryptedEnvelope {
  version: 1
  algorithm: 'AES-GCM-256'
  iv: string
  ciphertext: string
  associatedData?: string
}

export interface KeyBundle {
  version: 1
  algorithm: 'AES-GCM-256'
  kdf: 'PBKDF2-SHA-256'
  salt: string
  wrappedDataKey: EncryptedEnvelope
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const iterationCount = 600_000

function toBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toBase64Url(bytes: Uint8Array) {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromBase64Url(value: string) {
  return fromBase64(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource
}

async function deriveWrappingKey(recoveryKey: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(recoveryKey), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBufferSource(salt), iterations: iterationCount, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptBytes(value: Uint8Array, key: CryptoKey, associatedData?: string): Promise<EncryptedEnvelope> {
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(iv), additionalData: associatedData ? asBufferSource(encoder.encode(associatedData)) : undefined },
    key,
    asBufferSource(value),
  )
  return { version: 1, algorithm: 'AES-GCM-256', iv: toBase64Url(iv), ciphertext: toBase64(new Uint8Array(ciphertext)), associatedData }
}

async function decryptBytes(envelope: EncryptedEnvelope, key: CryptoKey) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(fromBase64Url(envelope.iv)), additionalData: envelope.associatedData ? asBufferSource(encoder.encode(envelope.associatedData)) : undefined },
    key,
    asBufferSource(fromBase64(envelope.ciphertext)),
  )
  return new Uint8Array(plaintext)
}

export async function createKeyBundle() {
  const recoveryKey = toBase64Url(randomBytes(32))
  const salt = randomBytes(16)
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const wrappingKey = await deriveWrappingKey(recoveryKey, salt)
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey))
  const wrappedDataKey = await encryptBytes(rawDataKey, wrappingKey, 'notes:key-bundle:v1')
  const bundle: KeyBundle = { version: 1, algorithm: 'AES-GCM-256', kdf: 'PBKDF2-SHA-256', salt: toBase64Url(salt), wrappedDataKey }
  return { recoveryKey, bundle }
}

export async function recoverDataKey(recoveryKey: string, bundle: KeyBundle) {
  const wrappingKey = await deriveWrappingKey(recoveryKey, fromBase64Url(bundle.salt))
  const rawDataKey = await decryptBytes(bundle.wrappedDataKey, wrappingKey)
  return crypto.subtle.importKey('raw', asBufferSource(rawDataKey), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptText(value: string, key: CryptoKey, associatedData?: string) {
  return encryptBytes(encoder.encode(value), key, associatedData)
}

export async function decryptText(envelope: EncryptedEnvelope, key: CryptoKey) {
  return decoder.decode(await decryptBytes(envelope, key))
}

export function createRecoveryKeyBackup(recoveryKey: string) {
  return `notes-recovery-v1:${recoveryKey}`
}

export function readRecoveryKeyBackup(backup: string) {
  const prefix = 'notes-recovery-v1:'
  if (!backup.startsWith(prefix)) throw new Error('Unsupported recovery key backup')
  const recoveryKey = backup.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(recoveryKey)) throw new Error('Invalid recovery key backup')
  return recoveryKey
}
