// 统一的 HTTP 请求封装。
//
// 为什么要自己包一层：
//   1. 千问/智谱/Edge 的错误体格式各不相同，需要统一成一句人话
//   2. 超时要能打断（用 AbortSignal）
//   3. 响应有时是 JSON、有时是二进制、有时是空体，得容错

/**
 * 把各家返回的错误体压成一句话。
 */
function describeError(status, json, text) {
  if (json) {
    const parts = []
    if (json.error && typeof json.error === 'object') {
      if (json.error.code) parts.push(`[${json.error.code}]`)
      if (json.error.message) parts.push(json.error.message)
      if (parts.length === 0) parts.push(JSON.stringify(json.error).slice(0, 400))
    } else if (typeof json.error === 'string') {
      parts.push(json.error)
    }
    if (json.code && !parts.some((p) => p.includes(json.code))) parts.push(`[${json.code}]`)
    if (json.message && !parts.some((p) => p.includes(json.message))) parts.push(json.message)
    if (json.msg && !parts.some((p) => p.includes(json.msg))) parts.push(json.msg)
    if (json.code_name) parts.push(`(${json.code_name})`)
    if (parts.length > 0) return `HTTP ${status} ${parts.join(' ')}`
  }
  const trimmed = String(text || '').trim()
  if (trimmed) return `HTTP ${status} ${trimmed.slice(0, 400)}`
  return `HTTP ${status}`
}

/**
 * @returns {Promise<{ status:number, ok:boolean, headers:Headers, json:any, text:string, bytes?:Uint8Array }>}
 * 当 expectations.as === 'binary' 时返回 bytes，否则返回 text/json。
 */
export async function request(url, options = {}, signal) {
  const { as = 'auto', timeoutMs = 180000, headers, ...rest } = options

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal && signal.reason ? signal.reason : new Error('请求被取消'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)

  try {
    const res = await fetch(url, { ...rest, headers, signal: controller.signal })

    if (as === 'binary') {
      const buffer = await res.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const text = new TextDecoder().decode(bytes.slice(0, 2000))
      let json
      if (!res.ok) {
        try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* 不是 JSON 就算了 */ }
        throw new Error(describeError(res.status, json, text))
      }
      return { status: res.status, ok: res.ok, headers: res.headers, json: undefined, text, bytes }
    }

    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }

    if (!res.ok) {
      throw new Error(describeError(res.status, json, text))
    }

    return { status: res.status, ok: res.ok, headers: res.headers, json, text }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 带 Bearer 的 JSON 请求。
 */
export async function postJson(url, body, apiKey, { signal, timeoutMs, extraHeaders } = {}) {
  return request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(body),
      timeoutMs,
    },
    signal,
  )
}

export async function getJson(url, apiKey, { signal, timeoutMs, extraHeaders } = {}) {
  return request(
    url,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      timeoutMs,
    },
    signal,
  )
}

/**
 * 从任意 JSON 结构里捞出第一段像样的文本。
 * 千问的 omni 系列经常把正文放在 reasoning_content，这里一并兜住。
 */
export function pickText(json, depth = 0) {
  if (json === null || json === undefined || depth > 10) return undefined

  if (typeof json === 'string') {
    const s = json.trim()
    return s ? s : undefined
  }

  if (Array.isArray(json)) {
    // 优先形如 [{ type:'text', text:'...' }] 的块
    for (const item of json) {
      if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) return item.text.trim()
    }
    for (const item of json) {
      const hit = pickText(item, depth + 1)
      if (hit) return hit
    }
    return undefined
  }

  if (typeof json === 'object') {
    // 常见字段名按优先级
    for (const key of ['output_text', 'text', 'content', 'reasoning_content', 'answer', 'result']) {
      const value = json[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    for (const key of ['choices', 'output', 'message', 'data', 'result', 'response']) {
      const hit = pickText(json[key], depth + 1)
      if (hit) return hit
    }
  }

  return undefined
}