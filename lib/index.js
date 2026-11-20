// 插件宿主入口。
//
// 两件事：
//   1. 把五个工具注册进 DSH（listen / watch_video / generate_image / generate_video / speak）
//   2. 如果当前运行时有 webServer 服务，再挂一组 HTTP 接口给设置页用
//
// webServer 是可选的：桌面版有，纯命令行版可能没有。所以用 ctx.inject 延迟注入，
// 拿不到就只是没有设置页，工具照常工作。
//
// 另一个硬性要求：任何异常都不许往外抛。插件装坏了顶多工具不出现，
// 绝不能让 DSH 起不来。

import fs from 'node:fs'
import path from 'node:path'
import { ALL_TOOLS } from './tools.js'
import { configDir, configPath, loadSync, normalize, save } from './config.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-senses'
export const inject = ['tools']

const VERSION = '0.1.0'
const LOG_FILE = path.join(configDir(), 'mount.log')
const LOG_MAX_BYTES = 512 * 1024

function log(message) {
  try {
    fs.mkdirSync(configDir(), { recursive: true })
    // 超过 512KB 就轮转一份：这文件里只有插件自己的生命周期记录，
    // 但用户装几个月不动它，别让它悄悄长到几兆。
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
      }
    } catch {
      // 文件还不存在，无需轮转
    }
    const line = `[${new Date().toISOString()}] ${message}\n`
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    // 日志写不了就算了，绝不能因为它崩掉
  }
}

export function apply(ctx, patchConfig = {}) {
  log(`apply 开始，版本 ${VERSION}`)

  // --- 工具 ---
  for (const tool of ALL_TOOLS) {
    try {
      ctx.effect(() => {
        const dispose = ctx.tools.register(tool)
        log(`已注册工具 ${tool.name}`)
        return () => {
          log(`卸载工具 ${tool.name}`)
          if (typeof dispose === 'function') dispose()
        }
      })
    } catch (err) {
      log(`注册工具 ${tool.name} 失败：${err && err.message ? err.message : err}`)
    }
  }

  // --- 把 patch 里的配置合并进 config.json（只补空值，不覆盖用户改过的） ---
  try {
    if (patchConfig && typeof patchConfig === 'object' && Object.keys(patchConfig).length > 0) {
      const current = loadSync()
      const merged = normalize(patchConfig)
      // 只有当用户配置里对应字段为空时才用 patch 的值兜底
      for (const providerId of Object.keys(merged.providers || {})) {
        const target = current.providers[providerId]
        const source = merged.providers[providerId]
        if (!target || !source) continue
        for (const key of Object.keys(source)) {
          if (target[key] === '' || target[key] === undefined || target[key] === null) {
            target[key] = source[key]
          }
        }
      }
      if (!fs.existsSync(configPath())) {
        save(current).then(() => log('已写入初始配置')).catch(() => {})
      }
    }
  } catch (err) {
    log(`合并 patch 配置失败：${err && err.message ? err.message : err}`)
  }

  // --- 配置接口（可选） ---
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() => registerRoutes(webCtx, log))
      log('已挂载设置页接口')
    } catch (err) {
      log(`挂载设置页接口失败：${err && err.message ? err.message : err}`)
    }
  })

  log('apply 结束')
}

export const tools = ALL_TOOLS