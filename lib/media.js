// 本地媒体处理：路径解析、data URI、ffmpeg 抽帧、下载。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export function mimeOf(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

// 允许读的扩展名。不在这三个集合里的文件一律不读 —— 否则 source 参数可以被
// 引导去读 ~/.ssh/id_rsa 这种文件，读成 base64 发给模型，用户还看不到。
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.amr'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.flv', '.wmv', '.webm'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MEDIA_EXT = new Set([...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT])

export const MEDIA_EXTENSIONS = { audio: AUDIO_EXT, video: VIDEO_EXT, image: IMAGE_EXT, media: MEDIA_EXT }

// 就算扩展名是 .wav，路径长这样也不读：凭据文件改名成 .wav 也读不出来。
const SENSITIVE_PATH = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /[\\/]\.config[\\/]gcloud[\\/]/i,
  /\.credentials(\.ya?ml)?$/i,
  /[\\/]\.npmrc$/i,
  /[\\/]\.netrc$/i,
  /[\\/]\.git-credentials$/i,
  /[\\/]id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|p12|pfx)$/i,
  /[\\/]\.dsh[\\/]\.credentials/i,
]

/** 看起来是不是凭据类路径。 */
export function isSensitivePath(file) {
  const normalized = String(file).replace(/\\/g, '/')
  return SENSITIVE_PATH.some((re) => re.test(normalized))
}

/** 远程地址是不是指向本机 / 内网（下载前要拒掉，防 SSRF）。 */
export function isPrivateHost(urlText) {
  let host = ''
  try {
    const u = new URL(urlText)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return true
  }
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  if (/^fc[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true
  return false
}

export function isRemote(source) {
  return /^https?:\/\//i.test(source)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function expandHome(input) {
  if (!input) return input
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  // 带毫秒：同一秒里并发两次不会撞名互相覆盖。
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`
  )
}

/**
 * 把「本地路径」或「http(s) 链接」统一转成模型能吃的 data URI。
 * 远程链接原样返回（由模型侧去拉），本地文件读成 base64。
 *
 * 本地文件必须先过三道关：不是凭据类路径、扩展名在白名单里、不是空文件。
 * 这三道关挡的是「source 参数被引导去读 ~/.ssh/id_rsa」这类事故。
 */
export async function toDataUri(source, { maxBytes, kind = '文件', allow } = {}) {
  const raw = expandHome(String(source || '').trim())
  if (!raw) throw new Error(`没有提供${kind}`)

  if (isRemote(raw)) return raw

  const file = path.resolve(raw)

  if (isSensitivePath(file)) {
    throw new Error(`不读这个文件：${file}。它看起来是凭据或密钥文件，插件不会把它发给模型。`)
  }

  const allowed = allow ? new Set(Array.isArray(allow) ? allow : [...allow]) : MEDIA_EXT
  const ext = path.extname(file).toLowerCase()
  if (!allowed.has(ext)) {
    const list = [...allowed].join('、')
    throw new Error(`不支持这个文件类型：${ext || '（没有扩展名）'}。能读的是 ${list}。`)
  }

  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    throw new Error(`找不到${kind}：${file}`)
  }
  if (!stat.isFile()) throw new Error(`${kind}不是文件：${file}`)
  if (stat.size === 0) throw new Error(`${kind}是空文件（0 字节），没有内容可以读。`)
  if (maxBytes && stat.size > maxBytes) {
    throw new Error(
      `${kind}有 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB。` +
        `可以先用 ffmpeg 压缩，或改用公网链接。`,
    )
  }

  const bytes = await fsp.readFile(file)
  return `data:${mimeOf(file)};base64,${bytes.toString('base64')}`
}

export function audioFormatOf(source) {
  const ext = path.extname(String(source || '')).toLowerCase().replace('.', '')
  if (ext === 'mp3' || ext === 'wav' || ext === 'm4a' || ext === 'aac' || ext === 'ogg' || ext === 'opus' || ext === 'flac' || ext === 'webm') {
    return ext
  }
  return 'wav'
}

/**
 * 下载一个地址到本地文件。
 * 默认拒绝内网地址、限制总量 —— 这个函数会被「用户给的视频链接」间接调用。
 */
export async function download(url, destFile, { signal, timeoutMs = 300000, maxBytes = 64 * 1024 * 1024, allowPrivate = false } = {}) {
  if (!allowPrivate && isPrivateHost(url)) {
    throw new Error(`不下载这个地址：${url}。它指向本机或内网，为了安全不代你去拉。`)
  }
  ensureDir(path.dirname(destFile))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs)
  const onAbort = () => controller.abort(new Error('下载被取消'))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') || 0)
    if (maxBytes && declared > maxBytes) {
      throw new Error(`文件有 ${(declared / 1024 / 1024).toFixed(1)}MB，超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB。`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    if (maxBytes && buffer.length > maxBytes) {
      throw new Error(`文件有 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB。`)
    }
    await fsp.writeFile(destFile, buffer)
    // bytes 是长度（历史字段，调用方拿它报大小），data 才是真正的字节
    return { file: destFile, bytes: buffer.length, data: buffer }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

function candidateFfmpegPaths(config) {
  const list = []
  if (config && config.ffmpegPath) list.push(expandHome(config.ffmpegPath))

  // 插件自带的 bin/
  list.push(path.join(HERE, '..', 'bin', FFMPEG_EXE))

  // ~/.dsh/bin/
  list.push(path.join(os.homedir(), '.dsh', 'bin', FFMPEG_EXE))

  // DSH 运行时里 imageio_ffmpeg 附带的那个
  try {
    const runtimeRoot = path.join(os.homedir(), '.dsh', 'dsh-runtimes')
    if (fs.existsSync(runtimeRoot)) {
      for (const name of fs.readdirSync(runtimeRoot)) {
        const bin = path.join(runtimeRoot, name, 'dependencies', 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
        if (!fs.existsSync(bin)) continue
        for (const file of fs.readdirSync(bin)) {
          if (/^ffmpeg.*\.exe$/i.test(file)) list.push(path.join(bin, file))
        }
      }
    }
  } catch {
    // 运行时目录不存在或没权限，忽略
  }

  return list
}

let cachedFfmpeg

function probeFfmpeg(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
    return r.status === 0
  } catch {
    return false
  }
}

export function findFfmpeg(config) {
  if (cachedFfmpeg && (cachedFfmpeg === FFMPEG_EXE || fs.existsSync(cachedFfmpeg))) return cachedFfmpeg
  cachedFfmpeg = undefined

  for (const candidate of candidateFfmpegPaths(config)) {
    try {
      if (!fs.existsSync(candidate)) continue
      if (probeFfmpeg(candidate)) {
        cachedFfmpeg = candidate
        return candidate
      }
    } catch {
      // 这个候选不可用，试下一个
    }
  }

  // 最后看 PATH
  if (probeFfmpeg(FFMPEG_EXE)) {
    cachedFfmpeg = FFMPEG_EXE
    return FFMPEG_EXE
  }

  return undefined
}

/**
 * 跑一个子进程，收集 stderr（ffmpeg 什么都往 stderr 写）。
 */
export function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经结束 */ }
      reject(new Error(`${path.basename(cmd)} 执行超时`))
    }, timeoutMs)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 20000) stderr = stderr.slice(-10000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 ${path.basename(cmd)}：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/**
 * 纯 JS 读 mp4 时长（遍历 box 找 mvhd）。
 * 读不到返回 undefined。
 */
export function mp4Duration(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(Math.min(size, 4096))
    fs.readSync(fd, head, 0, head.length, 0)
    // 不是 mp4 就放弃
    if (head.slice(4, 8).toString('ascii') !== 'ftyp') return undefined

    // moov 可能在文件末尾，粗扫一遍
    const chunk = Buffer.alloc(Math.min(size, 1024 * 1024))
    fs.readSync(fd, chunk, 0, chunk.length, 0)
    const idx = chunk.indexOf('mvhd')
    if (idx < 0) return undefined

    const base = idx + 4
    const version = chunk[base]
    if (version === 0) {
      const timescale = chunk.readUInt32BE(base + 12)
      const duration = chunk.readUInt32BE(base + 16)
      return timescale ? duration / timescale : undefined
    }
    if (version === 1) {
      const timescale = chunk.readUInt32BE(base + 20)
      const duration = Number(chunk.readBigUInt64BE(base + 24))
      return timescale ? duration / timescale : undefined
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 忽略 */ }
    }
  }
}

/**
 * 用 ffmpeg 读时长：故意跑 `ffmpeg -i file`，它必然非 0 退出，
 * 但 stderr 第一行就有 Duration。
 */
export async function ffmpegDuration(ffmpeg, file) {
  try {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file], 30000)
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '')
    if (!m) return undefined
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch {
    return undefined
  }
}

/**
 * 抽帧。
 * @returns {Promise<{ files:string[], duration:number, fps:number }>}
 */
export async function extractFrames(file, config, ffmpeg, outDir) {
  const duration = mp4Duration(file) ?? (await ffmpegDuration(ffmpeg, file))
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('读不出这个视频的时长，可能不是标准视频文件')
  }

  const fpsWanted = Number(config.framesPerSecond) > 0 ? Number(config.framesPerSecond) : 1
  const maxFrames = Number(config.maxFrames) > 0 ? Number(config.maxFrames) : 16
  const target = Math.round(Math.min(maxFrames, Math.max(4, duration * fpsWanted)))
  const fps = target / duration
  const width = Number(config.frameWidth) > 0 ? Number(config.frameWidth) : 768

  ensureDir(outDir)
  const pattern = path.join(outDir, 'f-%03d.jpg')

  const { code, stderr } = await run(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `fps=${fps.toFixed(4)},scale=${width}:-2`, '-q:v', '4', pattern],
    180000,
  )
  if (code !== 0) {
    throw new Error(`ffmpeg 抽帧失败：${(stderr || '').trim().slice(0, 300) || `退出码 ${code}`}`)
  }

  const files = fs
    .readdirSync(outDir)
    .filter((name) => /^f-\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(outDir, name))

  if (files.length === 0) throw new Error('ffmpeg 没抽出任何画面')
  return { files, duration, fps }
}

/**
 * 按文件头猜图片格式。
 * 智谱的生图接口返回的其实是 JPEG，却常常被当成 PNG 存下来，
 * 存错扩展名会让看图工具打不开，所以统一按真实字节判断。
 */
export function sniffImageExt(bytes) {
  if (!bytes || bytes.length < 16) return '.img'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return '.gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return '.webp'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return '.bmp'
  return '.img'
}

/** 下载一张图片并按真实格式落盘。 */
export async function downloadImage(url, dir, baseName, options = {}) {
  const tmp = path.join(dir, `${baseName}.bin`)
  const { data } = await download(url, tmp, options)
  const final = path.join(dir, `${baseName}${sniffImageExt(data)}`)
  await fsp.rename(tmp, final)
  return final
}

/** 把内存里的图片字节按真实格式落盘。 */
export async function writeImage(bytes, dir, baseName) {
  const final = path.join(dir, `${baseName}${sniffImageExt(bytes)}`)
  await fsp.writeFile(final, bytes)
  return final
}

export function makeTmpDir(prefix = 'dsh-senses-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function rmDirQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 删不掉就算了，系统临时目录会自己清
  }
}