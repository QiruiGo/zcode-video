/**
 * 画面渲染：把分镜渲染成 1920×1080 卡片 PNG。
 *
 * 素材策略：本体只用程序化绘制的信息卡片（渐变底 + 标题 + 正文 + 出处脚注），
 * 不附带任何受版权保护的资产，保证插件可自由分发。分镜可选携带本地图片
 * （`scene.image`，绝对路径），存在时以「CG 背景 + 压暗遮罩」呈现，由用户自备
 * 并自负版权；缺省或加载失败时退回渐变底，行为与本体的默认策略一致。
 * @module arknights-video/render
 */

import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { environmentError } from './errors.js'

/**
 * 候选系统中文字体，按优先级排列。
 *
 * 注意：这里注册给 canvas 用的别名（`VideoCJK`）只对 canvas 生效；
 * 烧入字幕时 libass 走 DirectWrite，必须用真实字体族名。
 */
const CANVAS_FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',    // 微软雅黑
  'C:/Windows/Fonts/simhei.ttf',  // 黑体
  'C:/Windows/Fonts/simsun.ttc',  // 宋体
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
]

/** canvas 侧注册的字体别名。 */
const CANVAS_FONT_ALIAS = 'VideoCJK'

/**
 * 字体注册成功时的哨兵值。
 * 供 doctor 判断「是否真的加载到中文字体」，而不是退回了 sans-serif。
 */
export const CANVAS_FONT_PROBE = CANVAS_FONT_ALIAS

let fontReady = false
let effectiveFontFamily = 'sans-serif'

/**
 * 注册第一个可用的中文字体。
 * @returns {string} canvas 可用的 font-family。
 */
export function ensureCanvasFont() {
  if (fontReady) return effectiveFontFamily
  for (const path of CANVAS_FONT_CANDIDATES) {
    try {
      const ok = GlobalFonts.registerFromPath(path, CANVAS_FONT_ALIAS)
      if (ok) {
        effectiveFontFamily = CANVAS_FONT_ALIAS
        fontReady = true
        return effectiveFontFamily
      }
    } catch {
      // 该候选不可用，继续尝试下一个。
    }
  }
  // 没有任何候选中文字体时仍继续渲染；canvas 会退到系统默认字体，
  // 中文可能显示为方块。doctor 命令会把这一点报告给用户。
  fontReady = true
  return effectiveFontFamily
}

/**
 * 按可用宽度把文本折成多行。
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx - canvas 上下文。
 * @param {string} text - 文本。
 * @param {number} maxWidth - 行宽上限（像素）。
 * @returns {string[]} 折行结果。
 */
export function wrapText(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  for (const char of String(text ?? '')) {
    if (char === '\n') {
      lines.push(line)
      line = ''
      continue
    }
    const candidate = line + char
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = char
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * 渲染一张分镜卡片。
 * @param {object} scene - 分镜数据。
 * @param {object} options - 渲染参数。
 * @returns {Buffer} PNG 字节。
 */
export function renderSceneCard(scene, options) {
  const {
    width, height, theme,
    title = '', body = '', cite = '', index = 0, total = 1,
    // bgImage 是调用方已加载好的图片对象；scene.image 是本地路径字符串，
    // 两者分开命名，避免 merge 时字符串路径覆盖图片对象。
    bgImage = null,
  } = { ...options, ...scene }

  const family = ensureCanvasFont()
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // 背景渐变（作为图片缺失或未铺满时的兜底）
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  const stops = theme.background
  stops.forEach((color, i) => gradient.addColorStop(i / Math.max(1, stops.length - 1), color))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // 可选 CG 背景：等比放大到覆盖画布后居中裁切，再压暗以保证文字可读。
  if (bgImage) {
    const imgScale = Math.max(width / bgImage.width, height / bgImage.height)
    const dw = bgImage.width * imgScale
    const dh = bgImage.height * imgScale
    ctx.drawImage(bgImage, (width - dw) / 2, (height - dh) / 2, dw, dh)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(0, 0, width, height)
  }

  // 顶部强调色条
  ctx.fillStyle = theme.accent
  ctx.fillRect(0, 0, width, Math.max(4, Math.round(height / 180)))

  // 缩放缓动：小画布时按比例缩放字号，保证 720p 与 1080p 观感一致。
  const scale = height / 1080
  const padX = Math.round(width * 0.068)

  // 标题
  const titleSize = Math.round(80 * scale)
  ctx.fillStyle = theme.titleColor
  ctx.font = `bold ${titleSize}px "${family}"`
  const titleLines = wrapText(ctx, title, width - padX * 2)
  let y = Math.round(height * 0.213)
  for (const line of titleLines.slice(0, 2)) {
    ctx.fillText(line, padX, y)
    y += Math.round(titleSize * 1.2)
  }

  // 标题下划线
  ctx.fillStyle = theme.accent
  ctx.fillRect(padX, y - Math.round(titleSize * 0.72), Math.round(width * 0.125), Math.max(3, Math.round(5 * scale)))

  // 正文
  const bodySize = Math.round(46 * scale)
  ctx.fillStyle = theme.bodyColor
  ctx.font = `${bodySize}px "${family}"`
  const bodyLines = wrapText(ctx, body, width - padX * 2)
  let bodyY = Math.round(height * 0.389)
  for (const line of bodyLines.slice(0, 8)) {
    ctx.fillText(line, padX, bodyY)
    bodyY += Math.round(bodySize * 1.52)
  }

  // 脚注：出处
  ctx.fillStyle = theme.footerColor
  ctx.font = `${Math.round(30 * scale)}px "${family}"`
  ctx.fillText(cite, padX, height - Math.round(height * 0.074))

  // 右下角分镜序号
  if (total > 1) {
    const label = `${index + 1} / ${total}`
    ctx.font = `${Math.round(26 * scale)}px "${family}"`
    const metrics = ctx.measureText(label)
    ctx.fillText(label, width - padX - metrics.width, height - Math.round(height * 0.074))
  }

  return canvas.toBuffer('image/png')
}

/**
 * 渲染全部分镜卡片并落盘。
 * @param {Array<object>} scenes - 分镜数组。
 * @param {object} options - 渲染参数。
 * @returns {Promise<string[]>} 生成的 PNG 路径数组。
 */
export async function renderScenes(scenes, options) {
  const files = []
  for (const [index, scene] of scenes.entries()) {
    const file = scene.framePath
    await mkdir(dirname(file), { recursive: true })
    // 背景图在渲染前加载；缺失或损坏时静默退回渐变底，不中断整条管线。
    let image = null
    if (scene.image) {
      try {
        image = await loadImage(scene.image)
      } catch {
        image = null
      }
    }
    const buffer = renderSceneCard(scene, { ...options, index, total: scenes.length, bgImage: image })
    await writeFile(file, buffer)
    files.push(file)
  }
  return files
}
