// 给设置页用的几个 HTTP 接口。
//
// 前缀统一是 /dsh-senses，所以在 DSH 的 webServer 里注册一次 prefix 路由，
// 内部再按路径分派 —— 注册面积越小，跟别的插件撞车的机会就越少。
//
//   GET  /dsh-senses/api/config    读配置（key 脱敏）
//   POST /dsh-senses/api/config    写配置
//   GET  /dsh-senses/api/status    环境自检（ffmpeg、key、降级链）
//
// 所有异常都就地吞掉并返回 JSON 错误，绝不让宿主崩。

import os from 'node:os'
import { cleanChain, configPath, loadSync, normalize, outputDirOf, parseChainEntry, providerKey, resolveChain, save, DEFAULT_CHAINS } from './config.js'
import { findFfmpeg } from './media.js'

const PREFIX = '/dsh-senses'
const CAPABILITY_LABELS = {
  see: '看视频',
  hear: '听声音',
  hear_qa: '听声音并回答',
  image_gen: '生成图片',
  video_gen: '生成视频',
  speak: '文字转语音',
}

// 允许改的 provider 字段。别的字段一概不认，免得攻击者往里塞东西。
const PROVIDER_FIELDS = new Set(['apiKey', 'voice', 'rate', 'compatibleBase', 'nativeBase', 'base'])
// 这几个字段决定「key 发到哪」，改它们的 host 等于把 key 送到别人的服务器。
const BASE_FIELDS = ['compatibleBase', 'nativeBase', 'base']

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
  res.end(JSON.stringify(body))
}

/**
 * 校验请求来源。
 *
 * 这个接口只监听 127.0.0.1，但「只监听本机」挡不住浏览器：
 * 用户随便打开一个网页，那个网页的 JS 也能连 127.0.0.1 —— 能不能读响应才由
 * CORS 决定。所以这里必须自己校验 Origin，并且不返回通配的 ACAO。
 *
 * 放行的来源：DSH 自己是 dsh-app:// 协议、界面同源时可能没有 Origin、
 * 以及本机 127.0.0.1 / localhost（开发调试用）。
 */
function originAllowed(origin) {
  if (!origin) return true
  if (origin.startsWith('dsh-app://')) return true
  if (origin === 'null') return true
  try {
    const u = new URL(origin)
    const host = u.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

function corsHeaders(origin) {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-dsh-senses',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求内容太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求内容不是合法的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 只露头尾，够用户确认「填的是哪把 key」，又不至于把 key 打到页面上。 */
function mask(key) {
  if (!key) return ''
  if (key.length <= 10) return '***'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

function publicConfig(config) {
  const copy = JSON.parse(JSON.stringify(config))
  for (const providerId of Object.keys(copy.providers || {})) {
    const provider = copy.providers[providerId]
    if (!provider || typeof provider !== 'object') continue
    if ('apiKey' in provider) {
      provider.apiKeyMasked = mask(providerKey(config, providerId))
      provider.hasKey = Boolean(providerKey(config, providerId))
      provider.apiKey = ''
    }
  }
  return copy
}

function hostOf(urlText) {
  try {
    return new URL(String(urlText)).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 合并用户提交的改动；提交里是脱敏值或空就不动原来的 key。
 *  返回值里的 warnings 是「有东西被丢掉了」的提示，要一路回给页面。 */
function applyPatch(current, patch) {
  const warnings = []
  if (!patch || typeof patch !== 'object') return { config: current, warnings }

  for (const field of ['outputDir', 'ffmpegPath', 'framesPerSecond', 'maxFrames', 'frameWidth', 'videoTimeoutSeconds', 'imageTimeoutSeconds']) {
    if (patch[field] !== undefined && patch[field] !== '') current[field] = patch[field]
  }

  for (const providerId of Object.keys(patch.providers || {})) {
    const incoming = patch.providers[providerId]
    if (!incoming || typeof incoming !== 'object') continue

    const before = current.providers[providerId] || {}
    const next = { ...before }
    let providedKey = ''

    for (const [key, value] of Object.entries(incoming)) {
      // 白名单之外的字段一律不认
      if (!PROVIDER_FIELDS.has(key)) continue

      if (key === 'apiKey') {
        if (value === null) {
          delete next.apiKey // 显式清空
          continue
        }
        // 空字符串或脱敏值都表示「不改」
        if (!value || String(value).includes('…')) continue
        providedKey = String(value)
        next.apiKey = providedKey
        continue
      }

      next[key] = value
    }

    // 改地址 = 改「key 发到哪」。跨 host 时必须同时重填 key，
    // 否则一次悄悄改配置就足以把 key 送到别人的服务器。
    for (const field of BASE_FIELDS) {
      if (incoming[field] === undefined) continue
      const from = hostOf(before[field])
      const to = hostOf(incoming[field])
      if (from && to && from !== to && !providedKey) {
        throw new Error(
          `改「${field}」的地址会把 key 发到别的服务器（${from} → ${to}）。` +
            `确实要换的话，请把这一家的 key 在同一个表单里重新填一遍再保存。`,
        )
      }
    }

    current.providers[providerId] = next
  }

  for (const [capability, chain] of Object.entries(patch.chains || {})) {
    if (!Array.isArray(chain)) continue
    // 写错的行不能悄悄消失 —— 那样用户下次打开看到空的，会以为自己没填。
    // 这里记下来，跟着响应一起回给页面。
    const dropped = chain.filter((x) => !parseChainEntry(x)).map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    if (dropped.length > 0) {
      const label = CAPABILITY_LABELS[capability] || capability
      warnings.push(`「${label}」里有 ${dropped.length} 行写法不对，已忽略：${dropped.slice(0, 5).join('、')}`)
    }
    current.chains[capability] = cleanChain(chain)
  }

  return { config: current, warnings }
}

function buildStatus(config) {
  let ffmpeg
  try {
    ffmpeg = findFfmpeg(config)
  } catch {
    ffmpeg = undefined
  }

  const providers = {}
  for (const providerId of Object.keys(config.providers || {})) {
    providers[providerId] = {
      hasKey: Boolean(providerKey(config, providerId)),
      keyMasked: mask(providerKey(config, providerId)),
    }
  }

  const chains = {}
  for (const capability of Object.keys(DEFAULT_CHAINS)) {
    chains[capability] = {
      label: CAPABILITY_LABELS[capability] || capability,
      entries: resolveChain(config, capability).map((entry) => ({
        ...entry,
        label: entry.free ? `${entry.provider}（本地）` : entry.provider,
      })),
      raw: (config.chains && config.chains[capability]) || [],
    }
  }

  return {
    // 只露 ~ 开头的相对路径，不把完整家目录结构告诉接口调用方
    configFile: configPath().replace(os.homedir(), '~'),
    outputDir: outputDirOf(config),
    ffmpeg: ffmpeg ? { found: true, path: ffmpeg } : { found: false, path: '' },
    providers,
    chains,
    capabilities: CAPABILITY_LABELS,
  }
}

export function registerRoutes(ctx, log = () => {}) {
  const handler = async (req, res) => {
    const origin = (req.headers && req.headers.origin) || ''
    if (!originAllowed(origin)) {
      sendJson(res, 403, { error: '这个来源不允许访问设置接口' })
      return
    }
    const cors = corsHeaders(origin)

    let pathname = '/'
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      pathname = url.pathname
    } catch {
      sendJson(res, 400, { error: '地址解析失败' }, cors)
      return
    }

    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
      sendJson(res, 404, { error: '没有这个接口' }, cors)
      return
    }

    const route = pathname.slice(PREFIX.length) || '/'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...JSON_HEADERS, ...cors })
      res.end()
      return
    }

    try {
      if (route === '/api/config' && req.method === 'GET') {
        sendJson(res, 200, { config: publicConfig(loadSync()), defaults: DEFAULT_CHAINS }, cors)
        return
      }

      if (route === '/api/config' && req.method === 'POST') {
        const body = await readBody(req)
        const current = loadSync()
        const { config: next, warnings } = applyPatch(current, body && body.config ? body.config : body)
        const file = await save(next)
        log(`设置页保存了配置：${file}${warnings.length ? `（${warnings.length} 条提示）` : ''}`)
        sendJson(res, 200, { ok: true, config: publicConfig(loadSync()), warnings }, cors)
        return
      }

      if (route === '/api/status' && req.method === 'GET') {
        sendJson(res, 200, buildStatus(loadSync()), cors)
        return
      }

      sendJson(res, 404, { error: `没有这个接口：${route}` }, cors)
    } catch (err) {
      log(`接口 ${route} 出错：${err && err.message ? err.message : err}`)
      sendJson(res, 500, { error: err && err.message ? err.message : String(err) }, cors)
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}