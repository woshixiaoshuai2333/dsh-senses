// 智谱（BigModel）适配器 —— 可选扩展，默认配置里不启用。
//
// 覆盖：看图 / 看视频（原生视频输入，不用抽帧）/ 语音转写 / 文生图 / 文生视频
// 认证：Bearer，key 从 open.bigmodel.cn 控制台拿
//
// 为什么默认不启用：这家所谓「免费」的模型，看图看视频靠消耗赠送的 token 包、
// 转写靠扣「按次计费」的赠送次数，都不是真正 0 元，而且赠送额度有期限。
// 与其让用户以为在省钱、实际在悄悄花掉有限额度，不如默认只走千问。
//
// 想启用的话：在配置文件 ~/.dsh/dsh-senses/config.json 里给 providers.zhipu
// 补上 apiKey 和 base，再把某个能力的链写成 ["zhipu/<模型名>"] 即可。
// 实测可用的模型：glm-5.3-flash（看图/看视频）、glm-asr-2512（转写）、
// glm-4v-flash（只支持图片）、cogview-3-flash（生图）、cogvideox-3（生视频，慢且带水印）。

import fs from 'node:fs'
import path from 'node:path'
import { request, pickText } from '../http.js'
import { toDataUri, download, downloadImage, ensureDir, expandHome, MEDIA_EXTENSIONS } from '../media.js'
import { outputDirOf } from '../config.js'

export const id = 'zhipu'
export const label = '智谱（可选）'
export const free = false

export function hasKey(config) {
  return Boolean(config?.providers?.zhipu?.apiKey || process.env.ZHIPU_API_KEY)
}

function base(config) {
  return (config?.providers?.zhipu?.base || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
}

function headers(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}

const DEFAULT_SEE_PROMPT = '请描述这段视频里发生了什么。按时间顺序讲清楚：开头、中间、结尾分别是什么画面，人物的动作和表情如何变化。'

// 智谱这代模型里，实测只有下面这几个能原生吃下视频。
// glm-4v-flash 完全不吃（返回 500），glm-4.6v-flash 理论支持但一直 429。
const VIDEO_CAPABLE = new Set(['glm-5.3-flash', 'glm-4.6v-flash'])
// 直传上限：再大就不赌了，交给抽帧——抽帧反而更省 token。
const MAX_DIRECT_VIDEO_BYTES = 20 * 1024 * 1024
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i

// ---------------------------------------------------------------------------
// 看图 / 看视频
// ---------------------------------------------------------------------------

async function see(input, config, apiKey, signal) {
  const { source, question } = input
  const model = input.model
  const prompt = question || DEFAULT_SEE_PROMPT

  // 第一选择：模型原生吃得下视频就直接发。
  // 好处是这台机器有没有 ffmpeg 都能看本地视频，而且比抽帧看到的信息更全。
  if (VIDEO_CAPABLE.has(model)) {
    const direct = await seeDirect(source, config, model, apiKey, prompt, signal)
    if (direct) return direct
  }

  // 第二选择：抽帧成一组图片（模型不吃视频 / 文件太大 / 直传失败）
  const payload = await collectFrames(source, config, signal)

  try {
    const content = []
    for (const file of payload.files) {
      content.push({ type: 'image_url', image_url: { url: await toDataUri(file, { kind: '抽出来的画面', allow: MEDIA_EXTENSIONS.image }) } })
    }
    const step = payload.files.length > 1 ? (payload.duration / payload.files.length).toFixed(2) : payload.duration.toFixed(2)
    content.push({
      type: 'text',
      text:
        `上面是按时间顺序从一段约 ${payload.duration.toFixed(1)} 秒的视频里抽出的 ${payload.files.length} 张画面，` +
        `平均每 ${step} 秒一张。\n\n${prompt}`,
    })

    const json = await request(
      `${base(config)}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers(apiKey) },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          temperature: 0.3,
          // glm-5.3 是推理模型，思考过程也吃 completion 额度；
          // 不给大点的上限，正文会被砍成半句话。
          max_tokens: 3000,
        }),
        timeoutMs: 240000,
      },
      signal,
    )

    const msg = json.json?.choices?.[0]?.message || {}
    let text = typeof msg.content === 'string' ? msg.content.trim() : ''
    if (!text) text = pickText(msg) || pickText(json.json) || ''
    if (!text) throw new Error('智谱没有返回内容')

    return { text, model, provider: id, usage: json.json?.usage }
  } finally {
    payload.cleanup()
  }
}

/**
 * 试着把视频原样递给模型。成功返回结果，失败返回 null（让调用方退到抽帧）。
 * 这里故意不抛错：直传失败是很正常的事（模型不吃、文件太大），不是真的出错。
 */
async function seeDirect(source, config, model, apiKey, prompt, signal) {
  const remote = /^https?:\/\//i.test(source)
  let block

  if (IMAGE_EXT.test(source)) {
    // 本来就是张图，直接当图片发
    block = { type: 'image_url', image_url: { url: await toDataUri(source, { kind: '图片', allow: MEDIA_EXTENSIONS.image }) } }
  } else if (remote) {
    // 远程视频：先把网址递过去试试，不行下面会下载后抽帧
    block = { type: 'video_url', video_url: { url: source } }
  } else {
    // 先看大小再读文件：直接 readFileSync 一个 60MB 的视频会让这个进程多占 60MB
    const file = expandHome(source)
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      return null
    }
    if (size > MAX_DIRECT_VIDEO_BYTES) return null
    let bytes
    try {
      bytes = fs.readFileSync(file)
    } catch {
      return null
    }
    // 智谱的 video_url 要裸 base64，不带 data: 前缀（实测）
    block = { type: 'video_url', video_url: { url: bytes.toString('base64') } }
  }

  try {
    const json = await request(
      `${base(config)}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers(apiKey) },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
          temperature: 0.3,
          max_tokens: 3000,
        }),
        timeoutMs: 240000,
      },
      signal,
    )

    const msg = json.json?.choices?.[0]?.message || {}
    let text = typeof msg.content === 'string' ? msg.content.trim() : ''
    if (!text) text = pickText(msg) || pickText(json.json) || ''
    if (!text) return null

    return { text, model, provider: id, usage: json.json?.usage }
  } catch {
    // 直传失败很正常（模型临时不吃、网络抖动），交给抽帧兜底，不在这里炸
    return null
  }
}

/**
 * 把「本地文件」或「远程链接」统一变成一组按时间排好的图片。
 * 远程链接会先下载到临时目录，因为抽帧只能对本地文件做。
 */
async function collectFrames(source, config, signal) {
  const { findFfmpeg, extractFrames, makeTmpDir, rmDirQuiet } = await import('../media.js')

  const ffmpeg = findFfmpeg(config)
  if (!ffmpeg) {
    throw new Error(
      '这个视频没法直接发给模型（可能是文件太大或模型不支持），需要先用 ffmpeg 抽帧，但这台机器上没找到 ffmpeg。\n' +
        '三个办法，挑一个：\n' +
        '1. 在设置页填「ffmpeg 路径」，指向一个 ffmpeg.exe（免安装版解压出来就行，不用敲命令）；\n' +
        '2. 把视频传到网上拿到直链，用链接试试（链接不走抽帧）；\n' +
        '3. 把视频压小一点，20MB 以内通常能直接发给模型。',
    )
  }

  const workDir = makeTmpDir('zhipu-mm-')
  let localFile = source

  if (/^https?:\/\//i.test(source)) {
    const downloaded = path.join(workDir, `src${guessExt(source)}`)
    await download(source, downloaded, { signal })
    localFile = downloaded
  }

  try {
    const framesDir = path.join(workDir, 'frames')
    const { files, duration } = await extractFrames(localFile, config, ffmpeg, framesDir)
    return {
      files,
      duration,
      cleanup() {
        rmDirQuiet(workDir)
      },
    }
  } catch (err) {
    rmDirQuiet(workDir)
    throw err
  }
}

function guessExt(url) {
  const m = /\.(mp4|mov|m4v|webm|mkv|avi|flv)(\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : '.mp4'
}

// ---------------------------------------------------------------------------
// 语音转写
// ---------------------------------------------------------------------------

async function hear(input, config, apiKey, signal) {
  const { source, question } = input

  // 智谱只提供转写，不提供「音频问答」。带问题时先用 ASR 转出来，
  // 再把文字和问题一起丢给文本模型。
  const dataUri = await toDataUri(source, { maxBytes: config.maxAudioBytes, kind: '音频', allow: MEDIA_EXTENSIONS.audio })
  const { buffer, mime, filename } = dataUriToBlob(dataUri)

  const form = new FormData()
  form.append('model', input.model)
  form.append('file', new Blob([buffer], { type: mime }), filename)

  const res = await request(
    `${base(config)}/audio/transcriptions`,
    { method: 'POST', headers: headers(apiKey), body: form, timeoutMs: 180000 },
    signal,
  )

  const text = res.json?.text || pickText(res.json) || ''
  if (!String(text).trim()) throw new Error('智谱转写返回空内容')

  if (!question || !String(question).trim()) {
    return { text: String(text).trim(), model: input.model, provider: id }
  }

  const answer = await request(
    `${base(config)}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(apiKey) },
      body: JSON.stringify({
        model: 'glm-4.6-flash',
        messages: [
          {
            role: 'user',
            content: `下面是一段音频的逐字转写。请根据它回答问题。\n\n【转写】\n${String(text).trim()}\n\n【问题】\n${question}`,
          },
        ],
        temperature: 0.3,
      }),
      timeoutMs: 120000,
    },
    signal,
  )

  const msg = answer.json?.choices?.[0]?.message || {}
  return {
    text: (typeof msg.content === 'string' && msg.content.trim()) || pickText(msg) || String(text).trim(),
    transcript: String(text).trim(),
    model: input.model,
    provider: id,
  }
}

function dataUriToBlob(dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUri)
  if (!m) throw new Error('音频不是 data URI，智谱转写只接受本地文件')
  const mime = m[1]
  const buffer = Buffer.from(m[2], 'base64')
  const ext = mime.split('/')[1] || 'wav'
  return { buffer, mime, filename: `audio.${ext}` }
}

// ---------------------------------------------------------------------------
// 文生图
// ---------------------------------------------------------------------------

async function imageGen(input, config, apiKey, signal) {
  const body = { model: input.model, prompt: input.prompt }
  if (input.size) body.size = input.size

  const json = await request(
    `${base(config)}/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(apiKey) },
      body: JSON.stringify(body),
      timeoutMs: config.imageTimeoutSeconds * 1000,
    },
    signal,
  )

  const data = json.json?.data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`智谱生图没返回图片：${json.text.slice(0, 300)}`)
  }

  const dir = ensureDir(path.join(outputDirOf(config), `images-${input.stamp || Date.now()}`))
  const files = []
  for (let i = 0; i < data.length; i += 1) {
    const item = data[i]
    if (!item.url) continue
    files.push(await downloadImage(item.url, dir, String(i + 1).padStart(2, '0'), { signal }))
  }

  if (files.length === 0) throw new Error('智谱图片下载失败')
  return { files, model: input.model, provider: id, size: input.size }
}

// ---------------------------------------------------------------------------
// 文生视频
// ---------------------------------------------------------------------------

async function videoGen(input, config, apiKey, signal) {
  const seconds = Number(input.seconds) > 0 ? Number(input.seconds) : 5
  const body = {
    model: input.model,
    prompt: input.prompt,
    quality: 'speed',
    with_audio: false,
    fps: 30,
    duration: seconds <= 5 ? 5 : 10,
  }
  if (input.size) body.size = input.size

  const submit = await request(
    `${base(config)}/videos/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(apiKey) },
      body: JSON.stringify(body),
      timeoutMs: 120000,
    },
    signal,
  )

  const taskId = submit.json?.id
  if (!taskId) throw new Error(`智谱视频任务提交失败：${submit.text.slice(0, 300)}`)

  const deadline = Date.now() + config.videoTimeoutSeconds * 1000
  let last = 'PROCESSING'

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('已取消')
    await sleep(5000)
    const poll = await request(`${base(config)}/async-result/${taskId}`, { method: 'GET', headers: headers(apiKey), timeoutMs: 60000 }, signal)

    last = poll.json?.task_status || last
    if (last === 'SUCCESS') {
      const url = poll.json?.video_result?.[0]?.url
      if (!url) throw new Error('智谱任务成功但没给视频地址')
      const dest = path.join(ensureDir(path.join(outputDirOf(config), 'videos')), `${input.stamp || Date.now()}.mp4`)
      const { bytes } = await download(url, dest, { signal })
      return {
        files: [dest],
        model: input.model,
        provider: id,
        taskId,
        seconds,
        bytes,
        cost: 0,
      }
    }
    if (['FAIL', 'FAILED'].includes(last)) {
      throw new Error(`智谱视频任务失败：${poll.text.slice(0, 300)}`)
    }
  }

  throw new Error(`等智谱出片太久（超过 ${config.videoTimeoutSeconds} 秒），还在 ${last}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------

export async function execute(capability, input, config, apiKey, signal) {
  switch (capability) {
    case 'see':
      return see(input, config, apiKey, signal)
    case 'hear':
      return hear(input, config, apiKey, signal)
    case 'image_gen':
      return imageGen(input, config, apiKey, signal)
    case 'video_gen':
      return videoGen(input, config, apiKey, signal)
    default:
      throw new Error(`智谱不支持 ${capability}`)
  }
}