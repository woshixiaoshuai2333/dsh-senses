// 五个工具的对外定义。
//
// 设计原则：
//   * 参数少而直白，模型不用猜
//   * 返回里一定有「这次用的哪个模型 / 是不是降级了」
//   * 生成类工具只返回文件路径，不返回二进制（DSH 的图片块需要 attachment 服务，工具里造不出来）

import path from 'node:path'
import { defineTool } from './schema.js'
import { execute as runChain } from './chain.js'
import { loadSync, outputDirOf } from './config.js'
import { stamp } from './media.js'

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '模型给出的文字结果' },
      files: { type: 'array', items: { type: 'string' }, description: '生成的文件在本机的绝对路径' },
      model: { type: 'string', description: '实际使用的模型' },
      provider: { type: 'string', description: '实际使用的服务商' },
      note: { type: 'string', description: '补充说明，比如为什么换了备用模型' },
      cost: { type: 'number', description: '估算花费（元），只有视频生成会给' },
    },
  },
  render(args, value) {
    const blocks = []
    const lines = []

    if (value.text) lines.push(String(value.text))
    if (Array.isArray(value.files) && value.files.length > 0) {
      lines.push(value.files.map((f) => `文件：${f}`).join('\n'))
    }
    if (value.note) lines.push(`（${value.note}）`)

    blocks.push({ type: 'text', text: lines.join('\n\n') })
    return blocks
  },
}

function noteFor(result) {
  if (!result.degraded) return undefined
  const first = result.attempts?.[0]
  const reason = first ? `${first.provider}/${first.model} 没成功（${first.error}）` : '首选模型没成功'
  return `${reason}，这次自动换成了 ${result.providerLabel} 的 ${result.model}`
}

function baseResult(result, extra = {}) {
  const note = noteFor(result)
  return {
    model: result.model,
    provider: result.provider,
    ...(note ? { note } : {}),
    ...(result.cost ? { cost: result.cost } : {}),
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// listen：听声音
// ---------------------------------------------------------------------------

const listen = defineTool({
  name: 'listen',
  description:
    '听一段音频：转成文字，或者回答关于这段音频的问题。' +
    'source 可以是本地文件路径（wav/mp3/m4a 等）或公网链接。' +
    '不带 question 时只做逐字转写（快、便宜）；带 question 时用能听声音的模型边听边答，' +
    '适合问「几个人在说话」「语气是高兴还是生气」「背景里有什么声音」这类。',
  parameters: {
    source: { type: 'string', required: true, description: '音频的本地路径或公网链接' },
    question: { type: 'string', description: '想了解什么。不填就只转写文字' },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 300000,
  async execute(args, exec) {
    const config = loadSync()
    const hasQuestion = Boolean(args.question && String(args.question).trim())
    // 有问题的走 hear_qa（能听声音的多模态模型），没问题的走 hear（专用转写，更准更便宜）
    const capability = hasQuestion ? 'hear_qa' : 'hear'
    const result = await runChain(
      capability,
      { source: args.source, question: args.question, stamp: stamp() },
      config,
      exec?.signal,
    )

    const text = result.transcript && result.text && result.transcript !== result.text
      ? `${result.text}\n\n转写原文：\n${result.transcript}`
      : result.text

    return { ...baseResult(result), text }
  },
})

// ---------------------------------------------------------------------------
// watch_video：看视频
// ---------------------------------------------------------------------------

const watchVideo = defineTool({
  name: 'watch_video',
  description:
    '看一段视频，回答关于视频内容的问题。' +
    'source 可以是本地文件路径或公网链接。' +
    '公网链接会整个发给模型；本地文件需要先抽成一组按时间排列的画面（要本机有 ffmpeg，DSH 一般自带），所以也能看到过程而不只是一个定格。' +
    '适合问「这个视频讲什么」「画面里的人在做什么」「最后发生了什么」。',
  parameters: {
    source: { type: 'string', required: true, description: '视频的本地路径或公网链接' },
    question: { type: 'string', description: '想了解什么。不填就按时间顺序描述整个过程' },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 600000,
  async execute(args, exec) {
    const config = loadSync()
    const result = await runChain('see', { source: args.source, question: args.question }, config, exec?.signal)
    return { ...baseResult(result), text: result.text }
  },
})

// ---------------------------------------------------------------------------
// generate_image：文生图
// ---------------------------------------------------------------------------

const generateImage = defineTool({
  name: 'generate_image',
  description:
    '根据文字描述生成图片，返回图片保存在本机的路径。' +
    '描述越具体越好：主体、动作、环境、光线、风格。' +
    '尺寸写「宽x高」，比如 1024x1024、1328x1328。',
  parameters: {
    prompt: { type: 'string', required: true, description: '画面描述' },
    size: { type: 'string', description: '图片尺寸，格式 宽x高，例如 1024x1024' },
    count: { type: 'integer', minimum: 1, maximum: 4, description: '生成几张，默认 1，最多 4 张（每张都要花钱）' },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 300000,
  async execute(args, exec) {
    const config = loadSync()
    const result = await runChain(
      'image_gen',
      { prompt: args.prompt, size: args.size, count: args.count, stamp: stamp() },
      config,
      exec?.signal,
    )
    return {
      ...baseResult(result),
      text: `画好了，共 ${result.files.length} 张。`,
      files: result.files,
    }
  },
})

// ---------------------------------------------------------------------------
// generate_video：文生视频
// ---------------------------------------------------------------------------

const generateVideo = defineTool({
  name: 'generate_video',
  description:
    '根据文字描述生成一段短视频，返回视频保存在本机的路径。' +
    '这个操作要花钱，而且慢（通常一到三分钟），所以先确认用户真的要生成再调。' +
    '秒数默认 5、最多 10（一秒约 0.45 元起）；分辨率 480P 最便宜。',
  parameters: {
    prompt: { type: 'string', required: true, description: '画面描述，包含主体、动作、镜头、氛围' },
    seconds: { type: 'integer', minimum: 1, maximum: 10, description: '视频长度（秒），默认 5，最多 10' },
    resolution: { type: 'string', enum: ['480P', '720P', '1080P'], description: '分辨率，默认 480P' },
    ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: '画面比例，默认 16:9' },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 1200000,
  async execute(args, exec) {
    const config = loadSync()
    const result = await runChain(
      'video_gen',
      {
        prompt: args.prompt,
        seconds: args.seconds,
        resolution: args.resolution,
        ratio: args.ratio,
        stamp: stamp(),
      },
      config,
      exec?.signal,
    )

    const costText = typeof result.cost === 'number' ? `，大约花了 ${result.cost} 元` : ''
    return {
      ...baseResult(result),
      text: `视频生成好了${costText}。`,
      files: result.files,
    }
  },
})

// ---------------------------------------------------------------------------
// speak：文字转语音
// ---------------------------------------------------------------------------

const speak = defineTool({
  name: 'speak',
  description:
    '把一段文字合成语音文件，返回音频在本机的路径。' +
    '注意：只是生成一个音频文件，DSH 界面里不会自动播放，需要用户自己去点开。' +
    '所以只在用户明确要「生成一段语音」时才用，别拿它代替正常回话。',
  parameters: {
    text: { type: 'string', required: true, description: '要念出来的文字' },
    voice: {
      type: 'string',
      description: '音色名，两个服务商不一样：千问用 Cherry、Serena 这类名字；Windows 本地用「Microsoft Huihui Desktop」这类系统音色名。不填就用默认音色',
    },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 300000,
  async execute(args, exec) {
    const config = loadSync()
    const result = await runChain(
      'speak',
      { text: args.text, voice: args.voice, stamp: stamp() },
      config,
      exec?.signal,
    )
    const voiceName = result.voice || result.model
    return {
      ...baseResult(result),
      text: `语音生成好了，音色 ${voiceName}。`,
      files: result.files,
    }
  },
})

export const ALL_TOOLS = [listen, watchVideo, generateImage, generateVideo, speak]

export function toolSummary() {
  return ALL_TOOLS.map((tool) => ({ name: tool.name, description: tool.description.split('。')[0] }))
}