/**
 * 三层配置解析：内置默认值 ← cordis.patch.yml 行内 config ← 用户文件。
 *
 * 与 prts-terrarchive 的 state.js 保持同构的分层顺序，但不引入任何
 * npm 依赖（不依赖 schemastery），便于随包分发和被预设覆盖。
 * @module arknights-video/config
 */

import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { invalidRequest } from './errors.js'
import { BGM_DEFAULTS, normalizeBgm, toAbsoluteBgmPaths } from './bgm.js'

/** 渲染默认值。 */
export const RENDER_DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  crf: 20,
  preset: 'medium',
  // 中文字幕必须使用系统真实字体族名；libass 通过 DirectWrite 解析，
  // 无法识别 canvas 侧注册的别名。
  subtitleFontFamily: 'Microsoft YaHei',
  subtitleFontSize: 58,
  subtitleMarginV: 110,
})

/** 配音默认值。 */
export const TTS_DEFAULTS = Object.freeze({
  provider: 'python-edge-tts',
  voice: 'zh-CN-YunxiNeural',
  pythonPath: 'python',
  rate: '+0%',
  volume: '+0%',
  pitch: '+0Hz',
})

/** 主题（皮肤）默认值。 */
export const THEME_DEFAULTS = Object.freeze({
  background: ['#080c11', '#131c26', '#1f2b3a'],
  accent: '#c8a45c',
  titleColor: '#f2e9d8',
  bodyColor: '#d3dae2',
  footerColor: '#7d8896',
  // 画面每页最多显示的正文字符数（超出由渲染层折行）。
  bodyMaxChars: 120,
})

export const CONFIG_DEFAULTS = Object.freeze({
  outputDir: null,
  ffmpegPath: null,
  ffprobePath: null,
  render: RENDER_DEFAULTS,
  tts: TTS_DEFAULTS,
  bgm: BGM_DEFAULTS,
  theme: THEME_DEFAULTS,
})

const clampInt = (value, min, max, label) => {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalidRequest(`${label} 必须是 ${min}–${max} 之间的整数，收到 ${JSON.stringify(value)}`)
  }
  return n
}

const nonEmptyString = (value, label) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidRequest(`${label} 必须是非空字符串`)
  }
  return value.trim()
}

/**
 * 规范化渲染配置：越界或类型错误在这个边界一次性失败，
 * 而不是等到 ffmpeg 报出难懂的参数错误。
 * @param {object} raw - 待校验的渲染配置。
 * @returns {object} 规范化后的渲染配置。
 */
export function normalizeRender(raw = {}) {
  const merged = { ...RENDER_DEFAULTS, ...raw }
  return {
    width: clampInt(merged.width, 320, 7680, 'render.width') ?? RENDER_DEFAULTS.width,
    height: clampInt(merged.height, 240, 4320, 'render.height') ?? RENDER_DEFAULTS.height,
    fps: clampInt(merged.fps, 12, 120, 'render.fps') ?? RENDER_DEFAULTS.fps,
    crf: clampInt(merged.crf, 0, 51, 'render.crf') ?? RENDER_DEFAULTS.crf,
    preset: nonEmptyString(merged.preset, 'render.preset') ?? RENDER_DEFAULTS.preset,
    subtitleFontFamily: nonEmptyString(merged.subtitleFontFamily, 'render.subtitleFontFamily')
      ?? RENDER_DEFAULTS.subtitleFontFamily,
    subtitleFontSize: clampInt(merged.subtitleFontSize, 12, 200, 'render.subtitleFontSize')
      ?? RENDER_DEFAULTS.subtitleFontSize,
    subtitleMarginV: clampInt(merged.subtitleMarginV, 0, 2000, 'render.subtitleMarginV')
      ?? RENDER_DEFAULTS.subtitleMarginV,
  }
}

/** 规范化配音配置。 */
export function normalizeTts(raw = {}) {
  const merged = { ...TTS_DEFAULTS, ...raw }
  const provider = merged.provider === 'none' ? 'none' : 'python-edge-tts'
  return {
    provider,
    voice: nonEmptyString(merged.voice, 'tts.voice') ?? TTS_DEFAULTS.voice,
    pythonPath: nonEmptyString(merged.pythonPath, 'tts.pythonPath') ?? TTS_DEFAULTS.pythonPath,
    rate: nonEmptyString(merged.rate, 'tts.rate') ?? TTS_DEFAULTS.rate,
    volume: nonEmptyString(merged.volume, 'tts.volume') ?? TTS_DEFAULTS.volume,
    pitch: nonEmptyString(merged.pitch, 'tts.pitch') ?? TTS_DEFAULTS.pitch,
  }
}

/** 规范化主题配置。 */
export function normalizeTheme(raw = {}) {
  const merged = { ...THEME_DEFAULTS, ...raw }
  const background = Array.isArray(merged.background) && merged.background.length >= 2
    ? merged.background.map((c) => nonEmptyString(c, 'theme.background[]'))
    : THEME_DEFAULTS.background
  return {
    background,
    accent: nonEmptyString(merged.accent, 'theme.accent') ?? THEME_DEFAULTS.accent,
    titleColor: nonEmptyString(merged.titleColor, 'theme.titleColor') ?? THEME_DEFAULTS.titleColor,
    bodyColor: nonEmptyString(merged.bodyColor, 'theme.bodyColor') ?? THEME_DEFAULTS.bodyColor,
    footerColor: nonEmptyString(merged.footerColor, 'theme.footerColor') ?? THEME_DEFAULTS.footerColor,
    bodyMaxChars: clampInt(merged.bodyMaxChars, 20, 1000, 'theme.bodyMaxChars')
      ?? THEME_DEFAULTS.bodyMaxChars,
  }
}

/** 解析 $DSH_HOME；与 prts-terrarchive 使用同一环境变量约定。 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return resolve(configured || join(homedir(), '.dsh'))
}

/** 解析产物根目录。 */
export function resolveOutputDir(config, dshHome = resolveDshHome()) {
  const configured = config?.outputDir
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  }
  return join(dshHome, 'arknights-video')
}

/** 用户可写配置文件的路径。 */
export function resolveConfigPath(dshHome = resolveDshHome()) {
  return join(dshHome, 'arknights-video.json')
}

/**
 * 合并三层配置。
 *
 * `baseDir` 是「配置文件中相对路径」的解析基准。必须传入配置文件所在目录
 * （通常是 `$DSH_HOME`），否则同一个相对路径会在设置页自检与出片两处
 * 解析成不同文件——这是实测踩过的 bug，不是理论风险。
 * @param {object} patchConfig - cordis.patch.yml 行内 config。
 * @param {object} userConfig - 用户配置文件内容（可为空对象）。
 * @param {string} [baseDir] - 配置文件中相对路径的解析基准。
 * @returns {object} 生效配置。
 */
export function mergeConfig(patchConfig = {}, userConfig = {}, baseDir) {
  const base = patchConfig ?? {}
  const user = userConfig ?? {}
  const bgmSource = { ...base.bgm, ...user.bgm }
  return {
    outputDir: user.outputDir ?? base.outputDir ?? CONFIG_DEFAULTS.outputDir,
    ffmpegPath: user.ffmpegPath ?? base.ffmpegPath ?? CONFIG_DEFAULTS.ffmpegPath,
    ffprobePath: user.ffprobePath ?? base.ffprobePath ?? CONFIG_DEFAULTS.ffprobePath,
    render: normalizeRender({ ...base.render, ...user.render }),
    tts: normalizeTts({ ...base.tts, ...user.tts }),
    // 相对路径在这里一次性绝对化，消除「诊断与出片基准不同」的歧义。
    bgm: toAbsoluteBgmPaths(normalizeBgm(bgmSource), baseDir),
    theme: normalizeTheme({ ...base.theme, ...user.theme }),
  }
}

/** 原子读取用户配置；文件不存在或损坏时回退为空对象。 */
export async function readUserConfig(configPath) {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    // 损坏的用户配置不应让插件无法加载：记录后按默认值继续。
    return {}
  }
}

/** 原子写入用户配置。 */
export async function writeUserConfig(configPath, value) {
  await mkdir(dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, configPath)
}
