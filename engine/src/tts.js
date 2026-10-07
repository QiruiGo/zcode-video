/**
 * 旁白配音（TTS）。
 *
 * 默认走 `edge-tts`（Python 包，无需 API key）。选它的理由是实测约束：
 * 本机网络无法访问 GitHub Releases，但可访问 PyPI / npm registry；
 * edge-tts 纯 Python、无 native 依赖，并且能返回**词级时间戳**。
 *
 * 关键实测结论（写代码时最容易踩的坑）：
 *   `edge_tts.Communicate(text, voice)` 默认只产出 `SentenceBoundary`（整句一个区间）；
 *   必须显式传 `boundary="WordBoundary"` 才能拿到逐词时间戳。
 * @module arknights-video/tts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { environmentError, invalidRequest, processFailure } from './errors.js'
import { runProcess } from './ffmpeg.js'

/**
 * 内联的 Python 驱动脚本。
 *
 * 刻意不落盘为独立文件：随包分发时少一个路径拼接点，也让「用哪个
 * edge-tts 参数」这件事集中在一处可审计。
 */
const PYTHON_DRIVER = String.raw`
import asyncio, json, sys

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))

async def main():
    import edge_tts
    request = json.loads(sys.argv[1])
    communicator = edge_tts.Communicate(
        request["text"],
        request["voice"],
        rate=request["rate"],
        volume=request["volume"],
        pitch=request["pitch"],
        # 决定性参数：不传就只能拿到句级 SentenceBoundary。
        boundary="WordBoundary",
    )
    boundaries = []
    with open(request["media"], "wb") as handle:
        async for chunk in communicator.stream():
            kind = chunk["type"]
            if kind == "audio":
                handle.write(chunk["data"])
            elif kind == "WordBoundary":
                boundaries.append({
                    "text": chunk["text"],
                    "offset": chunk["offset"],
                    "duration": chunk["duration"],
                })
    emit({"ok": True, "boundaries": boundaries})

try:
    asyncio.run(main())
except Exception as error:
    emit({"ok": False, "error": f"{type(error).__name__}: {error}"})
    sys.exit(1)
`

/**
 * 用 edge-tts 合成一段旁白。
 * @param {object} options - 合成参数。
 * @param {string} options.text - 旁白文本。
 * @param {string} options.voice - 音色名。
 * @param {string} options.outFile - 输出 mp3 路径。
 * @param {object} options.ttsConfig - 规范化后的 TTS 配置。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<Array<{ text: string, offset: number, duration: number }>>} 词级时间戳。
 */
export async function synthesize({ text, voice, outFile, ttsConfig, signal }) {
  const content = String(text ?? '').trim()
  if (!content) throw invalidRequest('旁白文本不能为空')

  await mkdir(dirname(outFile), { recursive: true })

  const request = JSON.stringify({
    text: content,
    voice: voice || ttsConfig.voice,
    rate: ttsConfig.rate,
    volume: ttsConfig.volume,
    pitch: ttsConfig.pitch,
    media: outFile,
  })

  const result = await runProcess(
    ttsConfig.pythonPath,
    ['-c', PYTHON_DRIVER, request],
    { signal, timeoutMs: 300_000 },
  )

  // edge-tts 依赖网络；Python 驱动把异常压成一行 JSON，
  // 这里区分「环境缺 edge-tts」和「合成失败」两种可自愈性不同的情况。
  let payload
  const lastLine = (result.stdout || '').trim().split('\n').filter(Boolean).pop()
  if (lastLine) {
    try { payload = JSON.parse(lastLine) } catch { payload = undefined }
  }

  if (result.code !== 0 || !payload?.ok) {
    const detail = payload?.error || (result.stderr || '').trim().split('\n').slice(-4).join('\n')
    if (/ModuleNotFoundError|No module named 'edge_tts'|edge_tts/i.test(detail)) {
      throw environmentError(
        '未安装 edge-tts。请执行：python -m pip install edge-tts；'
        + '或在配置中把 tts.provider 设为 none（仅生成无声视频）。',
        { detail },
      )
    }
    throw processFailure(`语音合成失败：${detail}`, { voice: request.voice })
  }

  return payload.boundaries ?? []
}

/** 探测 edge-tts 是否可用，供 doctor 使用。 */
export async function detectEdgeTts(pythonPath) {
  const result = await runProcess(
    pythonPath,
    ['-c', 'import edge_tts, sys; sys.stdout.write("ok")'],
    { timeoutMs: 60_000 },
  )
  if (result.code === 0 && result.stdout.includes('ok')) return { available: true }
  return {
    available: false,
    detail: (result.stderr || '').trim().split('\n').slice(-3).join('\n') || 'edge_tts 不可用',
  }
}

/**
 * 生成静音音轨占位文件所需的最小时长（秒）。
 * `tts.provider: none` 时用它给每个分镜一个可预测的停留时间。
 * @param {string} text - 旁白文本。
 * @param {number} [charsPerSecond] - 朗读速度估算。
 * @returns {number} 估算时长（秒），下限 1.5 秒。
 */
export function estimateSilentDuration(text, charsPerSecond = 5) {
  const chars = String(text ?? '').replace(/\s/g, '').length
  return Math.max(1.5, Number((chars / charsPerSecond).toFixed(2)))
}

/** 拼接用于 ffmpeg concat demuxer 的音频清单文件内容。 */
export function buildConcatList(files) {
  return files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** 供外部引用的默认输出文件名。 */
export const DEFAULT_VOICE_FILE = 'voice.m4a'
/** 供外部引用的默认字幕文件名。 */
export const DEFAULT_SUBTITLE_FILE = 'subtitle.ass'
/** 供外部引用的默认成片文件名。 */
export const DEFAULT_OUTPUT_FILE = 'episode.mp4'

/** 便捷函数：写出一段文本文件（用于交付 srt 等）。 */
export async function writeTextFile(file, content) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}
