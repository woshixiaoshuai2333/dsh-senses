// Windows 自带的语音合成（SAPI）—— 免费、离线、不要 key。
//
// 为什么不用微软 Edge 那个「大声朗读」接口：实测握手直接被 403 拒绝
// （大概率是国内网络被拦，或者对方改了鉴权），这条路不值得赌。
// 改用系统自带的 SAPI，音色是 Windows 里那个「慧慧」，机器味重一点，
// 但胜在完全离线、零成本、永远不会失效。
//
// 实现方式：把文本写进临时文件 → 让 PowerShell 读文件并合成 wav。
// 用临时文件而不是命令行拼字符串，是为了绕开中文编码那一堆坑。

import { spawn } from 'node:child_process'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { ensureDir } from '../media.js'
import { outputDirOf } from '../config.js'

export const id = 'sapi'
export const label = 'Windows 语音（免费）'
export const free = true

export function hasKey() {
  return process.platform === 'win32'
}

function powershellPath() {
  const win = process.env.SystemRoot || 'C:\\Windows'
  return path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 把脚本编码成 -EncodedCommand 需要的 UTF-16LE base64，
 * 这样脚本里的中文和引号都不用转义。
 */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * PowerShell 的 stderr 是 UTF-16LE，按 UTF-8 读会变成一坨乱码；
 * 而且它出错时会吐 CLIXML 这种 XML 包装。这里统一把乱码和包装剥掉，
 * 只留 `#< CLIXML … <S S="Error">真正的错误文字</S>` 里那一段。
 */
function tidyStderr(raw) {
  if (!raw) return ''
  let text = raw
  // 如果看起来像 UTF-8 被误读的 UTF-16，就重新按 utf16le 解一遍
  if (/\u0000/.test(text) || /^[\s\S]*\ufffd/.test(text) || /#<\s*CLIXML/.test(text)) {
    try {
      const buf = Buffer.from(text, 'utf8')
      const decoded = buf.toString('utf16le')
      // 解出来可打印字符更多才采用
      const printable = (s) => (s.match(/[\x20-\x7e\u4e00-\u9fa5]/g) || []).length / Math.max(1, s.length)
      if (printable(decoded) > printable(text)) text = decoded
    } catch {
      // 解不开就用原来的
    }
  }
  // 剥掉 CLIXML 外壳，只留错误正文
  const m = /<S\s+S="Error">([\s\S]*?)<\/S>/.exec(text)
  if (m) text = m[1]
  else if (/#<\s*CLIXML/.test(text)) text = text.replace(/#<\s*CLIXML[\s\S]*$/m, '')
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\u0000/g, '')
    .trim()
}

function runPowerShell(script, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    let stdout = ''
    let stderr = ''
    let done = false

    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    const onAbort = () => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(reject, new Error('已取消'))
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(reject, new Error('系统语音合成超时'))
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (err) => finish(reject, new Error(`调用系统语音失败：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) return finish(resolve, { stdout, stderr })
      const detail = tidyStderr(stderr) || tidyStderr(stdout) || `退出码 ${code}`
      finish(reject, new Error(`系统语音返回错误：${detail.slice(0, 300)}`))
    })
  })
}

// 占位符用 @@X@@ 这种形态：用户的输入里几乎不可能出现，也就不会被值互相顶掉。
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

$wanted = '@@VOICE@@'
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$chosen = $null
if ($wanted -and $wanted -ne 'auto') {
  $chosen = $voices | Where-Object { $_.Name -eq $wanted -or $_.Culture.Name -eq $wanted } | Select-Object -First 1
}
if (-not $chosen) {
  $chosen = $voices | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
}
if (-not $chosen) {
  $chosen = $voices | Select-Object -First 1
}
if (-not $chosen) { throw '这台机器上没有可用的语音' }

$synth.SelectVoice($chosen.Name)
$synth.Rate = @@RATE@@

$text = [IO.File]::ReadAllText('@@TEXT@@', [Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw '要念的文字是空的' }

$synth.SetOutputToWaveFile('@@OUT@@')
$synth.Speak($text)
$synth.Dispose()
Write-Output $chosen.Name
`

export async function execute(capability, input, config, _apiKey, signal) {
  if (capability !== 'speak') throw new Error('Windows 语音只支持文字转语音')
  if (process.platform !== 'win32') throw new Error('这个适配器只能在 Windows 上用')

  const text = String(input.text || '').trim()
  if (!text) throw new Error('没有要合成的文字')
  if (signal?.aborted) throw new Error('已取消')

  const dir = ensureDir(path.join(outputDirOf(config), 'audio'))
  const base = `speech-${input.stamp || Date.now()}`
  const wav = path.join(dir, `${base}.wav`)
  const txt = path.join(os.tmpdir(), `${base}.txt`)

  await fsp.writeFile(txt, text, 'utf8')

  // SAPI 的 Rate 是 -10..10，这里把配置里的「+0%」这种也翻译成整数
  let rate = 0
  const rawRate = config?.providers?.sapi?.rate ?? config?.providers?.edge?.rate
  if (typeof rawRate === 'number') rate = Math.max(-10, Math.min(10, Math.round(rawRate)))
  else if (typeof rawRate === 'string' && rawRate.trim()) {
    const parsed = Number(rawRate.replace('%', '').replace('+', ''))
    if (Number.isFinite(parsed)) rate = Math.max(-10, Math.min(10, Math.round(parsed / 10)))
  }

  const voice = input.voice || config?.providers?.sapi?.voice || 'auto'
  // 用 split/join 做全局替换：`String.replace(str, …)` 只换第一个，
  // 值里如果碰巧含占位符名，会把后面的占位符顶掉（实测 voice="__OUT__" 会把
  // wav 写进当前工作目录）。@@X@@ 这种形态 + 全局替换两头都堵住。
  const fill = (template, key, value) => template.split(key).join(value)
  let script = SCRIPT
  script = fill(script, '@@VOICE@@', voice.replace(/'/g, "''"))
  script = fill(script, '@@RATE@@', String(rate))
  script = fill(script, '@@TEXT@@', txt.replace(/'/g, "''"))
  script = fill(script, '@@OUT@@', wav.replace(/'/g, "''"))

  try {
    const { stdout } = await runPowerShell(script, 120000, signal)
    const stat = await fsp.stat(wav)
    const voiceName = stdout.trim() || '系统语音'
    return {
      files: [wav],
      model: voiceName,
      voice: voiceName,
      provider: id,
      bytes: stat.size,
      cost: 0,
    }
  } finally {
    fsp.unlink(txt).catch(() => {})
  }
}