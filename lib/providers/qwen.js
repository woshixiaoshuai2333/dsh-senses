// 千问（阿里云百炼兼容接口）适配器。
//
// 覆盖：看图 / 看视频 / 语音转写 / 音频问答 / 文生图 / 文生视频 / 语音合成
// 认证：Bearer，key 来自配置或 QW_API_KEY
//
// 这个 provider 的特点是「同一家有两套接口」：
//   - 兼容模式 /compatible-mode/v1：chat/completions、images/generations（OpenAI 形状）
//   - 原生 /api/v1：multimodal-generation（转写、TTS）、video-generation（异步任务）

import path from 'node:path'
import { pickText, request } from '../http.js'
import {
  toDataUri,
  download,
  downloadImage,
  writeImage,
  ensureDir,
  findFfmpeg,
  extractFrames,
  makeTmpDir,
  rmDirQuiet,
  MEDIA_EXTENSIONS,
} from '../media.js'
import { outputDirOf } from '../config.js'

/**
 * 从 chat/completions 的响应里取出正文。
 * 兼容 content 为字符串、content 为块数组、内容落在 reasoning_content 三种情况。
 */
function outputFromChat(json, model, provider) {
  const msg = json?.choices?.[0]?.message || {}
  let text = typeof msg.content === 'string' ? msg.content.trim() : ''
  if (!text) text = pickText(msg) || ''
  if (!text) text = pickText(json) || ''
  if (!text) throw new Error('模型没有返回任何内容')
  return { text, model, provider, usage: json?.usage }
}

// 价格表：元/秒，只用于事后估算，不参与计费
export const VIDEO_PRICES = {
  'happyhorse-1.1-t2v': { '480P': 0.45, '720P': 0.9, '1080P': 1.2 },
  'happyhorse-1.0-t2v': { '480P': 0.45, '720P': 0.9, '1080P': 1.2 },
  'wan2.6-t2v': { '720P': 0.6, '1080P': 1.0 },
  'wan2.5-t2v-preview': { '720P': 0.6, '1080P': 1.0 },
  'wan2.2-t2v-plus': { '480P': 0.3, '1080P': 0.7 },
  'wanx2.1-t2v-plus': { '720P': 0.7 },
  'wanx2.1-t2v-turbo': { '480P': 0.24, '720P': 0.48 },
  'wan2.7-t2v': { '720P': 0.6, '1080P': 1.0 },
}

export function estimateVideoCost(model, resolution, seconds) {
  const table = VIDEO_PRICES[model]
  if (!table) return undefined
  const price = table[resolution] ?? table['720P'] ?? table['480P']
  if (!price) return undefined
  return Math.round(price * seconds * 100) / 100
}

const DEFAULT_SEE_PROMPT = '请描述这段视频里发生了什么。按时间顺序讲清楚：开头、中间、结尾分别是什么画面，人物的动作和表情如何变化。'

export const id = 'qwen'
export const label = '千问'
export const free = false

export function hasKey(config) {
  return Boolean(config?.providers?.qwen?.apiKey || process.env.QW_API_KEY)
}

function compatibleBase(config) {
  return (config?.providers?.qwen?.compatibleBase || 'https://maas.qianwenaiapi.com/compatible-mode/v1').replace(/\/+$/, '')
}

function nativeBase(config) {
  return (config?.providers?.qwen?.nativeBase || 'https://maas.qianwenaiapi.com/api/v1').replace(/\/+$/, '')
}

async function chat(config, apiKey, body, signal, timeoutMs = 180000) {
  const url = `${compatibleBase(config)}/chat/completions`
  const res = await request(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), timeoutMs },
    signal,
  )
  return res.json
}

// ---------------------------------------------------------------------------
// 看图 / 看视频
// ---------------------------------------------------------------------------

async function see(input, config, apiKey, signal) {
  const { source, question } = input
  const model = input.model

  const content = []

  if (/^https?:\/\//i.test(source)) {
    // 公网链接：直接把地址交给模型，它能按秒采样
    content.push({ type: 'video_url', video_url: { url: source } })
  } else {
    // 本地文件：上一轮实测过「base64 内联视频只给 2 帧」，
    // 所以这里先抽帧，再当一组图片发过去。
    const ffmpeg = findFfmpeg(config)
    if (!ffmpeg) {
      throw new Error(
        '看本地视频需要 ffmpeg，但这台机器上没找到。可以在设置里填 ffmpegPath，或者改用公网视频链接。',
      )
    }
    const tmp = makeTmpDir('dsh-senses-frames-')
    try {
      const { files, duration } = await extractFrames(source, config, ffmpeg, tmp)
      for (const file of files) {
        content.push({
          type: 'image_url',
          image_url: { url: await toDataUri(file, { kind: '抽出来的画面', allow: MEDIA_EXTENSIONS.image }) },
        })
      }
      const step = files.length > 1 ? (duration / files.length).toFixed(2) : duration.toFixed(2)
      content.push({
        type: 'text',
        text:
          `上面是按时间顺序从一段约 ${duration.toFixed(1)} 秒的视频里抽出的 ${files.length} 张画面，` +
          `平均每 ${step} 秒一张。\n\n${question || DEFAULT_SEE_PROMPT}`,
      })
    } finally {
      rmDirQuiet(tmp)
    }
  }

  if (content[content.length - 1]?.type !== 'text') {
    content.push({ type: 'text', text: question || DEFAULT_SEE_PROMPT })
  }

  const json = await chat(config, apiKey, {
    model,
    messages: [{ role: 'user', content }],
    enable_thinking: false,
  }, signal)

  return outputFromChat(json, model, id)
}

// ---------------------------------------------------------------------------
// 听声音
// ---------------------------------------------------------------------------

async function transcribe(input, config, apiKey, signal) {
  const { source } = input
  const dataUri = await toDataUri(source, {
    maxBytes: config.maxAudioBytes,
    kind: '音频',
    allow: MEDIA_EXTENSIONS.audio,
  })

  const json = await request(
    `${nativeBase(config)}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: input.model,
        input: { messages: [{ role: 'user', content: [{ audio: dataUri }] }] },
      }),
      timeoutMs: 180000,
    },
    signal,
  )

  const body = json.json || {}
  // 转写的正文固定在 output.choices[0].message.content[0].text
  const text =
    body?.output?.choices?.[0]?.message?.content?.[0]?.text ??
    pickText(body)

  if (!text || !String(text).trim()) {
    throw new Error('转写接口返回了空内容')
  }

  // annotations[0] 本身就是 audio_info
  const info = body?.output?.choices?.[0]?.message?.annotations?.[0] || {}

  return {
    text: String(text).trim(),
    language: info.language,
    emotion: info.emotion,
    model: input.model,
    provider: id,
  }
}

async function hear(input, config, apiKey, signal) {
  // 只转写：走原生 ASR 接口，最准也最便宜
  return transcribe(input, config, apiKey, signal)
}

async function hearQa(input, config, apiKey, signal) {
  const { source, question } = input

  const dataUri = await toDataUri(source, {
    maxBytes: config.maxAudioBytes,
    kind: '音频',
    allow: MEDIA_EXTENSIONS.audio,
  })

  const json = await chat(config, apiKey, {
    model: input.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: dataUri, format: audioFormatHint(source) } },
          { type: 'text', text: question },
        ],
      },
    ],
    enable_thinking: false,
  }, signal)

  return outputFromChat(json, input.model, id)
}

function audioFormatHint(source) {
  const ext = path.extname(String(source || '')).toLowerCase().replace('.', '')
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'].includes(ext)) return ext
  return 'wav'
}

// ---------------------------------------------------------------------------
// 文生图
// ---------------------------------------------------------------------------

async function imageGen(input, config, apiKey, signal) {
  // 第二道闸：schema 里已经限了 1..4，这里再夹一次，防止别的调用路径绕过去
  const count = Math.min(4, Math.max(1, Math.floor(Number(input.count) || 1)))

  const body = {
    model: input.model,
    prompt: input.prompt,
    n: count,
  }
  if (input.size) body.size = input.size

  const json = await request(
    `${compatibleBase(config)}/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      timeoutMs: config.imageTimeoutSeconds * 1000,
    },
    signal,
  )

  const data = json.json?.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('生图接口没有返回图片')
  }

  const dir = ensureDir(path.join(outputDirOf(config), `images-${input.stamp || Date.now()}`))
  const files = []
  for (let i = 0; i < data.length; i += 1) {
    const item = data[i]
    const baseName = String(i + 1).padStart(2, '0')
    if (item.url) {
      files.push(await downloadImage(item.url, dir, baseName, { signal }))
    } else if (item.b64_json) {
      const fsp = await import('node:fs/promises')
      files.push(await writeImage(Buffer.from(item.b64_json, 'base64'), dir, baseName))
    }
  }

  if (files.length === 0) throw new Error('图片下载失败')
  return { files, model: input.model, provider: id, size: input.size }
}

// ---------------------------------------------------------------------------
// 文生视频
// ---------------------------------------------------------------------------

async function videoGen(input, config, apiKey, signal) {
  const model = input.model
  const resolution = input.resolution || '480P'
  // 第二道闸：schema 里已经限了 1..10，这里再夹一次。
  // 视频按秒计价，秒数失控等于账单失控。
  const seconds = Math.min(10, Math.max(1, Math.floor(Number(input.seconds) || 5)))
  const ratio = input.ratio || '16:9'

  const submit = await request(
    `${nativeBase(config)}/services/aigc/video-generation/video-synthesis`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { prompt: input.prompt },
        parameters: { resolution, duration: seconds, ratio },
      }),
      timeoutMs: 120000,
    },
    signal,
  )

  const taskId = submit.json?.output?.task_id || submit.json?.task_id
  if (!taskId) throw new Error(`提交视频任务失败：${submit.text.slice(0, 300)}`)

  const deadline = Date.now() + config.videoTimeoutSeconds * 1000
  let lastStatus = 'PENDING'

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('已取消')
    await sleep(5000)
    const poll = await request(`${nativeBase(config)}/tasks/${taskId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: 60000,
    }, signal)

    const output = poll.json?.output || {}
    lastStatus = output.task_status || poll.json?.task_status || lastStatus

    if (lastStatus === 'SUCCEEDED') {
      const url = output.video_url || output.results?.[0]?.video_url
      if (!url) throw new Error('任务成功但没拿到视频地址')
      const dest = path.join(ensureDir(path.join(outputDirOf(config), 'videos')), `${input.stamp || Date.now()}.mp4`)
      const { bytes } = await download(url, dest, { signal })
      return {
        files: [dest],
        model,
        provider: id,
        taskId,
        resolution,
        seconds,
        bytes,
        cost: estimateVideoCost(model, resolution, seconds),
      }
    }

    if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(lastStatus)) {
      throw new Error(`视频任务失败（${lastStatus}）：${output.message || output.code || '没有更多信息'}`)
    }
  }

  throw new Error(`等视频太久（超过 ${config.videoTimeoutSeconds} 秒），任务还在 ${lastStatus}。可以稍后重试。`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 语音合成
// ---------------------------------------------------------------------------

async function speak(input, config, apiKey, signal) {
  const voice = input.voice || 'Cherry'
  const json = await request(
    `${nativeBase(config)}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: input.model,
        input: { text: input.text, voice },
      }),
      timeoutMs: 120000,
    },
    signal,
  )

  const url = json.json?.output?.audio?.url
  if (!url) throw new Error(`合成接口没返回音频地址：${json.text.slice(0, 300)}`)

  const dest = path.join(ensureDir(path.join(outputDirOf(config), 'audio')), `speech-${input.stamp || Date.now()}.wav`)
  const { bytes } = await download(url, dest, { signal })
  return { files: [dest], model: input.model, provider: id, bytes, voice }
}

// ---------------------------------------------------------------------------

export async function execute(capability, input, config, apiKey, signal) {
  switch (capability) {
    case 'see':
      return see(input, config, apiKey, signal)
    case 'hear':
      return hear(input, config, apiKey, signal)
    case 'hear_qa':
      return hearQa(input, config, apiKey, signal)
    case 'image_gen':
      return imageGen(input, config, apiKey, signal)
    case 'video_gen':
      return videoGen(input, config, apiKey, signal)
    case 'speak':
      return speak(input, config, apiKey, signal)
    default:
      throw new Error(`千问不支持 ${capability}`)
  }
}