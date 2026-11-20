// 降级链执行器。
//
// 每个能力在配置里排了一个队列，比如看视频是 ["qwen/qwen3-vl-plus", "sapi/..."]。
// 从前往后试：前一个失败（key 过期、余额不足、模型下线、网络抖）就自动换下一个，
// 同时在结果里标出「这次用的是备用档」，让用户知道发生了什么。
//
// 默认链只排千问。智谱的适配器还留着（providers/zhipu.js），但不在默认配置里，
// 需要的人可以自己往链上写 zhipu/<模型名> 把它加回来。

import * as qwen from './providers/qwen.js'
import * as zhipu from './providers/zhipu.js'
import * as sapi from './providers/sapi.js'
import { providerKey, rawChainLength, resolveChain } from './config.js'

const PROVIDERS = { qwen, zhipu, sapi }

export const CAPABILITIES = ['see', 'hear', 'hear_qa', 'image_gen', 'video_gen', 'speak']

// 给用户看的名字，报错时用中文说清楚是哪一项
const CAPABILITY_LABELS = {
  see: '看图 / 看视频',
  hear: '听声音（转写）',
  hear_qa: '听声音（问答）',
  image_gen: '生图',
  video_gen: '生视频',
  speak: '文字转语音',
}

export function capabilityLabel(capability) {
  return CAPABILITY_LABELS[capability] || capability
}

/**
 * 把平台返回的英文技术错误翻成「人话 + 下一步」。
 *
 * 平台报错长这样：fetch failed / EPERM: operation not permitted / Model not exist /
 * HTTP 400 [InvalidParameter] Field 'prompt' must be a non-empty string。
 * 这些给用户看等于没说。所以统一过一遍翻译，原始报错附在下面一行，方便排查。
 *
 * 匹配顺序有意义：具体的放前面，泛的放后面。
 */
const TRANSLATIONS = [
  {
    test: /^找不到(音频|视频|文件|这个文件)/,
    say: (raw) => `${raw}。检查一下路径有没有写错、文件是不是被挪走了。`,
  },
  {
    test: /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error/i,
    say: () => '连不上服务器。检查网络通不通，或去设置页看看「千问地址」有没有写错。',
  },
  {
    test: /\b401\b|Unauthorized|invalid_api_key|Incorrect API key|api key is invalid/i,
    say: () => 'key 不对或没权限。去设置页「服务商与 key」里重新粘一次。',
  },
  {
    test: /\b403\b|Forbidden|AccessDenied|Unpurchased|无权|没有权限访问/i,
    say: () => '这个账号没有调用权限。可能这个模型没开通，或 key 属于别的账号。',
  },
  {
    test: /\b429\b|rate limit|too many requests|Throttling|请求过于频繁|访问量过大/i,
    say: () => '调用太频繁，被限流了。等十几秒再试；一直这样就去看看账户余额或配额。',
  },
  {
    test: /Model not exist|model_not_found|model does not exist|模型不存在/i,
    say: (raw, ctx) => `模型名不存在：${ctx.model ? '`' + ctx.model + '`' : '链上写的那个'}。去设置页「每个能力用哪家」改成正确的名字。`,
  },
  {
    test: /audio is empty|The audio is empty/i,
    say: () => '这个音频是空的或者读不出来。确认文件没坏，格式是 wav / mp3 / m4a 这类。',
  },
  {
    test: /Field 'prompt' must be a non-empty string|prompt.*non-empty/i,
    say: () => '生图的描述不能空着，写点想画的东西。',
  },
  {
    test: /EPERM|EACCES|operation not permitted|permission denied/i,
    say: () => '没权限写这个目录。去设置页「高级设置」里换一个你有权限的地方。',
  },
  {
    test: /ENOSPC|no space left/i,
    say: () => '磁盘满了，腾点空间再试。',
  },
  {
    test: /operation was aborted|This operation was aborted|aborted by|user cancel|已取消/i,
    say: () => '已取消，没有再继续往下做。',
  },
  {
    test: /timeout|timed out|请求超时|aborted|AbortError/i,
    say: () => '等太久没回应。生视频可能要几分钟，再等等；一直这样换个模型或检查网络。',
  },
  {
    test: /没有配置 key/,
    say: (raw, ctx) => `${ctx.providerLabel || ctx.provider} 的 key 还没填。去设置页「服务商与 key」里粘上。`,
  },
  {
    test: /未知的服务商/,
    say: (raw, ctx) => `链上写的服务商 \`${ctx.provider}\` 不认识。目前只支持 qwen、zhipu、sapi。`,
  },
]

export function humanizeError(raw, context = {}) {
  const text = String(raw || '')
  for (const rule of TRANSLATIONS) {
    if (rule.test.test(text)) {
      let friendly
      try {
        friendly = rule.say(text, context)
      } catch {
        continue
      }
      // 翻译结果里已经包含原文的（比如「找不到音频：xxx」），就不用再附一遍
      const duplicated = friendly.includes(text)
      return { friendly, raw: duplicated ? '' : text }
    }
  }
  return { friendly: '', raw: text }
}

export function providerMeta() {
  return Object.entries(PROVIDERS).map(([key, impl]) => ({
    id: key,
    label: impl.label,
    free: Boolean(impl.free),
    capabilities: CAPABILITIES.filter((cap) => {
      try {
        // 不实际调用，只看声明：这里用简单约定，各 provider 的 execute 自己会拒
        return true
      } catch {
        return false
      }
    }),
  }))
}

/**
 * 执行某个能力。
 * @returns {Promise<{ text?:string, files?:string[], model:string, provider:string, degraded:boolean, attempts:Array }>}
 */
export async function execute(capability, input, config, signal) {
  const chain = resolveChain(config, capability)
  if (chain.length === 0) {
    const label = capabilityLabel(capability)
    const filled = rawChainLength(config, capability)
    if (filled > 0) {
      throw new Error(
        `「${label}」这一项你填了 ${filled} 行，但一行都不合法。` +
          `写法是 \`服务商/模型名\`，比如 \`qwen/qwen3-vl-plus\`；模型名前面不能多一个斜杠。`,
      )
    }
    throw new Error(`「${label}」这一项没有配置任何模型。去设置页「每个能力用哪家」里排一下顺序。`)
  }

  const attempts = []

  for (const entry of chain) {
    if (signal?.aborted) throw new Error('已取消')

    const impl = PROVIDERS[entry.provider]
    if (!impl) {
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        error: `这个服务商不认识：\`${entry.provider}\`。目前只支持 qwen、zhipu、sapi。`,
      })
      continue
    }

    const apiKey = providerKey(config, entry.provider)
    // 有的服务商不需要 key（比如调用系统自带语音），由它自己声明 hasKey()
    const usable = Boolean(apiKey) || (typeof impl.hasKey === 'function' ? Boolean(impl.hasKey(config)) : false)
    if (!usable) {
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        error: `${impl.label}的 key 还没填。去设置页「服务商与 key」里粘上。`,
      })
      continue
    }

    try {
      const out = await impl.execute(capability, { ...input, model: entry.model }, config, apiKey, signal)
      return {
        ...out,
        provider: entry.provider,
        providerLabel: impl.label,
        model: entry.model,
        free: Boolean(entry.free),
        degraded: attempts.length > 0,
        attempts,
      }
    } catch (err) {
      // 用户主动取消就别再往下试了
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err))
      const original = err instanceof Error ? err.message : String(err)
      const { friendly, raw } = humanizeError(original, {
        capability,
        provider: entry.provider,
        providerLabel: impl.label,
        model: entry.model,
        capabilityLabel: capabilityLabel(capability),
      })
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        error: friendly || original,
        raw: friendly ? raw : '',
      })
    }
  }

  const detail = attempts
    .map((a) => {
      const head = `· ${a.provider}/${a.model}：${a.error}`
      return a.raw ? `${head}\n  （原始报错：${a.raw}）` : head
    })
    .join('\n')

  throw new Error(`「${capabilityLabel(capability)}」试了 ${attempts.length} 个模型都没成功：\n${detail}`)
}