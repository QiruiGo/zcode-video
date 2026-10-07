/**
 * 背景音乐（BGM）。
 *
 * 设计约束：**不随包分发任何音乐文件**——游戏原声与商业曲库都有版权，
 * 打进插件会让整个包不可分发。因此 BGM 设计为「用户自备素材目录 + 混音管线」：
 *
 *   - 用户把 mp3/wav/m4a/flac/ogg 放进一个目录（`bgm.dir`），或用 `bgm.track`
 *     指定单个文件；
 *   - 插件负责选曲、循环、压低音量、淡入淡出，并与旁白混音；
 *   - 没有素材时 BGM 自动跳过，不影响出片（`bgm.enabled` 默认 false）。
 *
 * 混音策略：BGM 音量默认压到 0.18，避免盖住旁白；片头片尾做淡入淡出。
 * 不做 sidechain ducking——解说视频里旁白是连续的，静态压低已足够，
 * 且少一层滤镜就少一类 Windows 上的排查成本。
 * @module arknights-video/bgm
 */

import { readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { invalidRequest, notFound } from './errors.js'

/** 支持的音频扩展名。 */
export const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'])

/** BGM 默认值。 */
export const BGM_DEFAULTS = Object.freeze({
  enabled: false,
  dir: null,
  track: null,
  volume: 0.18,
  fadeInSeconds: 1.5,
  fadeOutSeconds: 2,
})

const clampNumber = (value, min, max, label) => {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidRequest(`${label} 必须是 ${min}–${max} 之间的数值，收到 ${JSON.stringify(value)}`)
  }
  return n
}

/** 规范化 BGM 配置。 */
export function normalizeBgm(raw = {}) {
  const merged = { ...BGM_DEFAULTS, ...raw }
  return {
    enabled: merged.enabled === true,
    dir: typeof merged.dir === 'string' && merged.dir.trim() ? merged.dir.trim() : null,
    track: typeof merged.track === 'string' && merged.track.trim() ? merged.track.trim() : null,
    volume: clampNumber(merged.volume, 0, 2, 'bgm.volume') ?? BGM_DEFAULTS.volume,
    fadeInSeconds: clampNumber(merged.fadeInSeconds, 0, 60, 'bgm.fadeInSeconds')
      ?? BGM_DEFAULTS.fadeInSeconds,
    fadeOutSeconds: clampNumber(merged.fadeOutSeconds, 0, 60, 'bgm.fadeOutSeconds')
      ?? BGM_DEFAULTS.fadeOutSeconds,
  }
}

/** 是否为可用的音频文件。 */
export const isAudioFile = (file) => AUDIO_EXTENSIONS.includes(extname(file).toLowerCase())

/**
 * 列出目录下的音频文件。
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 音频文件绝对路径。
 */
export async function listBgmTracks(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && isAudioFile(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * 把 BGM 配置里的相对路径解析为绝对路径。
 *
 * **必须在配置层统一调用**，原因为实测发现的歧义：`dir` / `track` 若保持相对，
 * 不同调用点会得到不同结果——设置页自检用进程 cwd、出片用项目目录，
 * 于是"诊断说找到了、出片却说找不到"。用户写相对路径的本意是
 * 「相对于配置文件所在目录」，因此这里以配置目录（`$DSH_HOME`）为基准，
 * 解析一次后所有下游只见到绝对路径。
 * @param {object} bgm - 规范化后的 BGM 配置。
 * @param {string} baseDir - 基准目录（配置文件所在目录）。
 * @returns {object} 路径已绝对化的 BGM 配置。
 */
export function toAbsoluteBgmPaths(bgm, baseDir) {
  if (!bgm || !baseDir) return bgm
  return {
    ...bgm,
    dir: bgm.dir ? (isAbsolute(bgm.dir) ? bgm.dir : resolve(baseDir, bgm.dir)) : bgm.dir,
    track: bgm.track ? (isAbsolute(bgm.track) ? bgm.track : resolve(baseDir, bgm.track)) : bgm.track,
  }
}

/**
 * 解析实际的 BGM 文件。
 *
 * 优先级：`track` 显式指定 > `dir` 目录下的第一个音频文件。
 * 未启用、未配置或找不到素材时返回 null —— BGM 是可选增强，
 * 缺素材不应让出片失败。
 *
 * 传入的 `bgm` 应当是 `toAbsoluteBgmPaths()` 处理过的配置；`baseDir` 仅作
 * 兜底（测试或直接调用模块时）。
 * @param {object} bgm - BGM 配置。
 * @param {string} [baseDir] - 相对路径的兜底基准。
 * @returns {Promise<{ file: string, available: string[] }|null>} 选中的曲目。
 */
export async function resolveBgmTrack(bgm, baseDir) {
  if (!bgm?.enabled) return null

  if (bgm.track) {
    const file = isAbsolute(bgm.track) ? bgm.track : resolve(baseDir ?? process.cwd(), bgm.track)
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw notFound(
        `配置的 BGM 文件不存在：${file}。`
        + '请在设置中把 bgm.track 指向一个音频文件，或改用 bgm.dir 指定素材目录。',
      )
    }
    return { file, available: [file] }
  }

  if (!bgm.dir) return null
  const dir = isAbsolute(bgm.dir) ? bgm.dir : resolve(baseDir ?? process.cwd(), bgm.dir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw notFound(
      `配置的 BGM 目录不存在：${dir}。请放入 mp3/wav 等音频文件，或关闭 bgm.enabled。`,
    )
  }
  const tracks = await listBgmTracks(dir)
  if (!tracks.length) return null
  return { file: tracks[0], available: tracks }
}

/**
 * 构造 BGM 音频滤镜链。
 *
 * `afade` 的 `st`（起始时间）必须早于文件总时长，否则该淡出不生效；
 * 时长短于淡出时长时按比例收缩，避免产生无效的负起始时间。
 * @param {object} options - 混音参数。
 * @returns {string} 以逗号分隔的音频滤镜。
 */
export function buildBgmFilters({ durationSeconds, volume, fadeInSeconds, fadeOutSeconds }) {
  const filters = [`volume=${volume}`]
  if (fadeInSeconds > 0) {
    filters.push(`afade=t=in:st=0:d=${Math.min(fadeInSeconds, durationSeconds)}`)
  }
  if (fadeOutSeconds > 0 && durationSeconds > fadeOutSeconds) {
    const start = Number((durationSeconds - fadeOutSeconds).toFixed(3))
    filters.push(`afade=t=out:st=${start}:d=${fadeOutSeconds}`)
  }
  return filters.join(',')
}

/**
 * 构造「旁白 + BGM」的完整 filter_complex。
 *
 * 输入约定由调用方保证：
 *   voiceLabel 旁白音轨标签（可为 null，表示无旁白）
 *   bgmLabel   BGM 标签
 *
 * **为什么不用 `normalize=0`**：本插件随包依赖的 ffmpeg 4.1 中 `amix` 没有
 * `normalize` 选项（实测报 `Option 'normalize' not found`），而新版 ffmpeg
 * 默认 `normalize=1`。为跨版本一致，这里统一用 `weights` 把归一化除数用
 * `volume` 补回来：
 *
 *   amix 输出 = (voice + bgm) / N  →  再乘 N  →  voice + bgm
 *
 * 补偿系数取输入个数，因此旁白保持单位增益，BGM 仍是各自链上的音量。
 * @param {{ voiceLabel?: string|null, bgmLabel?: string|null, bgmFilters?: string, inputs?: number }} options - 输入标签与 BGM 滤镜。
 * @returns {{ filter: string, outputLabel: string }|null} filter_complex 片段。
 */
export function buildMixFilter({ voiceLabel, bgmLabel, bgmFilters, inputs = 2 }) {
  if (voiceLabel && bgmLabel) {
    const weights = Array.from({ length: inputs }, () => '1').join(' ')
    return {
      filter: `[${bgmLabel}]${bgmFilters}[bgmout];`
        + `[${voiceLabel}][bgmout]amix=inputs=${inputs}:duration=first:weights='${weights}',volume=${inputs}[aout]`,
      outputLabel: 'aout',
    }
  }
  if (bgmLabel) {
    return { filter: `[${bgmLabel}]${bgmFilters}[aout]`, outputLabel: 'aout' }
  }
  return null
}

/** 生成给工具返回的 BGM 摘要。 */
export function describeBgm(track, bgm) {
  if (!track) return { enabled: false, reason: bgm?.enabled ? '未找到素材' : '未启用' }
  return {
    enabled: true,
    file: track.file.split(/[\\/]/u).pop(),
    volume: bgm.volume,
    candidates: track.available.length,
  }
}
