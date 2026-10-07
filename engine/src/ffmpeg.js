/**
 * ffmpeg 定位与调用。
 *
 * 设计约束（均由本机实测确定，不是推测）：
 *
 * 1. 不依赖 GitHub Releases。`ffmpeg-static` 在 postinstall 阶段从 GitHub 下载
 *    二进制，在受限网络下会 `ETIMEDOUT` 而安装失败；`@ffmpeg-installer/ffmpeg`
 *    把各平台二进制作为普通 npm 包分发，只走 registry。
 * 2. 字幕必须通过 `subtitles=` 滤镜烧入，且字体要用系统真实字体族名
 *    （如 `Microsoft YaHei`）。libass 经 DirectWrite 解析字体，无法识别
 *    canvas 侧用别名注册的字体，写别名会导致字幕静默不渲染。
 * 3. 抽帧校验时 `-ss` 必须放在 `-i` 之后（输出侧定位）。放在输入侧会把
 *    时间戳归零，从而抽到第一帧之前的画面，看起来像「字幕没烧进去」。
 * 4. `subtitles=` 的路径用正斜杠；绝对路径需转义盘符冒号，
 *    形如 `subtitles='D\:/path/to/sub.ass'`。
 * @module arknights-video/ffmpeg
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { environmentError, processFailure } from './errors.js'

/** ffmpeg 可执行文件路径的进程级缓存。 */
let cachedPath
/** ffprobe 可执行文件路径的进程级缓存（可能不存在）。 */
let cachedProbePath

/**
 * 解析 ffmpeg 可执行文件。
 *
 * 优先使用调用方显式配置的路径，其次随包依赖 `@ffmpeg-installer/ffmpeg`。
 * 动态 import 保证缺依赖时给出可读的中文错误，而不是模块加载期崩溃。
 * @param {string} [configured] - 用户配置的 ffmpeg 路径。
 * @returns {Promise<string>} 可执行文件绝对路径。
 */
export async function resolveFfmpeg(configured) {
  if (configured) {
    if (!existsSync(configured)) {
      throw environmentError(`配置的 ffmpeg 路径不存在：${configured}`)
    }
    return configured
  }
  if (cachedPath) return cachedPath
  let mod
  try {
    mod = await import('@ffmpeg-installer/ffmpeg')
  } catch (error) {
    throw environmentError(
      '缺少 ffmpeg 依赖（@ffmpeg-installer/ffmpeg）。请在插件目录执行 npm install，'
      + '或在配置中显式指定 ffmpegPath。',
      { cause: String(error?.message ?? error) },
    )
  }
  const installer = mod.default ?? mod
  const path = installer.path
  if (typeof path !== 'string' || !existsSync(path)) {
    throw environmentError(`ffmpeg 依赖未提供可用的二进制路径：${JSON.stringify(path)}`)
  }
  cachedPath = path
  return path
}

/**
 * 解析 ffprobe。@ffmpeg-installer 只分发 ffmpeg，因此 ffprobe 独立探测；
 * 缺失时调用方必须退回「用 ffmpeg 解析 stderr」的时长探测方式。
 * @param {string} [configured] - 用户配置的 ffprobe 路径。
 * @returns {string|null} 可执行文件路径；不可用时为 null。
 */
export function resolveFfprobe(configured) {
  if (configured) return existsSync(configured) ? configured : null
  if (cachedProbePath !== undefined) return cachedProbePath
  const candidate = cachedPath
    ? cachedPath.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))
    : null
  cachedProbePath = candidate && existsSync(candidate) ? candidate : null
  return cachedProbePath
}

/**
 * 运行一个外部进程并收集输出。
 *
 * 默认使用管道 stdio：插件代码运行在 Host 进程内（不受 Windows ACL 沙箱
 * 约束），因此管道捕获可用；受限模式只作用于 shell 工具本身。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数数组（不经 shell，避免注入与转义问题）。
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number }} [options] - 运行选项。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runProcess(command, args, options = {}) {
  const { cwd, signal, timeoutMs } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, windowsHide: true })
    } catch (error) {
      reject(processFailure(`无法启动 ${command}：${error?.message ?? error}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
      : null

    const onAbort = () => { child.kill('SIGKILL') }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(processFailure(`执行 ${command} 失败：${error?.message ?? error}`, {
        command, args: args.slice(0, 8), code: error?.code,
      }))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * 解析媒体文件时长（秒）。
 *
 * 不解码、不依赖 ffprobe：直接读 `-i` 的 banner。`@ffmpeg-installer`
 * 不附带 ffprobe，所以这是默认路径。
 * @param {string} ffmpegPath - ffmpeg 可执行文件。
 * @param {string} file - 媒体文件。
 * @returns {Promise<number>} 时长（秒）；无法解析时抛错。
 */
export async function probeDuration(ffmpegPath, file) {
  const result = await runProcess(ffmpegPath, ['-hide_banner', '-i', file], { timeoutMs: 60_000 })
  const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(result.stderr || '')
  if (!match) {
    throw processFailure(`无法解析媒体时长：${file}`, {
      stderrTail: (result.stderr || '').split('\n').slice(-8).join('\n'),
    })
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number.parseFloat(match[3])
}

/**
 * 为 ffmpeg 的 `subtitles=` / `ass=` 滤镜构造文件参数。
 *
 * 实测约束（两个都会让字幕「静默不渲染」而 ffmpeg 仍返回 0）：
 *
 * 1. 必须写成 `filename=<值>`。直接写 `subtitles=D:\...\x.ass` 时，
 *    滤镜的选项解析器会把盘符后的 `/...` 当成 `original_size` 的值，
 *    报 `Unable to parse option value ... as image size` 并初始化失败。
 * 2. 盘符冒号要转义为 `\:`，整个值用单引号包裹以容纳空格。
 *
 * 因此调用方必须使用 `subtitles=${buildSubtitleFileArg(path)}`。
 * @param {string} path - 字幕文件路径。
 * @returns {string} 可直接拼进滤镜串的 `filename=...` 片段。
 */
export function buildSubtitleFileArg(path) {
  const normalized = path.replace(/\\/g, '/').replace(/:/g, '\\:')
  return `filename='${normalized.replace(/'/g, "\\'")}'`
}

/**
 * 把 ffmpeg 的失败输出压缩成一段可读的诊断。
 * @param {string} stderr - ffmpeg stderr。
 * @returns {string} 末尾若干条有信息量的行。
 */
export function summarizeFfmpegError(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).filter((line) => line.trim())
  const interesting = lines.filter((line) => /error|invalid|failed|unable|no such|not found/i.test(line))
  const picked = (interesting.length ? interesting : lines).slice(-6)
  return picked.join('\n')
}
