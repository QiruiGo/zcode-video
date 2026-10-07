/**
 * 字幕轴构建。
 *
 * 核心实测结论：edge-tts 默认只返回**句级** `SentenceBoundary`；必须在
 * `Communicate(...)` 上显式传 `boundary="WordBoundary"` 才能拿到**词级**
 * 时间戳。没有这一步，就只剩整句一个区间，无法做出逐词渐显或精确对齐字幕。
 *
 * WordBoundary 的字段语义：
 *   - `offset` / `duration` 单位为 100 纳秒（1e-7 秒），除以 1e7 得秒；
 *   - `text` 是该边界覆盖的词/字片段，可直接拼接成句。
 * @module arknights-video/subtitle
 */

/** offset/duration 的单位换算：100ns → 秒。 */
const TICKS_PER_SECOND = 1e7

/** 一句话结束时常见的收尾标点。 */
const CLAUSE_END = /[，。！？；：、,.!?;:]$/u

/**
 * 把词级时间戳按标点与长度上限切分成字幕行。
 *
 * 切分策略：遇到收尾标点即断行；同时限制单行字符数，避免长句
 * 在没有标点时撑满屏宽。
 * @param {Array<{ text: string, offset: number, duration: number }>} boundaries - 词级时间戳。
 * @param {{ maxCharsPerLine?: number, baseOffset?: number }} [options] - 切分选项。
 * @returns {Array<{ start: number, end: number, text: string }>} 字幕行。
 */
export function cuesFromBoundaries(boundaries, options = {}) {
  const maxCharsPerLine = options.maxCharsPerLine ?? 18
  const baseOffset = options.baseOffset ?? 0
  const cues = []
  let pending = []

  const flush = () => {
    if (!pending.length) return
    const first = pending[0]
    const last = pending[pending.length - 1]
    const start = baseOffset + first.offset / TICKS_PER_SECOND
    const end = baseOffset + (last.offset + last.duration) / TICKS_PER_SECOND
    cues.push({
      start,
      end,
      text: pending.map((item) => item.text).join(''),
    })
    pending = []
  }

  for (const boundary of boundaries) {
    pending.push(boundary)
    const chars = pending.reduce((sum, item) => sum + item.text.length, 0)
    if (CLAUSE_END.test(boundary.text) || chars >= maxCharsPerLine) flush()
  }
  flush()
  return cues
}

/**
 * 在没有词级时间戳时，按时长比例在标点处估算字幕轴。
 *
 * 降级路径：TTS 提供方不返回边界事件，或用户选择 `tts.provider: none`
 * 而只提供了文本。按字符数占比分配时长，仍能产出可用的字幕。
 * @param {string} text - 完整旁白文本。
 * @param {number} durationSec - 该段音频时长（秒）。
 * @param {number} [startSec] - 该段在成片中的起始时间。
 * @returns {Array<{ start: number, end: number, text: string }>} 估算出的字幕行。
 */
export function cuesFromText(text, durationSec, startSec = 0) {
  const segments = String(text ?? '')
    .split(/(?<=[，。！？；：、,.!?;:])/u)
    .map((part) => part.trim())
    .filter(Boolean)
  if (!segments.length) return []

  const totalChars = segments.reduce((sum, part) => sum + part.length, 0) || 1
  let cursor = startSec
  return segments.map((part) => {
    // 按字符占比切分时长；句末留一小段停顿，避免字幕与语音同进同出。
    const span = (part.length / totalChars) * durationSec
    const start = cursor
    const end = Math.max(start + 0.3, start + span - 0.12)
    cursor += span
    return { start, end, text: part }
  })
}

/**
 * ASS 时间格式：`H:MM:SS.cc`（厘秒，两位小数）。
 * @param {number} seconds - 秒。
 * @returns {string} ASS 时间戳。
 */
export function formatAssTime(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = clamped % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

/** 把 ASS 富文本里的花括号与换行清掉，避免破坏事件行结构。 */
const sanitizeAssText = (text) => String(text ?? '')
  .replace(/\r?\n/g, ' ')
  .replace(/[{}]/g, '')
  .trim()

/**
 * 生成 ASS 字幕文件内容。
 *
 * 字体族名必须是系统真实字体名（Windows 中文默认 `Microsoft YaHei`）：
 * libass 走 DirectWrite 解析，canvas 侧注册的别名在这里无效，
 * 写错会导致字幕静默不渲染且 ffmpeg 仍返回成功。
 * @param {Array<{ start: number, end: number, text: string }>} cues - 字幕行。
 * @param {object} options - 渲染参数。
 * @returns {string} ASS 文本。
 */
export function buildAss(cues, options) {
  const {
    width = 1920,
    height = 1080,
    fontFamily = 'Microsoft YaHei',
    fontSize = 58,
    marginV = 110,
  } = options ?? {}

  const header = `[Script Info]
; 由 arknights-video 生成
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${fontFamily},${fontSize},&H00FFFFFF,&H00101010,&H90000000,1,0,0,0,100,100,0,0,1,3,1,2,140,140,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

  const events = cues
    .filter((cue) => cue.end > cue.start && sanitizeAssText(cue.text))
    .map((cue) => `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Sub,,0,0,0,,${sanitizeAssText(cue.text)}`)
    .join('\n')

  return `${header}${events}\n`
}

/**
 * 生成 SRT 字幕文件内容（作为可选交付格式）。
 * @param {Array<{ start: number, end: number, text: string }>} cues - 字幕行。
 * @returns {string} SRT 文本。
 */
export function buildSrt(cues) {
  const srtTime = (seconds) => {
    const clamped = Math.max(0, Number(seconds) || 0)
    const hours = Math.floor(clamped / 3600)
    const minutes = Math.floor((clamped % 3600) / 60)
    const secs = Math.floor(clamped % 60)
    const millis = Math.round((clamped - Math.floor(clamped)) * 1000)
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
  }
  return cues
    .filter((cue) => cue.end > cue.start && sanitizeAssText(cue.text))
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${sanitizeAssText(cue.text)}\n`)
    .join('\n')
}
