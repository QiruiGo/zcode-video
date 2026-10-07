/**
 * 项目状态与合成管线。
 *
 * 一个「视频项目」= 一份 JSON 清单 + 产物目录：
 *   <outputDir>/<projectId>/project.json     清单（分镜、旁白、引用、状态）
 *   <outputDir>/<projectId>/frames/*.png     渲染出的卡片
 *   <outputDir>/<projectId>/audio/*.mp3      分镜配音
 *   <outputDir>/<projectId>/subtitle.ass     字幕
 *   <outputDir>/<projectId>/episode.mp4      成片
 *
 * 状态机刻意保持线性：draft → scripted → rendered → voiced → built。
 * 每个阶段只依赖前一阶段的产物，任一阶段都可重跑，便于 Agent 分步纠错。
 * @module arknights-video/project
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { invalidRequest, invalidState, notFound, processFailure } from './errors.js'
import { buildAss, buildSrt, cuesFromBoundaries, cuesFromText } from './subtitle.js'
import { estimateSilentDuration, synthesize } from './tts.js'
import { renderScenes } from './render.js'
import { buildSubtitleFileArg, probeDuration, resolveFfmpeg, runProcess, summarizeFfmpegError } from './ffmpeg.js'
import { buildBgmFilters, buildMixFilter, describeBgm, resolveBgmTrack } from './bgm.js'

/** 合法的项目状态，按流水线顺序。 */
export const PROJECT_STATES = Object.freeze(['draft', 'scripted', 'rendered', 'voiced', 'built'])

/** 状态在流水线中的序号，用于判断「能否进入下一阶段」。 */
const STATE_ORDER = Object.freeze(
  Object.fromEntries(PROJECT_STATES.map((state, index) => [state, index])),
)

/** 项目 id 允许的字符集：避免路径穿越与非法文件名。 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

/**
 * 校验项目 id。
 * @param {string} id - 用户提供的项目 id。
 * @returns {string} 规范化后的 id。
 */
export function assertProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) {
    throw invalidRequest(
      'project_id 必须以小写字母或数字开头，只含小写字母、数字和连字符，最长 64 字符；'
      + `收到 ${JSON.stringify(id)}`,
    )
  }
  return id
}

/** 项目目录路径。 */
export const projectDir = (outputDir, id) => join(outputDir, assertProjectId(id))
/** 清单文件路径。 */
export const manifestPath = (outputDir, id) => join(projectDir(outputDir, id), 'project.json')

/**
 * 读取项目清单。
 * @param {string} outputDir - 产物根目录。
 * @param {string} id - 项目 id。
 * @returns {Promise<object>} 清单对象。
 */
export async function loadProject(outputDir, id) {
  const file = manifestPath(outputDir, id)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw processFailure(`项目清单格式损坏：${file}`)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw notFound(`项目不存在：${id}。可先用 video_project list 查看已有项目，或 action="create" 新建。`)
    }
    throw error
  }
}

/** 原子写入项目清单。 */
export async function saveProject(outputDir, manifest) {
  const file = manifestPath(outputDir, manifest.project_id)
  await mkdir(projectDir(outputDir, manifest.project_id), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** 列出已有项目。 */
export async function listProjects(outputDir) {
  try {
    const entries = await readdir(outputDir, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue
      try {
        const manifest = await loadProject(outputDir, entry.name)
        projects.push({
          project_id: manifest.project_id,
          title: manifest.title,
          state: manifest.state,
          scene_count: manifest.scenes?.length ?? 0,
          updated_at: manifest.updated_at,
          output_file: manifest.artifacts?.output_file ?? null,
        })
      } catch {
        // 单个损坏项目不影响整体列表。
      }
    }
    return projects.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 校验并规范化一个分镜。
 * @param {object} raw - 用户传入的分镜。
 * @param {number} index - 分镜序号（用于报错定位）。
 * @returns {object} 规范化分镜。
 */
export function normalizeScene(raw, index = 0) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidRequest(`scenes[${index}] 必须是对象`)
  }
  const title = String(raw.title ?? '').trim()
  const narration = String(raw.narration ?? raw.body ?? '').trim()
  if (!narration) {
    throw invalidRequest(`scenes[${index}].narration 不能为空`)
  }
  if (narration.length > 2000) {
    throw invalidRequest(`scenes[${index}].narration 过长（${narration.length} 字符，上限 2000）`)
  }
  const duration = raw.duration_seconds
  const explicitDuration = duration === undefined || duration === null
    ? null
    : Number(duration)
  if (explicitDuration !== null && (!Number.isFinite(explicitDuration) || explicitDuration <= 0 || explicitDuration > 600)) {
    throw invalidRequest(`scenes[${index}].duration_seconds 必须是 0–600 之间的正数`)
  }
  return {
    scene_id: String(raw.scene_id ?? '').trim() || `scene-${String(index + 1).padStart(3, '0')}`,
    title: title || `第 ${index + 1} 幕`,
    narration,
    // 画面正文：默认与旁白一致；也可独立指定更精简的屏显文案。
    body: String(raw.body ?? narration).trim() || narration,
    cite: String(raw.cite ?? raw.citation ?? '').trim(),
    // 可选背景图（本地绝对路径）。素材由用户自备/自取，版权责任在使用者；
    // 缺省或加载失败时维持程序化渐变底，不影响可分发性。
    image: String(raw.image ?? '').trim(),
    duration_seconds: explicitDuration,
    // Agent 从 prts 语料取的原文证据，随项目留档以便复核。
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
  }
}

/** 新建项目。 */
export async function createProject(outputDir, { title, scenes }) {
  const projectId = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
  const normalizedScenes = (scenes ?? []).map((scene, index) => normalizeScene(scene, index))
  const now = new Date().toISOString()
  const manifest = {
    schema_version: 1,
    project_id: projectId,
    title: String(title ?? '').trim() || '未命名视频',
    state: normalizedScenes.length ? 'scripted' : 'draft',
    created_at: now,
    updated_at: now,
    scenes: normalizedScenes,
    timeline: null,
    artifacts: {},
  }
  await saveProject(outputDir, manifest)
  return manifest
}

/** 覆盖项目分镜（剧本阶段）。 */
export async function updateScenes(outputDir, id, scenes) {
  const manifest = await loadProject(outputDir, id)
  if (manifest.state === 'built') {
    throw invalidState('成片已生成；如需改稿请新建项目，或先用 video_build 的 force 选项重建')
  }
  manifest.scenes = (scenes ?? []).map((scene, index) => normalizeScene(scene, index))
  if (!manifest.scenes.length) throw invalidRequest('scenes 不能为空')
  manifest.state = 'scripted'
  // 剧本变更使下游产物失效，显式清空时间线与产物，避免交付过期成片。
  manifest.timeline = null
  manifest.artifacts = {}
  manifest.updated_at = new Date().toISOString()
  await saveProject(outputDir, manifest)
  return manifest
}

/**
 * 解析分镜时长。
 *
 * 优先级：分镜显式 duration_seconds > 实测音频时长 > 按字数估算。
 * 显式时长会拉伸画面停留时间，不会裁掉音频（音频始终完整播放）。
 */
function resolveSceneDuration(scene, measured) {
  if (scene.duration_seconds !== null && scene.duration_seconds !== undefined) {
    return { video: scene.duration_seconds, audio: measured }
  }
  return { video: measured, audio: measured }
}

/**
 * 渲染分镜画面（rendered 阶段）。
 * @returns {Promise<object>} 更新后的清单。
 */
export async function renderProject(outputDir, id, options) {
  const manifest = await loadProject(outputDir, id)
  if (!manifest.scenes.length) {
    throw invalidState('项目还没有分镜。请先用 video_script 写入剧本。')
  }
  const dir = projectDir(outputDir, id)
  const frameDir = join(dir, 'frames')
  await mkdir(frameDir, { recursive: true })

  const scenes = manifest.scenes.map((scene, index) => ({
    ...scene,
    framePath: join(frameDir, `${String(index).padStart(3, '0')}-${scene.scene_id}.png`),
  }))

  await renderScenes(scenes, { ...options, theme: options.theme })

  // 只把可序列化的相对路径写回清单，避免把绝对路径泄漏给模型。
  manifest.scenes = scenes.map(({ framePath, ...scene }) => ({
    ...scene,
    frame_file: `frames/${framePath.split(/[\\/]/u).pop()}`,
  }))
  if (STATE_ORDER[manifest.state] < STATE_ORDER.rendered) manifest.state = 'rendered'
  manifest.updated_at = new Date().toISOString()
  await saveProject(outputDir, manifest)
  return manifest
}

/**
 * 生成配音与字幕（voiced 阶段）。
 *
 * 这是整条链路里唯一需要网络（edge-tts）的步骤；`tts.provider: none`
 * 时改为按时长估算，产出无声视频与字幕，保证离线也能跑通。
 * @returns {Promise<object>} 更新后的清单。
 */
export async function voiceProject(outputDir, id, { config, signal, maxCharsPerLine }) {
  const manifest = await loadProject(outputDir, id)
  if (!manifest.scenes.length) throw invalidState('项目还没有分镜。请先用 video_script 写入剧本。')

  const dir = projectDir(outputDir, id)
  const audioDir = join(dir, 'audio')
  await mkdir(audioDir, { recursive: true })

  const timeline = []
  const cues = []
  let cursor = 0

  for (const [index, scene] of manifest.scenes.entries()) {
    const audioFile = join(audioDir, `${String(index).padStart(3, '0')}-${scene.scene_id}.mp3`)
    let boundaries = []
    let measured

    if (config.tts.provider === 'none') {
      measured = estimateSilentDuration(scene.narration)
    } else {
      boundaries = await synthesize({
        text: scene.narration,
        voice: config.tts.voice,
        outFile: audioFile,
        ttsConfig: config.tts,
        signal,
      })
      measured = await probeDuration(await resolveFfmpeg(config.ffmpegPath), audioFile)
    }

    const { video } = resolveSceneDuration(scene, measured)
    // 有词级时间戳就用它，否则退回按标点与字符占比估算。
    const sceneCues = boundaries.length
      ? cuesFromBoundaries(boundaries, { baseOffset: cursor, maxCharsPerLine })
      : cuesFromText(scene.narration, measured, cursor)

    cues.push(...sceneCues)
    timeline.push({
      scene_id: scene.scene_id,
      start: Number(cursor.toFixed(3)),
      end: Number((cursor + video).toFixed(3)),
      audio_seconds: Number(measured.toFixed(3)),
      video_seconds: Number(video.toFixed(3)),
      boundary_count: boundaries.length,
      audio_file: config.tts.provider === 'none' ? null : `audio/${audioFile.split(/[\\/]/u).pop()}`,
    })
    cursor += video
  }

  manifest.timeline = {
    duration_seconds: Number(cursor.toFixed(3)),
    scenes: timeline,
    subtitle_source: timeline.some((entry) => entry.boundary_count > 0) ? 'word-boundary' : 'estimated',
  }

  // 字幕与清单一起落盘，便于用户单独取用。
  await writeFile(join(dir, 'subtitle.ass'), buildAss(cues, {
    width: config.render.width,
    height: config.render.height,
    fontFamily: config.render.subtitleFontFamily,
    fontSize: config.render.subtitleFontSize,
    marginV: config.render.subtitleMarginV,
  }), 'utf8')
  await writeFile(join(dir, 'subtitle.srt'), buildSrt(cues), 'utf8')

  manifest.artifacts = {
    ...manifest.artifacts,
    subtitle_ass: 'subtitle.ass',
    subtitle_srt: 'subtitle.srt',
    voice_file: config.tts.provider === 'none' ? null : 'voice.m4a',
  }
  if (STATE_ORDER[manifest.state] < STATE_ORDER.voiced) manifest.state = 'voiced'
  manifest.updated_at = new Date().toISOString()
  await saveProject(outputDir, manifest)
  return manifest
}

/**
 * 合成成片（built 阶段）。
 *
 * 步骤刻意拆成两次 ffmpeg 调用：
 *   1) 生成静音底视频（分镜 PNG 序列 + 时长）；
 *   2) 有配音时复用第 1 步画面，把音轨与烧入字幕一次编码到位。
 * 拆开的好处是「画面」和「声音」可以独立重试，出错时定位更快。
 * @returns {Promise<object>} 更新后的清单。
 */
export async function buildProject(outputDir, id, { config, signal, force = false }) {
  const manifest = await loadProject(outputDir, id)
  if (!manifest.scenes.length) throw invalidState('项目还没有分镜。请先用 video_script 写入剧本。')
  if (manifest.state === 'built' && !force) {
    throw invalidState(
      `项目已生成成片（${manifest.artifacts?.output_file ?? 'episode.mp4'}）。`
      + '如需重建请传 force=true。',
    )
  }
  if (manifest.state !== 'voiced' && manifest.state !== 'rendered' && manifest.state !== 'built') {
    // 允许直接从 rendered 进入：此时还没有配音，走无声分支。
    if (manifest.state !== 'rendered') {
      throw invalidState(
        `当前状态是 ${manifest.state}，无法合成。请先执行 video_build 的 stage="render"，再执行 stage="voice"。`,
      )
    }
  }

  const dir = projectDir(outputDir, id)
  const ffmpeg = await resolveFfmpeg(config.ffmpegPath)
  const frames = manifest.scenes.map((scene, index) => {
    const name = scene.frame_file ?? `${String(index).padStart(3, '0')}-${scene.scene_id}.png`
    return join(dir, 'frames', name.split(/[\\/]/u).pop())
  })
  for (const frame of frames) {
    if (!existsSync(frame)) {
      throw invalidState(
        `缺少画面文件 ${frame.split(/[\\/]/u).pop()}。请先执行 video_build 的 stage="render"。`,
      )
    }
  }

  // 每个分镜的停留时长：优先用时间线，缺失时退回分镜声明 / 估算。
  const durations = manifest.scenes.map((scene, index) => {
    const entry = manifest.timeline?.scenes?.[index]
    if (entry?.video_seconds) return entry.video_seconds
    if (scene.duration_seconds) return scene.duration_seconds
    return estimateSilentDuration(scene.narration)
  })

  // concat demuxer 会忽略最后一条 `duration`（已知行为）：末帧只显示一帧的时长，
  // 成片比时间线短一个分镜。标准修法是把最后一张图再写一遍，让它的时长生效。
  const concatLines = frames.map((frame, index) =>
    `file '${frame.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${durations[index]}`)
  concatLines.push(`file '${frames.at(-1).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  const concatFile = join(dir, 'concat.txt')
  await writeFile(concatFile, `${concatLines.join('\n')}\n`, 'utf8')

  const voiceFile = manifest.artifacts?.voice_file ? join(dir, manifest.artifacts.voice_file) : null
  const hasVoice = Boolean(voiceFile && config.tts.provider !== 'none')

  // 有配音时，先把各分镜音频按同样的边界拼成一条音轨。
  let audioTrack = null
  if (hasVoice) {
    const audioFiles = (manifest.timeline?.scenes ?? [])
      .map((entry) => entry.audio_file)
      .filter(Boolean)
      .map((rel) => join(dir, rel))
    if (audioFiles.length) {
      const audioList = join(dir, 'audio-list.txt')
      await writeFile(audioList, audioFiles.map((file) =>
        `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8')
      audioTrack = join(dir, 'voice.m4a')
      const concatAudio = await runProcess(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', audioList,
        '-c:a', 'aac', '-b:a', '160k', audioTrack,
      ], { signal, timeoutMs: 900_000 })
      if (concatAudio.code !== 0) {
        throw processFailure('拼接音轨失败', { stderr: summarizeFfmpegError(concatAudio.stderr) })
      }
    }
  }

  const subtitleAss = join(dir, 'subtitle.ass')
  const useSubtitles = existsSync(subtitleAss)
  // 关键：concat 出来的图片序列只有稀疏 PTS（每个分镜一帧，落在 0 / 4.68 / 9.24…），
  // 字幕滤镜逐帧判断时间区间，拿不到中间帧就整段不渲染，且 ffmpeg 仍返回 0。
  // 因此必须先 fps 归一化成连续帧，再烧字幕。
  const videoChain = useSubtitles
    ? `fps=${config.render.fps},subtitles=${buildSubtitleFileArg(subtitleAss)}`
    : null

  // BGM 是可选层：素材由用户自备，找不到就静默跳过，不影响出片。
  const totalDuration = durations.reduce((sum, value) => sum + value, 0)
  const bgmTrack = await resolveBgmTrack(config.bgm, dir)
  const useBgm = Boolean(bgmTrack)

  const outputFile = join(dir, 'episode.mp4')
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatFile]

  const hasRealVoice = Boolean(audioTrack && existsSync(audioTrack))
  if (hasRealVoice) {
    args.push('-i', audioTrack)
  } else {
    // 无声分支：补一条静音轨，保证容器结构一致，方便后续替换配音。
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
  }

  if (useBgm) {
    // -stream_loop -1 让短曲循环覆盖整片；用 -shortest 在视频结束时收尾。
    args.push('-stream_loop', '-1', '-i', bgmTrack.file)
  }

  // 视频链要加字幕时必须走 filter_complex：ffmpeg 不允许对同一输出
  // 同时使用 -vf 与 -filter_complex 的音频标签，混用会报
  // "Simple and complex filtering cannot be used for the same output stream"。
  const bgmFilters = useBgm
    ? buildBgmFilters({
      durationSeconds: totalDuration,
      volume: config.bgm.volume,
      fadeInSeconds: config.bgm.fadeInSeconds,
      fadeOutSeconds: config.bgm.fadeOutSeconds,
    })
    : null
  const mix = useBgm
    ? buildMixFilter({ voiceLabel: '1:a', bgmLabel: '2:a', bgmFilters })
    : null

  if (mix) {
    const parts = []
    if (videoChain) parts.push(`[0:v]${videoChain}[vout]`)
    parts.push(mix.filter)
    args.push('-filter_complex', parts.join(';'))
    if (videoChain) args.push('-map', '[vout]')
    else args.push('-map', '0:v')
    args.push('-map', `[${mix.outputLabel}]`)
  } else if (videoChain) {
    args.push('-vf', videoChain)
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', config.render.preset,
    '-crf', String(config.render.crf),
    '-pix_fmt', 'yuv420p',
    '-r', String(config.render.fps),
    '-c:a', 'aac', '-b:a', '160k',
    '-shortest',
    outputFile,
  )

  const result = await runProcess(ffmpeg, args, { signal, timeoutMs: 3_600_000 })
  if (result.code !== 0) {
    throw processFailure('ffmpeg 合成失败', {
      stderr: summarizeFfmpegError(result.stderr),
      hint: useSubtitles
        ? '若画面正常但字幕缺失，请确认字幕字体族名是系统真实字体（默认 Microsoft YaHei）。'
        : undefined,    })
  }

  const duration = await probeDuration(ffmpeg, outputFile).catch(() => manifest.timeline?.duration_seconds ?? null)

  manifest.state = 'built'
  manifest.artifacts = {
    ...manifest.artifacts,
    output_file: 'episode.mp4',
    output_path: resolve(outputFile),
    duration_seconds: duration,
    subtitles_burned_in: Boolean(videoChain),
    bgm: describeBgm(bgmTrack, config.bgm),
  }
  manifest.updated_at = new Date().toISOString()
  await saveProject(outputDir, manifest)
  return manifest
}

/** 删除项目及其产物。 */
export async function removeProject(outputDir, id) {
  const manifest = await loadProject(outputDir, id)
  await rm(projectDir(outputDir, id), { recursive: true, force: true })
  return manifest
}
