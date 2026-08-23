// Host half of dsh-media-gen.
//
// Generates images (text-to-image and image-to-image) and videos through the
// OpenAI-compatible providers already configured in DSH Model settings
// (settings.yaml -> llm-pi-ai.providers).  The plugin adds:
//
//   * a dedicated Settings section ("媒体生成") with provider/model pickers
//   * chat tools: media_list_providers / media_gen_image / media_edit_image / media_gen_video
//   * durable media output under <current workspace>/media_gen (configurable)
//   * loopback web routes to display generated media inline in chat
//
// The backend mirrors dsh-chat-imagine's provider resolution: providers come
// from the llm-pi-ai settings namespace, baseURL falls back to the pi-ai
// built-in catalog, and API keys are resolved through DSH credentials by
// apiKeyEnv.  No API key is ever exposed to the browser.
'use strict'

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Blob } from 'node:buffer'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-media-gen'
export const inject = ['tools', 'webServer']

export const Config = Schema.object({
  // Output directory. Relative paths are resolved against the current
  // workspace of the session; absolute paths are used as-is.
  outputDir: Schema.string().default('media_gen'),
  // Default provider/model for text-to-image.
  imageProvider: Schema.string().default(''),
  imageModel: Schema.string().default(''),
  // Default provider/model for image-to-image (images/edits).
  imageEditProvider: Schema.string().default(''),
  imageEditModel: Schema.string().default(''),
  // Default provider/model for video generation.
  videoProvider: Schema.string().default(''),
  videoModel: Schema.string().default(''),
  // Optional custom path suffix for video generation, e.g. "/videos" or
  // "/v1/videos/generations". Empty = auto (try /videos/generations then /videos).
  videoEndpoint: Schema.string().default(''),
  timeoutMs: Schema.number().default(120000),
  videoTimeoutMs: Schema.number().default(600000),
  displayHost: Schema.string().default(''),
})

const NS = 'dsh-media-gen'
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

// Static fallback for providers whose baseURL is not written in settings
// (DSH's llm-pi-ai adapter resolves these from the pi-ai built-in catalog).
const STATIC_CATALOG_BASE = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.ai/v1',
  moonshotai: 'https://api.moonshot.ai/v1',
  'moonshotai-cn': 'https://api.moonshot.cn/v1',
}

let catalogBaseCache
async function catalogBaseUrls() {
  if (catalogBaseCache) return catalogBaseCache
  const map = { ...STATIC_CATALOG_BASE }
  try {
    const mod = await import('@earendil-works/pi-ai/providers/all')
    for (const p of mod.builtinProviders?.() ?? []) {
      if (p?.id && typeof p.baseUrl === 'string' && p.baseUrl) map[p.id] = p.baseUrl
    }
  } catch {
    // static table is enough
  }
  catalogBaseCache = map
  return map
}

// Some providers (opencode / opencode-go / ...) only carry per-model baseUrl
// in the pi-ai catalog. Fetch that lazily and cache it so providers without an
// explicit settings baseURL still appear in the media-gen provider picker and
// resolve to a real endpoint when a model is chosen.
const catalogModelsCache = new Map()
async function catalogProviderModels(providerId) {
  if (catalogModelsCache.has(providerId)) return catalogModelsCache.get(providerId)
  let models = []
  try {
    const mod = await import('@earendil-works/pi-ai/providers/all')
    const provider = (mod.builtinProviders?.() ?? []).find((p) => p?.id === providerId)
    if (provider && typeof provider.getModels === 'function') {
      const raw = await provider.getModels()
      models = (raw ?? []).map((m) => ({
        id: typeof m.id === 'string' ? m.id : '',
        name: typeof m.name === 'string' && m.name ? m.name : (typeof m.id === 'string' ? m.id : ''),
        baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl : '',
        api: typeof m.api === 'string' ? m.api : '',
      })).filter((m) => m.id)
    }
  } catch {
    models = []
  }
  catalogModelsCache.set(providerId, models)
  return models
}

function preferredCatalogBaseUrl(models) {
  const openaiModel = models.find((m) => m.baseUrl && /openai-completions|openai-responses|openai/i.test(m.api || ''))
  if (openaiModel) return openaiModel.baseUrl
  const anyModel = models.find((m) => m.baseUrl)
  return anyModel ? anyModel.baseUrl : ''
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function settingsOf(ctx) {
  try {
    return ctx.get('settings')
  } catch {
    return null
  }
}

function credentialsOf(ctx) {
  try {
    return ctx.get('credentials')
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function tryParse(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function errorStatus(error) {
  return Number(error?.message?.match(/\b(\d{3})\b/)?.[1] || 0)
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14)
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6)
}

function normalizedModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  for (const raw of models) {
    let m = raw
    if (typeof raw === 'string') m = { id: raw }
    if (!m || typeof m !== 'object') continue
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id) continue
    out.push({ id, name: typeof m.name === 'string' && m.name ? m.name : id })
  }
  return out
}

function mergeModels(...lists) {
  const map = new Map()
  for (const list of lists) {
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue
      if (!map.has(m.id)) map.set(m.id, m)
    }
  }
  return [...map.values()]
}

function pickItem(payload) {
  if (Array.isArray(payload?.data) && payload.data.length > 0) return payload.data[0]
  if (payload && typeof payload === 'object') return payload
  return {}
}

const URLISH_KEY = /(?:url|link|src|href|download|playback|playable|stream|content|file|video|output|result|media)/i
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv|m3u8)(\?|#|$)/i

// Deeply look for a video/media URL in a gateway response. Video endpoints are
// not standardized: results may live under url/content_url/output/files/data/
// result/video/media, nested arrays, or arbitrary wrapper objects.
function findMediaUrl(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return ''
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value)) return ''
    const lower = value.toLowerCase()
    if (VIDEO_EXT_RE.test(lower) || /video|stream|playback|download|media|sora|veo/i.test(lower)) return value
    return ''
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMediaUrl(entry, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    // Prefer values stored under url-ish keys. Opaque CDN links may have no
    // video extension or keyword, so any http(s) value under such a key is a
    // good candidate.
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string' && /^https?:\/\//i.test(val) && URLISH_KEY.test(key)) {
        return val
      }
    }
    for (const [key, val] of Object.entries(value)) {
      const found = findMediaUrl(val, depth + 1)
      if (found) return found
    }
  }
  return ''
}

// Some gateways return video bytes base64-encoded under non-standard keys.
function findVideoBase64(value, depth = 0) {
  if (value === null || value === undefined || depth > 6) return ''
  if (typeof value === 'string') {
    return value.length > 1000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value) ? value : ''
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findVideoBase64(entry, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (/b64|base64|video_data|data/i.test(key)) {
        const found = typeof val === 'string' ? (val.length > 1000 ? val : '') : findVideoBase64(val, depth + 1)
        if (found) return found
      }
    }
    for (const [key, val] of Object.entries(value)) {
      const found = findVideoBase64(val, depth + 1)
      if (found) return found
    }
  }
  return ''
}

// Identify the real video container from magic bytes, so files are never saved
// with the wrong extension/MIME even when the gateway lied about content-type.
function sniffVideo(bytes) {
  if (!bytes || bytes.length < 12) return null
  // MP4 / QuickTime: bytes[4..7] == "ftyp"
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand.startsWith('qt')) return { ext: 'mov', mime: 'video/quicktime' }
    return { ext: 'mp4', mime: 'video/mp4' }
  }
  // WebM / MKV: EBML magic 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const head = bytes.subarray(0, Math.min(4096, bytes.length)).toString('latin1')
    if (head.includes('webm')) return { ext: 'webm', mime: 'video/webm' }
    return { ext: 'mkv', mime: 'video/x-matroska' }
  }
  return null
}

function videoMediaFromBytes(bytes) {
  const sniffed = sniffVideo(bytes)
  if (sniffed) return { bytes, mime: sniffed.mime, ext: sniffed.ext }
  return { bytes, mime: 'video/mp4', ext: 'mp4' }
}

function extOfMime(mime, fallback) {
  for (const [ext, m] of Object.entries(MIME_BY_EXT)) {
    if (m === mime) return ext.slice(1)
  }
  return fallback
}

function sameOrigin(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}

function cwdOf(exec) {
  const header = exec?.agent?.session?.header
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd
  return process.cwd()
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!(hostUrl.hostname === '127.0.0.1' || hostUrl.hostname === '::1' || hostUrl.hostname === 'localhost')) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// settings / configuration
// ---------------------------------------------------------------------------

// Registers our settings namespace. DSH settings tabs and the client settings
// service refuse to serve an unknown namespace ("settings namespace ... is not
// registered"), so this must happen before the settings UI or tools read/write
// anything. Called eagerly from apply() and lazily from every accessor as a
// safety net (settings may not be available at apply time on some profiles).
function ensureSettings(ctx, config) {
  const settings = settingsOf(ctx)
  if (!settings || typeof settings.register !== 'function') return settings
  try {
    settings.register(
      NS,
      Config,
      {
        base: {
          outputDir: config.outputDir || 'media_gen',
          imageProvider: config.imageProvider || '',
          imageModel: config.imageModel || '',
          imageEditProvider: config.imageEditProvider || '',
          imageEditModel: config.imageEditModel || '',
          videoProvider: config.videoProvider || '',
          videoModel: config.videoModel || '',
          videoEndpoint: config.videoEndpoint || '',
          timeoutMs: config.timeoutMs || 120000,
          videoTimeoutMs: config.videoTimeoutMs || 600000,
        },
      },
    )
  } catch {
    // Already registered or service unavailable: the accessors below will
    // surface a real error only if the namespace genuinely cannot be used.
  }
  return settings
}

function currentConfig(ctx, config) {
  ensureSettings(ctx, config)
  const stored = (() => {
    try {
      return settingsOf(ctx)?.get(NS) || {}
    } catch {
      return {}
    }
  })()
  return {
    outputDir: typeof stored.outputDir === 'string' && stored.outputDir ? stored.outputDir : config.outputDir || 'media_gen',
    imageProvider: typeof stored.imageProvider === 'string' ? stored.imageProvider : config.imageProvider || '',
    imageModel: typeof stored.imageModel === 'string' ? stored.imageModel : config.imageModel || '',
    imageEditProvider: typeof stored.imageEditProvider === 'string' ? stored.imageEditProvider : config.imageEditProvider || '',
    imageEditModel: typeof stored.imageEditModel === 'string' ? stored.imageEditModel : config.imageEditModel || '',
    videoProvider: typeof stored.videoProvider === 'string' ? stored.videoProvider : config.videoProvider || '',
    videoModel: typeof stored.videoModel === 'string' ? stored.videoModel : config.videoModel || '',
    videoEndpoint: typeof stored.videoEndpoint === 'string' ? stored.videoEndpoint : config.videoEndpoint || '',
    timeoutMs: typeof stored.timeoutMs === 'number' ? stored.timeoutMs : config.timeoutMs || 120000,
    videoTimeoutMs: typeof stored.videoTimeoutMs === 'number' ? stored.videoTimeoutMs : config.videoTimeoutMs || 600000,
  }
}

async function writeConfig(ctx, patch) {
  const settings = ensureSettings(ctx, {})
  if (!settings || typeof settings.update !== 'function') {
    throw new Error('settings service unavailable; edit cordis.yml config instead')
  }
  const allowed = new Set([
    'outputDir',
    'imageProvider', 'imageModel',
    'imageEditProvider', 'imageEditModel',
    'videoProvider', 'videoModel',
    'videoEndpoint', 'timeoutMs', 'videoTimeoutMs',
  ])
  const clean = {}
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    if (key === 'timeoutMs' || key === 'videoTimeoutMs') {
      const n = Number(patch[key])
      clean[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 120000
    } else {
      clean[key] = String(patch[key] ?? '')
    }
  }
  await settings.update(NS, clean)
}

// ---------------------------------------------------------------------------
// provider resolution
// ---------------------------------------------------------------------------

async function providerSection(ctx, providerId) {
  const settings = settingsOf(ctx)
  const providers = settings?.get('llm-pi-ai')?.providers
  if (!providers || typeof providers !== 'object') return null
  const p = providers[providerId]
  return p && typeof p === 'object' ? p : null
}

async function resolveProvider(ctx, providerId, modelId) {
  const id = String(providerId || '').trim()
  if (!id) return null
  const section = await providerSection(ctx, id)
  const catalog = await catalogBaseUrls()
  const catalogModels = await catalogProviderModels(id)
  const explicitBase =
    (typeof section?.baseURL === 'string' && section.baseURL.trim() ? section.baseURL.trim() : '') ||
    catalog[id] ||
    ''
  let baseURL = explicitBase
  if (!baseURL) {
    const selected = catalogModels.find((m) => m.id === modelId) || catalogModels.find((m) => /openai-completions|openai-responses|openai/i.test(m.api || '')) || catalogModels.find((m) => m.baseUrl)
    baseURL = selected?.baseUrl || preferredCatalogBaseUrl(catalogModels) || ''
  }
  if (!baseURL) return null
  const credentials = credentialsOf(ctx)
  let key = ''
  if (section) {
    const env = typeof section.apiKeyEnv === 'string' ? section.apiKeyEnv : ''
    if (env) {
      const cred = await credentials?.resolve(env).catch(() => undefined)
      if (cred) key = cred.value || ''
    }
    if (!key && typeof section.apiKey === 'string') key = section.apiKey
  }
  const configuredModels = normalizedModels(section?.models ?? [])
  const models = mergeModels(configuredModels, catalogModels.map((m) => ({ id: m.id, name: m.name })))
  return {
    id,
    name: typeof section?.name === 'string' && section.name ? section.name : id,
    baseURL: baseURL.replace(/\/+$/, ''),
    key,
    models,
    section,
  }
}

async function fetchModels(baseURL, key, signal, timeoutMs) {
  const signals = []
  if (signal) signals.push(signal)
  signals.push(AbortSignal.timeout(timeoutMs || 8000))
  const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.any(signals),
  })
  if (!res.ok) return []
  const json = await res.json().catch(() => null)
  return normalizedModels(json?.data ?? [])
}

async function listProviders(ctx, { probe = false, signal } = {}) {
  const settings = settingsOf(ctx)
  const providers = settings?.get('llm-pi-ai')?.providers
  if (!providers || typeof providers !== 'object') return []
  const catalog = await catalogBaseUrls()
  const out = []
  for (const [id, section] of Object.entries(providers)) {
    if (!section || typeof section !== 'object') continue
    const catalogModels = await catalogProviderModels(id)
    const catalogBase = preferredCatalogBaseUrl(catalogModels)
    const baseURL =
      (typeof section.baseURL === 'string' && section.baseURL.trim() ? section.baseURL.trim() : '') ||
      catalog[id] ||
      catalogBase ||
      ''
    // Keep providers that have models even when no baseURL could be resolved,
    // so the picker shows them; generation will surface a clear error.
    if (!baseURL && catalogModels.length === 0) continue
    const credentials = credentialsOf(ctx)
    let key = ''
    if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv) {
      const cred = await credentials?.resolve(section.apiKeyEnv).catch(() => undefined)
      if (cred) key = cred.value || ''
    }
    if (!key && typeof section.apiKey === 'string') key = section.apiKey
    let models = mergeModels(
      normalizedModels(section.models ?? []),
      catalogModels.map((m) => ({ id: m.id, name: m.name })),
    )
    if (probe && baseURL) {
      const fetched = await fetchModels(baseURL, key, signal, 8000).catch(() => [])
      models = mergeModels(models, fetched)
    }
    out.push({
      id,
      name: typeof section.name === 'string' && section.name ? section.name : id,
      baseURL: baseURL.replace(/\/+$/, ''),
      hasKey: Boolean(key),
      hasBaseURL: Boolean(baseURL),
      models: models.map((m) => ({ id: m.id, name: m.name })),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// OpenAI-compatible calls
// ---------------------------------------------------------------------------

async function postJSON(ctx, endpoint, key, body, signal, timeoutMs) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  const text = await res.text().catch(() => '')
  const json = tryParse(text)
  if (!res.ok || json?.error) {
    const detail = json?.error?.message || json?.error || text || `HTTP ${res.status}`
    throw new Error(`gateway error ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return json || {}
}

async function postForm(ctx, endpoint, key, form, signal, timeoutMs) {
  const headers = { Authorization: `Bearer ${key}` }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  const text = await res.text().catch(() => '')
  const json = tryParse(text)
  if (!res.ok || json?.error) {
    const detail = json?.error?.message || json?.error || text || `HTTP ${res.status}`
    throw new Error(`gateway error ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return json || {}
}

async function downloadMedia(url, key, signal, timeoutMs, kind, allowedOrigin = '') {
  const finish = async (res) => {
    const bytes = Buffer.from(await res.arrayBuffer())
    const ct = (res.headers.get('content-type') || '').split(';')[0] || ''
    let pathExt = ''
    try {
      pathExt = extname(new URL(url).pathname).toLowerCase().replace(/^\./, '')
    } catch {
      pathExt = ''
    }
    if (kind === 'image') {
      const mime = ct.startsWith('image/') ? ct : MIME_BY_EXT[`.${pathExt}`] || 'image/png'
      return { bytes, mime, ext: pathExt || extOfMime(mime, 'png') }
    }
    // Video: trust magic bytes over the claimed content-type/extension so we
    // never save an .mp4 that is actually webm/html/json.
    const sniffed = sniffVideo(bytes)
    if (sniffed) {
      return { bytes, mime: sniffed.mime, ext: sniffed.ext }
    }
    const isBinary = !ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream' || ct === 'application/stream'
    if (ct && !ct.startsWith('video/') && !isBinary) {
      throw new Error(
        `downloaded media is not a video (content-type: ${ct || 'unknown'}; url: ${url.slice(0, 120)})`,
      )
    }
    const mime = ct.startsWith('video/') ? ct : MIME_BY_EXT[`.${pathExt}`] || 'video/mp4'
    return { bytes, mime, ext: pathExt || extOfMime(mime, 'mp4') }
  }

  const attempt = async (authKey) => {
    const res = await fetch(url, {
      headers: authKey ? { Authorization: `Bearer ${authKey}` } : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    if (!res.ok) {
      const error = new Error(`failed to download media from gateway url (${res.status})`)
      error.status = res.status
      throw error
    }
    return finish(res)
  }

  // Only send the provider API key to the provider's own origin. Gateway-issued
  // CDN/temporary URLs are usually public and must not receive our Bearer token
  // (sending it can itself cause 401, and it would leak the key to third-party
  // hosts). If the same-origin URL still rejects the key, fall back to no auth.
  const useKey = Boolean(key && allowedOrigin && sameOrigin(url, allowedOrigin))
  try {
    return await attempt(useKey ? key : '')
  } catch (error) {
    if (useKey && (error?.status === 401 || error?.status === 403)) {
      return await attempt('')
    }
    throw error
  }
}

async function mediaFromImagePayload(payload, baseURL, key, signal, timeoutMs) {
  const item = pickItem(payload)
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    const bytes = Buffer.from(item.b64_json, 'base64')
    return { bytes, mime: 'image/png', ext: 'png' }
  }
  const url = typeof item?.url === 'string' && item.url ? item.url : ''
  if (url) return downloadMedia(url, key, signal, timeoutMs, 'image', baseURL)
  throw new Error('image gateway response has neither b64_json nor url')
}

async function readInputImage(ref, cwd, signal, timeoutMs) {
  const input = String(ref || '').trim()
  if (!input) throw new Error('image path/URL is required')
  if (/^https?:\/\//i.test(input)) {
    const media = await downloadMedia(input, '', signal, timeoutMs, 'image')
    return { ...media, name: 'remote-image' }
  }
  const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  const bytes = await readFile(abs)
  const ext = extname(abs).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'image/png'
  return { bytes, mime, name: abs }
}

// Resolve an image-to-video input for gateways that accept a public URL.
// - Public http(s) URLs are passed through unchanged.
// - Local files and loopback URLs (http://127.0.0.1/...) are read locally and
//   converted to a base64 data URL, so a just-generated local image can be
//   used without needing a public tunnel.
async function resolveVideoInputImage(imageRef, cwd, signal, timeoutMs) {
  const ref = String(imageRef || '').trim()
  if (!ref) return null
  if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref)
      const loopback =
        url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
      if (!loopback) return { value: ref }
    } catch {
      // fall through to readInputImage which will surface the real error
    }
  }
  const media = await readInputImage(ref, cwd, signal, timeoutMs)
  return { value: `data:${media.mime};base64,${media.bytes.toString('base64')}` }
}

// ---------------------------------------------------------------------------
// durable media index: lets /media-gen/raw/* keep serving historical session
// media after the server restarts (the in-memory mediaStore is wiped).
// ---------------------------------------------------------------------------
function mediaIndexPath() {
  const home = process.env.DSH_HOME || homedir()
  return join(home, '.dsh', 'storages', 'dsh-media-gen-index.json')
}

async function readMediaIndex() {
  try {
    const raw = await readFile(mediaIndexPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {}
  } catch {
    return {}
  }
}

async function writeMediaIndex(files) {
  try {
    const path = mediaIndexPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ files }), 'utf8')
  } catch {
    // index is best-effort; the file itself is still on disk
  }
}

async function rememberMediaInIndex(saved) {
  const files = await readMediaIndex()
  files[saved.name] = { abs: saved.abs, mime: saved.mime }
  const keys = Object.keys(files)
  if (keys.length > 3000) {
    // keep the newest 3000 entries (object insertion order is preserved)
    for (const key of keys.slice(0, keys.length - 3000)) delete files[key]
  }
  await writeMediaIndex(files)
}

async function saveMedia(ctx, exec, config, bytes, mime, ext, kind) {
  const rawDir = String(config.outputDir || 'media_gen').trim()
  const root = isAbsolute(rawDir)
    ? resolve(rawDir)
    : resolve(cwdOf(exec), rawDir)
  await mkdir(root, { recursive: true })
  const name = `${kind}_${timestamp()}_${randomSuffix()}.${ext || (kind === 'video' ? 'mp4' : 'png')}`
  const abs = join(root, name)
  await writeFile(abs, bytes)
  await rememberMediaInIndex({ abs, name, mime })
  return { abs, name, root, mime }
}

async function resolveVideoResult(ctx, exec, config, provider, payload, signal) {
  const timeoutMs = config.videoTimeoutMs || 600000
  const baseURL = provider.baseURL
  const key = provider.key
  const rootBase = baseURL.replace(/\/v1\/?$/, '')
  const statusOf = (data) => {
    const s = data && typeof data === 'object' ? data.status : undefined
    return typeof s === 'string' ? s.toLowerCase() : ''
  }

  const taskCandidates = (id) => [
    `${baseURL}/videos/${id}`,
    `${baseURL}/videos/generations/${id}`,
    `${baseURL}/agnesapi?video_id=${encodeURIComponent(id)}`,
    `${rootBase}/agnesapi?video_id=${encodeURIComponent(id)}`,
    `${rootBase}/v1/agnesapi?video_id=${encodeURIComponent(id)}`,
  ]

  const fetchTask = async (id) => {
    if (!id) return null
    for (const url of taskCandidates(id)) {
      try {
        const res = await fetch(url, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs - (Date.now() - started))]),
        })
        if (res.ok) {
          const json = await res.json().catch(() => null)
          if (json) return json
        }
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return null
  }

  const extractId = (item, current) =>
    item?.video_id || current?.video_id ||
    item?.id || current?.id ||
    item?.task_id || current?.task_id ||
    item?.file_id || ''

  // OpenAI-style video APIs often expose the finished file at
  // GET /videos/{id}/content (or the generations variant) instead of putting
  // a URL in the status payload.
  const tryContentDownload = async (id) => {
    if (!id) return null
    for (const suffix of [`/videos/${id}/content`, `/videos/generations/${id}/content`]) {
      try {
        const res = await fetch(`${baseURL}${suffix}`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 30000))]),
        })
        if (!res.ok) continue
        const ct = (res.headers.get('content-type') || '').split(';')[0] || ''
        if (!ct.startsWith('video/')) continue
        const bytes = Buffer.from(await res.arrayBuffer())
        return videoMediaFromBytes(bytes)
      } catch {
        continue
      }
    }
    return null
  }

  // The gateway may mark a task "completed" a little before its CDN file is
  // actually reachable. Retry the download several times and refresh the task
  // result in between to pick up a rotated/later URL.
  const downloadWithRetry = async (initialUrl, id) => {
    let url = initialUrl
    const delays = [5000, 8000, 12000, 20000, 30000]
    let lastError = null
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await downloadMedia(url, key, signal, timeoutMs, 'video', baseURL)
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
        const status = error?.status || errorStatus(error)
        const retryable = status === 403 || status === 404 || status === 429 || status >= 500
        if (!retryable || attempt >= delays.length) break
        if (id) {
          const refreshed = await fetchTask(id).catch(() => null)
          if (refreshed) {
            const freshUrl = findMediaUrl(refreshed)
            if (freshUrl && freshUrl !== url) url = freshUrl
          }
        }
        await sleep(delays[attempt])
      }
    }
    throw lastError || new Error('video download failed')
  }

  let current = payload
  const started = Date.now()
  for (;;) {
    const item = pickItem(current)
    const status = statusOf(item) || statusOf(current)
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const id = extractId(item, current)
      let url = findMediaUrl(item) || findMediaUrl(current)
      if (url) return await downloadWithRetry(url, id)
      const b64 = findVideoBase64(item) || findVideoBase64(current)
      if (b64) return videoMediaFromBytes(Buffer.from(b64, 'base64'))
      const content = await tryContentDownload(id)
      if (content) return content
      // The status payload may not carry the URL, but the task endpoint does.
      const refreshed = await fetchTask(id)
      if (refreshed) {
        url = findMediaUrl(refreshed)
        if (url) return await downloadWithRetry(url, id)
      }
      throw new Error(
        'video generation completed but the response contains no url. ' +
        `Raw response: ${JSON.stringify(current).slice(0, 800)}`
      )
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      throw new Error(`video generation failed: ${JSON.stringify(current).slice(0, 500)}`)
    }

    const id = extractId(item, current)
    const url = findMediaUrl(item) || findMediaUrl(current)
    if (url && !['queued', 'processing', 'in_progress', 'pending'].includes(status)) {
      return await downloadWithRetry(url, id)
    }
    const b64 = findVideoBase64(item) || findVideoBase64(current)
    if (b64) return videoMediaFromBytes(Buffer.from(b64, 'base64'))

    if (!id) {
      if (url) return await downloadWithRetry(url, '')
      throw new Error('video gateway response has no id/url/status to poll')
    }
    if (Date.now() - started >= timeoutMs) throw new Error('video generation timed out')
    if (signal?.aborted) throw signal.reason || new Error('aborted')

    await sleep(3000)
    const found = await fetchTask(id)
    if (!found) {
      throw new Error('could not poll video status (tried /videos/:id, /videos/generations/:id and agnesapi?video_id=)')
    }
    current = found
  }
}

async function generateImageTool(exec, args, ctx, config, kind) {
  const cfg = currentConfig(ctx, config)
  const isEdit = kind === 'edit'
  const providerId = String(args.provider ?? '').trim() || (isEdit ? cfg.imageEditProvider : cfg.imageProvider)
  const modelId = String(args.model ?? '').trim() || (isEdit ? cfg.imageEditModel : cfg.imageModel)
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt is required')

  const provider = await resolveProvider(ctx, providerId, modelId)
  if (!provider) {
    const providers = await listProviders(ctx)
    throw new Error(
      `media_gen: provider "${providerId || '(未配置)'}" not found or has no baseURL in DSH Model settings. ` +
        `Available: ${providers.map((p) => p.id).join(', ') || 'none'}`
    )
  }
  const model = modelId
    ? modelId
    : provider.models[0]?.id
  if (!model) {
    throw new Error(
      `media_gen: no model configured for ${isEdit ? 'image-to-image' : 'text-to-image'}. ` +
        `Open Settings → 媒体生成 and pick a model, or pass model explicitly.`
    )
  }

  const signal = exec.signal
  const timeoutMs = cfg.timeoutMs || 120000
  // Some gateways only hand back a protected download URL; requesting
  // b64_json lets us save the media directly and avoids 401 downloads.
  const b64Rejected = (error) =>
    errorStatus(error) === 400 && /response_format|unknown parameter|unsupported|invalid.*parameter/i.test(error?.message || '')
  let payload
  if (isEdit) {
    const image = await readInputImage(args.image, cwdOf(exec), signal, timeoutMs)
    const buildForm = (withB64) => {
      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      const filename = /\.\w+$/.test(image.name) ? image.name.split(/[\\/]/).pop() : 'image.png'
      form.append('image', new Blob([image.bytes], { type: image.mime }), filename)
      if (args.size) form.append('size', String(args.size))
      form.append('n', '1')
      if (withB64) form.append('response_format', 'b64_json')
      return form
    }
    try {
      payload = await postForm(ctx, `${provider.baseURL}/images/edits`, provider.key, buildForm(true), signal, timeoutMs)
    } catch (error) {
      if (b64Rejected(error)) {
        payload = await postForm(ctx, `${provider.baseURL}/images/edits`, provider.key, buildForm(false), signal, timeoutMs)
      } else {
        throw error
      }
    }
  } else {
    const buildBody = (withB64) => {
      const body = { model, prompt, n: 1 }
      if (args.size) body.size = String(args.size)
      if (withB64) body.response_format = 'b64_json'
      return body
    }
    try {
      payload = await postJSON(ctx, `${provider.baseURL}/images/generations`, provider.key, buildBody(true), signal, timeoutMs)
    } catch (error) {
      if (b64Rejected(error)) {
        payload = await postJSON(ctx, `${provider.baseURL}/images/generations`, provider.key, buildBody(false), signal, timeoutMs)
      } else {
        throw error
      }
    }
  }

  const media = await mediaFromImagePayload(payload, provider.baseURL, provider.key, signal, timeoutMs)
  const saved = await saveMedia(ctx, exec, cfg, media.bytes, media.mime, media.ext, 'image')
  return { saved, provider, model, isEdit }
}

async function generateVideoTool(exec, args, ctx, config) {
  const cfg = currentConfig(ctx, config)
  const providerId = String(args.provider ?? '').trim() || cfg.videoProvider
  const modelId = String(args.model ?? '').trim() || cfg.videoModel
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt is required')

  const provider = await resolveProvider(ctx, providerId, modelId)
  if (!provider) {
    const providers = await listProviders(ctx)
    throw new Error(
      `media_gen_video: provider "${providerId || '(未配置)'}" not found in DSH Model settings. ` +
        `Available: ${providers.map((p) => p.id).join(', ') || 'none'}`
    )
  }
  const model = modelId || provider.models[0]?.id
  if (!model) {
    throw new Error(
      'media_gen_video: no video model configured. Open Settings → 媒体生成 and pick a video model, or pass model explicitly.'
    )
  }

  const signal = exec.signal
  const timeoutMs = cfg.videoTimeoutMs || 600000
  const paths = cfg.videoEndpoint
    ? [String(cfg.videoEndpoint).trim()]
    : ['/videos', '/videos/generations']
  const body = { model, prompt, n: 1 }
  // Image-to-video: local files and loopback URLs are converted to a base64
  // data URL so a just-generated local image can be used directly.
  if (args.image) {
    const imageInput = await resolveVideoInputImage(args.image, cwdOf(exec), signal, Math.min(timeoutMs, 60000))
    if (imageInput) body.image = imageInput.value
  }
  if (args.duration) {
    const secs = Number(args.duration)
    body.duration = secs
    // Agnes Video V2.0 uses num_frames + frame_rate; align to its 8n+1 rule.
    body.frame_rate = 24
    let frames = Math.min(441, Math.max(9, Math.round(secs * 24)))
    frames = Math.floor((frames - 1) / 8) * 8 + 1
    body.num_frames = frames
  }
  if (args.size) {
    body.size = String(args.size)
    const sizeMatch = /^(\d+)x(\d+)$/i.exec(String(args.size))
    if (sizeMatch) {
      body.width = Number(sizeMatch[1])
      body.height = Number(sizeMatch[2])
    }
  }
  if (args.resolution) body.resolution = String(args.resolution)

  let payload = null
  let lastError = null
  for (const path of paths) {
    const endpoint = `${provider.baseURL}${path.startsWith('/') ? path : `/${path}`}`
    try {
      payload = await postJSON(ctx, endpoint, provider.key, body, signal, timeoutMs)
      break
    } catch (error) {
      const status = errorStatus(error)
      if (status === 404 || status === 405 || status === 501) {
        lastError = error
        continue
      }
      throw error
    }
  }
  if (!payload) {
    throw new Error(
      `media_gen_video: no working video endpoint for provider "${provider.id}"` +
        (lastError ? ` (${lastError.message})` : '')
    )
  }

  const media = await resolveVideoResult(ctx, exec, cfg, provider, payload, signal)
  const saved = await saveMedia(ctx, exec, cfg, media.bytes, media.mime, media.ext, 'video')
  return { saved, provider, model }
}

// ---------------------------------------------------------------------------
// web routes
// ---------------------------------------------------------------------------

function registerRoutes(ctx, config) {
  const mediaStore = new Map()
  const MAX_STORE = 500
  const remember = (saved) => {
    mediaStore.set(saved.name, { abs: saved.abs, mime: saved.mime })
    while (mediaStore.size > MAX_STORE) {
      const oldest = mediaStore.keys().next().value
      if (oldest === undefined) break
      mediaStore.delete(oldest)
    }
  }

  const displayHost =
    (config.displayHost && config.displayHost.trim()) ||
    `http://127.0.0.1:${ctx.webServer?.port ?? 3080}`
  const videoUrl = (saved) =>
    `${displayHost}/media-gen/raw/${encodeURIComponent(saved.name)}`
  const imageUrl = (saved) =>
    `${displayHost}/media-gen/raw/${encodeURIComponent(saved.name)}`
  const imageMarkdown = (saved, alt) =>
    `![${alt}](${imageUrl(saved)})`
  const videoMarkdown = (saved, alt) =>
    `[🎬 ${alt}](${videoUrl(saved)})`

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  ctx.webServer.register({
    name: 'dsh-media-gen-config',
    kind: 'exact',
    path: '/media-gen/config',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return send(res, 403, { error: 'request refused: loopback only' })
      try {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          await writeConfig(ctx, body)
        }
        send(res, 200, { config: currentConfig(ctx, config) })
      } catch (error) {
        send(res, error?.status === 413 ? 413 : 400, { error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-media-gen-providers',
    kind: 'exact',
    path: '/media-gen/providers',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return send(res, 403, { error: 'request refused: loopback only' })
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const probe = url.searchParams.get('probe') === '1'
        const providers = await listProviders(ctx, { probe, signal: AbortSignal.timeout(30000) })
        send(res, 200, { providers })
      } catch (error) {
        send(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  // Resolve a generated media filename back to its absolute path on disk.
  // Used by the right-click → "引用" menu to insert the local path into the
  // conversation input.
  ctx.webServer.register({
    name: 'dsh-media-gen-path',
    kind: 'exact',
    path: '/media-gen/path',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return send(res, 403, { error: 'request refused: loopback only' })
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const id = decodeURIComponent(url.searchParams.get('name') || '')
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
          send(res, 400, { error: 'bad media id' })
          return
        }
        let abs = ''
        const mem = mediaStore.get(id)
        if (mem && typeof mem.abs === 'string') abs = mem.abs
        if (!abs) {
          const files = await readMediaIndex()
          if (files[id] && typeof files[id].abs === 'string') abs = files[id].abs
        }
        if (!abs) {
          const cfg = currentConfig(ctx, config)
          const rawDir = String(cfg.outputDir || 'media_gen').trim()
          const candidates = []
          if (isAbsolute(rawDir)) candidates.push(resolve(rawDir, id))
          else {
            candidates.push(resolve(process.cwd(), rawDir, id))
            candidates.push(resolve(process.cwd(), 'media_gen', id))
          }
          for (const candidate of candidates) {
            try {
              await readFile(candidate)
              abs = candidate
              break
            } catch {
              // try next candidate
            }
          }
        }
        if (!abs) {
          send(res, 404, { error: 'not found' })
          return
        }
        send(res, 200, { name: id, path: abs })
      } catch (error) {
        send(res, 500, { error: String(error?.message ?? error) })
      }
    },
  })

  ctx.webServer.register({
    name: 'dsh-media-gen-raw',
    kind: 'prefix',
    path: '/media-gen/raw',
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('loopback only')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
        // Only plain file names: historical links must never become a path
        // traversal vector.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('bad media id')
          return
        }
        let entry = mediaStore.get(id)
        if (!entry) {
          // Server restart: fall back to the durable index so old session
          // images/videos stay visible.
          const files = await readMediaIndex()
          const indexed = files[id]
          if (indexed && typeof indexed.abs === 'string' && typeof indexed.mime === 'string') {
            entry = indexed
          }
        }
        if (!entry) {
          // Pre-index files (generated before the durable index existed): try
          // the configured output dir and the default media_gen directory.
          const cfg = currentConfig(ctx, config)
          const rawDir = String(cfg.outputDir || 'media_gen').trim()
          const candidates = []
          if (isAbsolute(rawDir)) {
            candidates.push(resolve(rawDir, id))
          } else {
            candidates.push(resolve(process.cwd(), rawDir, id))
            candidates.push(resolve(process.cwd(), 'media_gen', id))
          }
          for (const abs of candidates) {
            try {
              const bytes = await readFile(abs)
              const mime = MIME_BY_EXT[extname(abs).toLowerCase()] || 'application/octet-stream'
              entry = { abs, mime }
              break
            } catch {
              // try next candidate
            }
          }
        }
        if (!entry) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        const bytes = await readFile(entry.abs)
        res.writeHead(200, {
          'content-type': entry.mime,
          'content-length': bytes.length,
          'cache-control': 'no-cache',
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error))
      }
    },
  })

  return { remember, imageMarkdown, videoMarkdown, videoUrl, imageUrl }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function renderProvidersReport(providers) {
  if (!providers.length) {
    return (
      '✅ 已扫描 DSH 模型配置：暂未发现可用的 OpenAI 兼容 Provider。\n' +
      '请在「设置 → 模型」里添加一个 OpenAI 兼容渠道（例如 agnes-ai / openrouter），' +
      '并确保提供 baseURL / apiKeyEnv，且模型列表包含图片或视频模型，然后重试。'
    )
  }
  const lines = ['✅ DSH 模型配置中的 OpenAI 兼容 Provider：']
  for (const p of providers) {
    const models = p.models.length ? p.models.map((m) => m.id).join(' / ') : '（未配置模型，可点“刷新模型列表”拉取）'
    lines.push(`- ${p.id}（${p.name}${p.hasKey ? '' : '，⚠️ 未配 API Key'}）: ${models}`)
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  // Serve the dsh-media-gen settings namespace. Without this, the settings UI
  // reports "settings namespace 'dsh-media-gen' is not registered" and the
  // section/card is hidden.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sctx) => {
      try {
        sctx.settings.register(
          NS,
          Config,
          {
            base: {
              outputDir: config.outputDir || 'media_gen',
              imageProvider: config.imageProvider || '',
              imageModel: config.imageModel || '',
              imageEditProvider: config.imageEditProvider || '',
              imageEditModel: config.imageEditModel || '',
              videoProvider: config.videoProvider || '',
              videoModel: config.videoModel || '',
              videoEndpoint: config.videoEndpoint || '',
              timeoutMs: config.timeoutMs || 120000,
              videoTimeoutMs: config.videoTimeoutMs || 600000,
            },
          },
        )
      } catch (error) {
        console.error(`[dsh-media-gen] settings namespace skipped: ${error}`)
      }
    })
  }

  const routes = registerRoutes(ctx, config)

  const toolOutput = {
    schema: { type: 'string' },
    render: (_a, value) => [{ type: 'text', text: value }],
  }

  // Structured video result. The assistant reply should render the video with a
// dsh-ui fence (GenUI video component); the client tool.call.toolview stays as
// an additional fallback for tool-result rendering.
  const videoOutput = {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        type: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        mime: { type: 'string' },
        message: { type: 'string' },
      },
    },
    render: (_a, value) => {
      const url = value && typeof value.url === 'string' ? value.url : ''
      const path = value && typeof value.path === 'string' ? value.path : ''
      const lines = [`视频地址：${url}`]
      if (path) lines.push(`已保存：${path}`)
      if (value && typeof value.provider === 'string') {
        lines.push(`Provider：${value.provider}${value.model ? `，模型：${value.model}` : ''}`)
      }
      lines.push('请在回复正文中用 dsh-ui 视频组件显示视频（不要写 HTML/链接）')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  // ── Tool: list configured providers/models ─────────────────────────────
  ctx.tools.register(defineTool({
    name: 'media_list_providers',
    description: 'List the OpenAI-compatible providers and models configured in DSH Model settings that can be used for image/video generation. Use this before generating when the user asks which providers/models are available or after they changed model settings. Optional probe=true fetches /models from each provider to refresh the model list (slower).',
    parameters: {
      probe: { type: 'boolean', description: 'Whether to query each provider /models endpoint to refresh the model list (default false).' },
    },
    output: toolOutput,
    async execute(args, exec) {
      const providers = await listProviders(ctx, { probe: args.probe === true, signal: exec.signal })
      return renderProvidersReport(providers)
    },
  }))

  // ── Tool: text-to-image ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'media_gen_image',
    description: 'Generate an image from text using the OpenAI-compatible image model configured for this plugin (Settings → 媒体生成 → 文生图). The generated file is saved into the current workspace media_gen directory (configurable). The tool result contains the exact markdown image line inside a code block: you MUST copy that line VERBATIM (without the surrounding code fences) into your reply text so the image renders inline in the chat. Do NOT call vision_present, read_image, show_image_file or any other tool to display this image — the markdown line you copy into your reply is the display mechanism. Optional provider/model override a single call; size accepts e.g. 1024x1024 or 16:9.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image description / prompt (English usually works best).' },
      provider: { type: 'string', description: 'Optional provider id from DSH Model settings (overrides the configured text-to-image provider).' },
      model: { type: 'string', description: 'Optional model id for that provider (overrides the configured text-to-image model).' },
      size: { type: 'string', description: 'Optional size/aspect, e.g. 1024x1024 or 16:9. Omit to use the gateway default.' },
    },
    output: toolOutput,
    async execute(args, exec) {
      const { saved, provider, model } = await generateImageTool(exec, args, ctx, config, 'text')
      routes.remember(saved)
      const markdown = routes.imageMarkdown(saved, '生成的图片')
      return (
        `已生成图片。\n` +
        `图片地址：${routes.imageUrl(saved)}\n` +
        `请在回复正文中原样插入下面这行（不要包含代码块标记）以在聊天中显示图片：\n` +
        '```\n' + markdown + '\n```\n' +
        `不要调用 vision_present / read_image / show_image_file 等工具展示，直接在回复中插入即可。\n` +
        `（Provider：${provider.id}，模型：${model}）`
      )
    },
  }))

  // ── Tool: image-to-image (edits) ───────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'media_edit_image',
    description: 'Edit / transform an existing image using the OpenAI-compatible image edit model configured for this plugin (Settings → 媒体生成 → 图生图). Sends the image to the provider /images/edits endpoint and saves the result into media_gen. image accepts a local path (relative to the current workspace) or an http(s) URL. The tool result contains the exact markdown image line inside a code block: copy it VERBATIM (without the surrounding code fences) into your reply so the image renders inline. Do NOT call vision_present, read_image, show_image_file or any other tool to display this image — the markdown line you copy into your reply is the display mechanism. Optional provider/model override a single call; size accepts e.g. 1024x1024.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Instruction describing the edit, e.g. "make it a watercolor painting".' },
      image: { type: 'string', required: true, description: 'Local file path or http(s) URL of the source image.' },
      provider: { type: 'string', description: 'Optional provider id from DSH Model settings (overrides the configured image-to-image provider).' },
      model: { type: 'string', description: 'Optional model id for that provider (overrides the configured image-to-image model).' },
      size: { type: 'string', description: 'Optional output size, e.g. 1024x1024. Omit to use the gateway default.' },
    },
    output: toolOutput,
    async execute(args, exec) {
      const { saved, provider, model } = await generateImageTool(exec, args, ctx, config, 'edit')
      routes.remember(saved)
      const markdown = routes.imageMarkdown(saved, '生成的图片')
      return (
        `已生成图片。\n` +
        `图片地址：${routes.imageUrl(saved)}\n` +
        `请在回复正文中原样插入下面这行（不要包含代码块标记）以在聊天中显示图片：\n` +
        '```\n' + markdown + '\n```\n' +
        `不要调用 vision_present / read_image / show_image_file 等工具展示，直接在回复中插入即可。\n` +
        `（Provider：${provider.id}，模型：${model}）`
      )
    },
  }))

  // ── Tool: video generation ─────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'media_gen_video',
    description: 'Generate a video from text (or from an image when image is provided) using the OpenAI-compatible video model configured for this plugin (Settings → 媒体生成 → 视频生成). Uses /videos (or /videos/generations) with async status polling when needed. image accepts a local path (relative to the current workspace) or an http(s) URL; local files and loopback URLs are automatically converted to a base64 data URL so a just-generated local image can be used for image-to-video. The generated file is saved into the current workspace media_gen directory (configurable), and the tool result provides url/path/mime. In your final reply, render the video by calling the DSH built-in render_ui tool with this GenUI spec: {"type":"video","src":"<url value from the tool result>"} — the render_ui tool turns it into a playable video card. If render_ui is unavailable, emit exactly this dsh-ui code fence instead: ```dsh-ui {"type":"video","src":"<url value from the tool result>"} ```. Do NOT write raw <video> HTML. Optional provider/model override a single call; duration (seconds) and size/resolution are passed through when supported by the gateway.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Video description / prompt (English usually works best).' },
      image: { type: 'string', description: 'Optional source image for image-to-video: local path, http(s) URL, or the just-generated image path/loopback URL from media_gen_image.' },
      provider: { type: 'string', description: 'Optional provider id from DSH Model settings (overrides the configured video provider).' },
      model: { type: 'string', description: 'Optional model id for that provider (overrides the configured video model).' },
      duration: { type: 'number', description: 'Optional video duration in seconds, if the gateway supports it.' },
      size: { type: 'string', description: 'Optional resolution/size, e.g. 1280x720, if the gateway supports it.' },
      resolution: { type: 'string', description: 'Optional resolution hint, if the gateway supports it.' },
    },
    output: videoOutput,
    timeoutMs: 900000,
    async execute(args, exec) {
      const { saved, provider, model } = await generateVideoTool(exec, args, ctx, config)
      routes.remember(saved)
      return {
        type: 'video',
        url: routes.videoUrl(saved),
        path: saved.abs,
        provider: provider.id,
        model,
        mime: saved.mime,
        message: '视频已生成并保存到磁盘',
      }
    },
  }))
}