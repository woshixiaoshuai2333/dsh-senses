// 配置的读写、默认值、迁移。
//
// 配置独立存在 ~/.dsh/dsh-senses/config.json，不写进 cordis.patch.yml。
// 原因：patch 文件是「插件装配清单」，DSH 可能重写它；配置是用户数据，
// 独立成文件后既方便用记事本手改，也方便设置页读写，卸载时删目录就干净了。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const PLUGIN_ID = 'dsh-senses'

// 早期版本叫过 qwen-mm，配置目录也随之不同。老用户升级时把配置搬过来，
// 不然填好的 key 和改过的降级链会凭空消失。
const LEGACY_PLUGIN_ID = 'qwen-mm'

export function configPath() {
  return path.join(os.homedir(), '.dsh', PLUGIN_ID, 'config.json')
}

export function configDir() {
  return path.join(os.homedir(), '.dsh', PLUGIN_ID)
}

function legacyConfigPath() {
  return path.join(os.homedir(), '.dsh', LEGACY_PLUGIN_ID, 'config.json')
}

/** 老目录里有配置、新目录里没有，就复制一份过来。失败一律当没发生。 */
function migrateLegacyConfig() {
  try {
    const target = configPath()
    if (fs.existsSync(target)) return
    const legacy = legacyConfigPath()
    if (!fs.existsSync(legacy)) return
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(legacy, target)
  } catch {
    // 迁移不了就算了，用户重新填一次 key 也能用
  }
}

export function outputDirOf(config) {
  const raw = config && config.outputDir ? String(config.outputDir) : `~/.dsh/${PLUGIN_ID}-output`
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/**
 * 每个能力的默认降级链。
 * 写法是 provider/model，排前面的先试，失败了自动往下掉。
 *
 * 默认全走千问。曾经的「智谱免费档」已经移除：那几家所谓免费的模型，
 * 看图/看视频靠消耗赠送的 token 包、转写靠扣「按次计费」的赠送次数，
 * 既不是真免费，也没有长期可靠的说法。与其让用户以为在省钱、实际在
 * 悄悄花掉有期限的额度，不如只留一条清楚的付费链。
 *
 * 唯一的例外是 speak 里的 sapi：那是 Windows 自带的本地语音合成，
 * 不联网、不花钱、不消耗任何额度，纯兜底，没有副作用。
 */
export const DEFAULT_CHAINS = {
  see: ['qwen/qwen3-vl-plus'],
  hear: ['qwen/qwen3-asr-flash'],
  hear_qa: ['qwen/qwen3.5-omni-plus'],
  image_gen: ['qwen/qwen-image-3.0'],
  video_gen: ['qwen/happyhorse-1.1-t2v'],
  speak: ['qwen/qwen3-tts-flash', 'sapi/sapi'],
}

/**
 * 默认输出目录：优先放到非系统盘，免得生成的大文件把 C 盘塞爆。
 * Windows 上按 D→E→F 找第一个存在的盘；都没有就回落到用户目录。
 */
export function defaultOutputDir() {
  if (process.platform === 'win32') {
    for (const letter of ['D', 'E', 'F']) {
      try {
        if (fs.existsSync(`${letter}:\\`)) {
          return path.join(`${letter}:\\`, 'dsh', `${PLUGIN_ID}-output`)
        }
      } catch {
        // 盘符存在但不让访问，跳过，试下一个
      }
    }
  }
  return `~/.dsh/${PLUGIN_ID}-output`
}

export function defaults() {
  return {
    version: 2,

    outputDir: defaultOutputDir(),
    ffmpegPath: '',

    // 本地视频抽帧参数
    framesPerSecond: 1,
    maxFrames: 16,
    frameWidth: 768,

    // 生成类超时
    videoTimeoutSeconds: 900,
    imageTimeoutSeconds: 180,

    // 单个媒体体积上限（字节）；超过就拒绝，避免把内存吃光
    maxAudioBytes: 20 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,

    providers: {
      qwen: {
        apiKey: '',
        compatibleBase: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
        nativeBase: 'https://maas.qianwenaiapi.com/api/v1',
      },
      sapi: {
        voice: 'auto',
        rate: 0,
      },
    },

    chains: JSON.parse(JSON.stringify(DEFAULT_CHAINS)),
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 解析一行 `provider/model`。
 * 返回 null 表示这行不合法 —— 分不清服务商和模型名，就别往下发请求。
 */
export function parseChainEntry(item) {
  const text = String(item == null ? '' : item).trim()
  if (!text) return null
  const slash = text.indexOf('/')
  if (slash <= 0) return null
  const provider = text.slice(0, slash).trim()
  const model = text.slice(slash + 1).trim()
  // model 里不该再有斜杠打头，`qwen//x` 这种是把 model 写成了 `/x`
  if (!provider || !model || model.startsWith('/')) return null
  return { provider, model }
}

/** 过滤一组链，只留合法的，顺便去重。 */
export function cleanChain(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    const parsed = parseChainEntry(item)
    if (!parsed) continue
    const text = `${parsed.provider}/${parsed.model}`
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function normalize(raw) {
  const base = defaults()
  const merged = deepMerge(base, isPlainObject(raw) ? raw : {})
  const userChains = isPlainObject(raw) && isPlainObject(raw.chains) ? raw.chains : {}

  // chains：用户显式写过的能力就按他写的来（哪怕是空数组 —— 那表示「我不用这个能力」），
  // 没写过的才补默认。以前一律补默认，用户把某一项清空后会发现它又冒出来了。
  merged.chains = isPlainObject(merged.chains) ? merged.chains : {}
  for (const [cap, chain] of Object.entries(DEFAULT_CHAINS)) {
    if (Object.prototype.hasOwnProperty.call(userChains, cap)) {
      merged.chains[cap] = Array.isArray(userChains[cap]) ? cleanChain(userChains[cap]) : []
    } else {
      merged.chains[cap] = chain.slice()
    }
  }

  // 旧版本有过 mode（auto/paid/free）字段，现在这一概念已经取消。
  // 老配置文件里如果留着，直接丢掉，免得用户看到不存在的开关。
  delete merged.mode

  // v1 → v2：取消免费档。老配置的链里如果还排着 zhipu/xxx，把它们摘掉，
  // 摘空了就补默认。同时删掉遗留的智谱 key，免得界面上显示一个用不上的配置。
  if (!merged.version || Number(merged.version) < 2) {
    for (const [cap, list] of Object.entries(merged.chains)) {
      const kept = (Array.isArray(list) ? list : []).filter((x) => !String(x).startsWith('zhipu/'))
      merged.chains[cap] = kept.length > 0 ? kept : (DEFAULT_CHAINS[cap] || []).slice()
    }
    if (merged.providers && typeof merged.providers === 'object') {
      delete merged.providers.zhipu
    }
    merged.version = 2
  }

  return merged
}

/**
 * 读配置。
 *
 * 「文件不存在」和「文件存在但坏了」必须分开处理：
 * 前者是正常的新装，用默认值；
 * 后者要是也默默用默认值，用户就会看到「key 还没填」，然后去设置页点一次保存，
 * 把原来填好的配置整份覆盖掉 —— 那是真的丢数据。
 */
export class ConfigError extends Error {
  constructor(message, file) {
    super(message)
    this.name = 'ConfigError'
    this.file = file
  }
}

function readConfigText() {
  const file = configPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, text: undefined }
    throw new ConfigError(`读不了配置文件 ${file}：${err && err.message ? err.message : err}`, file)
  }
  return { file, text }
}

export function loadSync() {
  migrateLegacyConfig()
  const { file, text } = readConfigText()
  if (text === undefined) return normalize({})
  if (!text.trim()) return normalize({})
  try {
    return normalize(JSON.parse(text))
  } catch (err) {
    throw new ConfigError(
      `配置文件坏掉了：${file}\n里面不是合法的 JSON（${err && err.message ? err.message : err}）。\n` +
        `修好之前不要点保存，否则现在的内容会被覆盖。可以先把这个文件改个名，再重新配置。`,
      file,
    )
  }
}

export async function load() {
  migrateLegacyConfig()
  let text
  const file = configPath()
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return normalize({})
    throw new ConfigError(`读不了配置文件 ${file}：${err && err.message ? err.message : err}`, file)
  }
  if (!text.trim()) return normalize({})
  try {
    return normalize(JSON.parse(text))
  } catch (err) {
    throw new ConfigError(
      `配置文件坏掉了：${file}\n里面不是合法的 JSON（${err && err.message ? err.message : err}）。`,
      file,
    )
  }
}

/** 写配置前先把旧文件备份一份（config.json.bak），覆盖错了还能捞回来。 */
export async function save(config) {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })

  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  } catch {
    // 备份失败不拦着保存
  }

  const text = `${JSON.stringify(normalize(config), null, 2)}\n`
  await fsp.writeFile(file, text, 'utf8')
  return file
}

/**
 * 从 ~/.dsh/.credentials.yaml 里读一个 key。
 * 只做最朴素的 `NAME: value` 匹配，不引入 YAML 解析器。
 */
export function readCredential(name, file) {
  const target = file || path.join(os.homedir(), '.dsh', '.credentials.yaml')
  try {
    const text = fs.readFileSync(target, 'utf8')
    const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'm')
    const m = pattern.exec(text)
    if (!m) return undefined
    return m[1].replace(/^["']|["']$/g, '').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 provider 的 key：配置里填了就用配置，否则回落到环境变量和凭据文件。
 */
export function providerKey(config, provider) {
  const fromConfig = config?.providers?.[provider]?.apiKey
  if (fromConfig) return fromConfig

  if (provider === 'qwen') {
    return process.env.QW_API_KEY || readCredential('QW_API_KEY')
  }
  if (provider === 'zhipu') {
    return process.env.ZHIPU_API_KEY || readCredential('ZHIPU_API_KEY')
  }
  return undefined
}

/**
 * 把配置里的 chains 解析成「可以挨个试」的列表。
 * 不再按档位过滤——档位这个概念已经取消，链上写什么就试什么。
 */
export function resolveChain(config, capability) {
  const chain = config?.chains?.[capability] || DEFAULT_CHAINS[capability] || []

  const entries = []
  for (const item of chain) {
    const parsed = parseChainEntry(item)
    if (!parsed) continue
    entries.push({ provider: parsed.provider, model: parsed.model, free: parsed.provider === 'sapi' })
  }

  return entries
}

/** 用户在这一项上到底填了几行（不管合不合法），用来把报错说清楚。 */
export function rawChainLength(config, capability) {
  const chain = config?.chains?.[capability]
  return Array.isArray(chain) ? chain.length : 0
}