/**
 * Agent 工具定义。
 *
 * 不经 defineTool：直接向 `ctx.tools` 注册原始 ToolDefinition，避免与宿主
 * dsh-tools 的版本漂移；契约（parameters / output.schema）在本文件内自持。
 *
 * 工具面刻意分为「写剧本」与「出片」两组，让 Agent 能分步纠错：
 *   video_project  create / list / show / delete
 *   video_script   写入或覆盖分镜（含 prts 原文引用）
 *   video_build    render / voice / build / all
 *   video_doctor   环境自检（ffmpeg / Python / 字体 / 目录）
 * @module arknights-video/tools
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { invalidRequest } from './errors.js'
import { detectEdgeTts, DEFAULT_OUTPUT_FILE } from './tts.js'
import { normalizeBgm, listBgmTracks, resolveBgmTrack } from './bgm.js'
import { resolveFfmpeg } from './ffmpeg.js'
import { ensureCanvasFont, CANVAS_FONT_PROBE } from './render.js'
import {
  buildProject, createProject, listProjects, loadProject, normalizeScene,
  PROJECT_STATES, projectDir, removeProject, renderProject, updateScenes, voiceProject,
} from './project.js'

/** 工具名前缀，避免与其它插件冲突。 */
export const TOOL_PREFIX = 'video_'

const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description })

/** video_project 的参数。 */
const PROJECT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'show', 'delete'],
      description: 'create 新建；list 列出；show 查看一个项目；delete 删除项目及其产物',
    },
    project_id: { type: 'string', description: '项目 id；show / delete 必填' },
    title: { type: 'string', description: '视频标题；create 可选' },
    scenes: {
      type: 'array',
      description: 'create 时可直接附带分镜；也可之后再调用 video_script 写入',
      items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', description: '分镜标题，出现在画面上方' },
        narration: { type: 'string', description: '旁白文本，用于配音与字幕' },
        body: { type: 'string', description: '屏显正文；省略时复用 narration' },
        cite: { type: 'string', description: '出处脚注，建议用《篇章名》第 N 行' },
        duration_seconds: { type: 'number', description: '覆盖画面停留时长；省略时用音频实测时长' },
        evidence: stringList('该分镜依据的语料证据，随项目留档'),
      } },
    },
  },
}

/** video_script 的参数。 */
const SCRIPT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'scenes'],
  properties: {
    project_id: { type: 'string' },
    scenes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['narration'], properties: {
        title: { type: 'string' },
        narration: { type: 'string', description: '旁白文本；必填' },
        body: { type: 'string' },
        cite: { type: 'string' },
        duration_seconds: { type: 'number' },
        evidence: stringList('该分镜依据的语料证据'),
      } },
    },
  },
}

/** video_build 的参数。 */
const BUILD_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['project_id'],
  properties: {
    project_id: { type: 'string' },
    stage: {
      type: 'string',
      enum: ['render', 'voice', 'build', 'all'],
      description: 'render 只渲染画面；voice 生成配音与字幕；build 合成成片；all 依次全部执行（默认）',
    },
    force: { type: 'boolean', description: '已生成成片时允许重建' },
    voice: { type: 'string', description: '覆盖配音音色，如 zh-CN-YunxiNeural' },
    max_chars_per_line: { type: 'integer', description: '单行字幕最大字符数，默认 18' },
    bgm: {
      type: 'object',
      additionalProperties: false,
      description: '本次出片的背景音乐覆盖项；素材由用户自备，缺素材时自动跳过',
      properties: {
        enabled: { type: 'boolean', description: '是否启用 BGM' },
        dir: { type: 'string', description: 'BGM 素材目录，自动取其中第一个音频文件' },
        track: { type: 'string', description: '指定单个音频文件（优先于 dir）' },
        volume: { type: 'number', description: 'BGM 音量倍数，默认 0.18，建议不超过 0.3' },
        fade_in_seconds: { type: 'number', description: '片头淡入秒数，默认 1.5' },
        fade_out_seconds: { type: 'number', description: '片尾淡出秒数，默认 2' },
      },
    },
  },
}

/** video_doctor 的参数。 */
const DOCTOR_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

/** video_bgm 的参数：查看用户自备的 BGM 素材。 */
const BGM_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'preview'],
      description: 'list 列出素材目录里的曲目与当前选中项；preview 只报告当前会用哪一首',
    },
    dir: {
      type: 'string',
      description: '临时查看某个目录，不修改配置；省略时用 bgm.dir',
    },
  },
}

/** 统一的输出 schema：工具返回结构化结果，render 负责转成模型可见文本。 */
const outputSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
})

const PROJECT_OUTPUT = outputSchema({
  status: { type: 'string' },
  project_id: { type: 'string' },
  title: { type: 'string' },
  state: { type: 'string' },
  scene_count: { type: 'integer' },
  projects: { type: 'array', items: { type: 'object' } },
  scenes: { type: 'array', items: { type: 'object' } },
  artifacts: { type: 'object' },
  timeline: { type: 'object' },
  message: { type: 'string' },
}, ['status'])

const BUILD_OUTPUT = outputSchema({
  status: { type: 'string' },
  project_id: { type: 'string' },
  state: { type: 'string' },
  stage: { type: 'string' },
  output_file: { type: 'string' },
  output_path: { type: 'string' },
  duration_seconds: { type: 'number' },
  scenes: { type: 'array', items: { type: 'object' } },
  subtitle_source: { type: 'string' },
  bgm: { type: 'object' },
  message: { type: 'string' },
}, ['status'])

const DOCTOR_OUTPUT = outputSchema({
  status: { type: 'string' },
  checks: { type: 'array', items: { type: 'object' } },
  ready: { type: 'boolean' },
  message: { type: 'string' },
}, ['status', 'checks', 'ready'])

const BGM_OUTPUT = outputSchema({
  status: { type: 'string' },
  enabled: { type: 'boolean' },
  dir: { type: 'string' },
  selected: { type: 'string' },
  tracks: { type: 'array', items: { type: 'string' } },
  count: { type: 'integer' },
  message: { type: 'string' },
}, ['status'])

/** 把项目清单投影成模型可见的摘要，避免把绝对路径与内部字段暴露给模型。 */
function projectSummary(manifest) {
  return {
    project_id: manifest.project_id,
    title: manifest.title,
    state: manifest.state,
    scene_count: manifest.scenes?.length ?? 0,
    updated_at: manifest.updated_at,
  }
}

/** 分镜摘要：带行号，便于 Agent 后续精确改写。 */
function sceneSummary(scene, index) {
  return {
    index: index + 1,
    scene_id: scene.scene_id,
    title: scene.title,
    narration: scene.narration,
    cite: scene.cite || null,
    duration_seconds: scene.duration_seconds ?? null,
  }
}

/**
 * 注册全部工具。
 *
 * 每个 `tools.register` 返回精确的 disposer；这里统一收集并在 fiber 释放时
 * 走 `ctx.effect`，保证热重载或禁用插件后不留下悬空注册。
 * @param {object} ctx - 注入了 tools 的 Cordis 上下文。
 * @param {object} runtime - 运行时依赖（配置读取、输出目录解析）。
 * @returns {() => void} 释放函数。
 */
export function mountVideoTools(ctx, runtime) {
  const tools = ctx.tools
  const disposers = []

  const register = (definition) => {
    disposers.push(tools.register(definition))
  }

  register({
    name: 'video_project',
    description:
      '管理明日方舟剧情解说视频项目：新建、列出、查看或删除。'
      + '新建后用 video_script 写入分镜脚本，再用 video_build 出片。',
    parameters: PROJECT_PARAMETERS,
    output: { schema: PROJECT_OUTPUT, render: renderProjectResult },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const { outputDir } = await runtime.resolve()
      const action = args?.action
      if (action === 'list') {
        const projects = await listProjects(outputDir)
        return { status: 'ok', projects, message: projects.length ? `共 ${projects.length} 个项目` : '还没有任何项目' }
      }
      if (action === 'create') {
        const manifest = await createProject(outputDir, { title: args.title, scenes: args.scenes })
        return {
          status: 'ok',
          ...projectSummary(manifest),
          scenes: manifest.scenes.map(sceneSummary),
          message: `已创建项目 ${manifest.project_id}。下一步用 video_script 写入或改写分镜。`,
        }
      }
      if (action === 'show') {
        const manifest = await loadProject(outputDir, requireProjectId(args))
        return {
          status: 'ok',
          ...projectSummary(manifest),
          scenes: manifest.scenes.map(sceneSummary),
          timeline: manifest.timeline ?? undefined,
          artifacts: manifest.artifacts,
        }
      }
      if (action === 'delete') {
        const manifest = await removeProject(outputDir, requireProjectId(args))
        return { status: 'ok', project_id: manifest.project_id, message: `已删除项目 ${manifest.project_id}` }
      }
      throw invalidRequest(`未知 action：${JSON.stringify(action)}`)
    },
  })

  register({
    name: 'video_script',
    description:
      '写入或整体覆盖一个视频项目的分镜脚本。'
      + '每个分镜含标题、旁白（用于配音与字幕）、屏显正文与出处；'
      + '引用格式建议《篇章名》第 N 行，出处与 evidence 会随项目留档。',
    parameters: SCRIPT_PARAMETERS,
    output: { schema: PROJECT_OUTPUT, render: renderProjectResult },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const { outputDir } = await runtime.resolve()
      const manifest = await updateScenes(outputDir, requireProjectId(args), args.scenes)
      return {
        status: 'ok',
        ...projectSummary(manifest),
        scenes: manifest.scenes.map(sceneSummary),
        message: `已写入 ${manifest.scenes.length} 个分镜。下一步用 video_build 出片。`,
      }
    },
  })

  register({
    name: 'video_build',
    description:
      '渲染并合成视频成片。stage="all" 依次执行画面渲染、配音与字幕、ffmpeg 合成。'
      + '需要配音时会调用 edge-tts（需 python -m pip install edge-tts）；'
      + '若环境不可用可在配置中把 tts.provider 设为 none 生成无声视频。',
    parameters: BUILD_PARAMETERS,
    output: { schema: BUILD_OUTPUT, render: renderBuildResult },
    timeoutMs: 3_600_000,
    // 渲染与合成会写同一项目目录，禁止并发以免产物互相覆盖。
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const { outputDir, config } = await runtime.resolve()
      const projectId = requireProjectId(args)
      const stage = args?.stage ?? 'all'
      const effectiveConfig = args?.voice
        ? { ...config, tts: { ...config.tts, voice: args.voice } }
        : config
      // 单次调用的 BGM 覆盖：只覆盖显式传入的字段，其余沿用配置。
      if (args?.bgm) {
        effectiveConfig.bgm = normalizeBgm({ ...config.bgm, ...args.bgm })
      }

      if (stage === 'render' || stage === 'all') {
        await renderProject(outputDir, projectId, { ...effectiveConfig.render, theme: effectiveConfig.theme })
      }
      if (stage === 'voice' || stage === 'all') {
        await voiceProject(outputDir, projectId, {
          config: effectiveConfig,
          signal: exec?.signal,
          maxCharsPerLine: args?.max_chars_per_line,
        })
      }

      let manifest = await loadProject(outputDir, projectId)
      if (stage === 'build' || stage === 'all') {
        manifest = await buildProject(outputDir, projectId, {
          config: effectiveConfig,
          signal: exec?.signal,
          force: args?.force === true,
        })
      } else {
        manifest = await loadProject(outputDir, projectId)
      }

      return {
        status: 'ok',
        project_id: manifest.project_id,
        state: manifest.state,
        stage,
        output_file: manifest.artifacts?.output_file ?? undefined,
        output_path: manifest.artifacts?.output_path ?? undefined,
        duration_seconds: manifest.artifacts?.duration_seconds ?? undefined,
        scenes: manifest.scenes.map(sceneSummary),
        subtitle_source: manifest.timeline?.subtitle_source ?? undefined,
        bgm: manifest.artifacts?.bgm ?? undefined,
        message: stage === 'all' || stage === 'build'
          ? `成片已生成：${manifest.artifacts?.output_path ?? DEFAULT_OUTPUT_FILE}`
          : `已完成 stage=${stage}`,
      }
    },
  })

  register({
    name: 'video_doctor',
    description: '自检视频制作环境：ffmpeg、ffprobe、Python/edge-tts、中文字体与产物目录。出片失败时先运行它。',
    parameters: DOCTOR_PARAMETERS,
    output: { schema: DOCTOR_OUTPUT, render: renderDoctorResult },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const { outputDir, config } = await runtime.resolve()
      const checks = []

      // ffmpeg
      try {
        const ffmpeg = await resolveFfmpeg(config.ffmpegPath)
        const { runProcess } = await import('./ffmpeg.js')
        const version = await runProcess(ffmpeg, ['-version'], { timeoutMs: 30_000 })
        const first = (version.stdout || '').split('\n')[0] ?? ''
        checks.push({
          id: 'ffmpeg', ok: version.code === 0, detail: ffmpeg,
          note: first.trim() || 'ffmpeg 可用',
        })
      } catch (error) {
        checks.push({ id: 'ffmpeg', ok: false, detail: null, note: error.message })
      }

      // edge-tts
      if (config.tts.provider === 'none') {
        checks.push({ id: 'tts', ok: true, detail: 'none', note: '按配置跳过配音，将生成无声视频' })
      } else {
        const detected = await detectEdgeTts(config.tts.pythonPath).catch((error) => ({
          available: false, detail: error.message,
        }))
        checks.push({
          id: 'tts', ok: detected.available, detail: config.tts.pythonPath,
          note: detected.available
            ? `edge-tts 可用，音色 ${config.tts.voice}`
            : `edge-tts 不可用：${detected.detail}。安装：python -m pip install edge-tts`,
        })
      }

      // 字体
      const family = ensureCanvasFont()
      checks.push({
        id: 'font', ok: family === CANVAS_FONT_PROBE, detail: family,
        note: family === CANVAS_FONT_PROBE
          ? `已加载中文字体；字幕字体族名为 ${config.render.subtitleFontFamily}`
          : '未找到候选中文字体，画面文字可能显示为方块',
      })

      // BGM：未启用视为通过；启用但找不到素材要给用户明确提示。
      if (!config.bgm.enabled) {
        checks.push({ id: 'bgm', ok: true, detail: '未启用', note: '未启用背景音乐' })
      } else {
        const track = await resolveBgmTrack(config.bgm).catch(() => null)
        checks.push({
          id: 'bgm', ok: Boolean(track), detail: track?.file ?? null,
          note: track
            ? `BGM 就绪：${track.file.split(/[\\/]/u).pop()}（候选 ${track.available.length} 个）`
            : '已启用 BGM 但未找到素材；请把音频放入 bgm.dir，或关闭 bgm.enabled',
        })
      }

      // 产物目录
      try {
        await mkdir(outputDir, { recursive: true })
        checks.push({
          id: 'output_dir', ok: existsSync(outputDir), detail: outputDir,
          note: `可写产物目录：${outputDir}`,
        })
      } catch (error) {
        checks.push({ id: 'output_dir', ok: false, detail: outputDir, note: `目录不可用：${error.message}` })
      }

      const ready = checks.every((check) => check.ok)
      return {
        status: 'ok',
        checks,
        ready,
        message: ready ? '环境自检通过，可以出片。' : '存在未通过的检查项，请按 note 处理。',
      }
    },
  })

  register({
    name: 'video_bgm',
    description:
      '查看用户自备的背景音乐素材：列出目录里的曲目、当前会选中哪一首。'
      + '插件不附带任何音乐，素材由用户提供；此处只做查看，不修改配置。',
    parameters: BGM_PARAMETERS,
    output: { schema: BGM_OUTPUT, render: renderBgmResult },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const { config, configPath } = await runtime.resolve()
      const action = args?.action ?? 'list'

      // 临时查看别的目录时，相对路径同样以配置目录为基准，
      // 与 mergeConfig 的绝对化规则保持一致（否则又是一处基准歧义）。
      const rawDir = typeof args?.dir === 'string' && args.dir.trim() ? args.dir.trim() : null
      const probeDir = rawDir
        ? (isAbsolute(rawDir) ? rawDir : resolve(dirname(configPath), rawDir))
        : config.bgm.dir

      if (!probeDir) {
        return {
          status: 'ok',
          enabled: config.bgm.enabled,
          dir: '',
          count: 0,
          tracks: [],
          message: '尚未配置 BGM 素材目录。请在 $DSH_HOME/arknights-video.json 里设置 '
            + 'bgm.dir（或 bgm.track 指定单曲），把自备的音频放进去即可。',
        }
      }

      const tracks = await listBgmTracks(probeDir).catch(() => null)
      if (tracks === null) {
        return {
          status: 'ok',
          enabled: config.bgm.enabled,
          dir: probeDir,
          count: 0,
          tracks: [],
          message: `目录不存在或不可读：${probeDir}`,
        }
      }
      if (!tracks.length) {
        return {
          status: 'ok',
          enabled: config.bgm.enabled,
          dir: probeDir,
          count: 0,
          tracks: [],
          message: `目录里没有可用的音频文件：${probeDir}。`
            + '支持 mp3 / wav / m4a / aac / flac / ogg / opus。',
        }
      }

      // 选中项：显式 track > 目录内第一个（与出片逻辑一致）。
      const track = await resolveBgmTrack({ ...config.bgm, enabled: true, dir: probeDir }).catch(() => null)
      const selectedName = track?.file.split(/[\\/]/u).pop() ?? null
      return {
        status: 'ok',
        enabled: config.bgm.enabled,
        dir: probeDir,
        count: tracks.length,
        tracks: tracks.map((file) => file.split(/[\\/]/u).pop()),
        selected: selectedName ?? undefined,
        message: config.bgm.enabled
          ? `已启用 BGM，将使用「${selectedName}」（共 ${tracks.length} 首可选）。`
          : `找到 ${tracks.length} 首，但 bgm.enabled 为 false，出片时不会使用。`
            + `把 config 里的 bgm.enabled 设为 true 即可启用。`
            + (action === 'preview' ? '' : ''),
      }
    },
  })

  const dispose = () => { for (const disposeOne of disposers.splice(0)) disposeOne?.() }
  ctx.effect?.(() => dispose, 'arknights-video: tools')
  return dispose
}

/** 从参数里取项目 id，缺失时给出可操作的错误。 */
function requireProjectId(args) {
  const id = args?.project_id
  if (typeof id !== 'string' || !id.trim()) {
    throw invalidRequest('缺少 project_id。可先用 video_project action="list" 查看已有项目。')
  }
  return id.trim()
}

/** 模型可见文本：video_project / video_script 的结果。 */
export function renderProjectResult(_args, value) {
  if (value.status !== 'ok') {
    return [{ type: 'text', text: `[video_project:error] ${value.message ?? '未知错误'}` }]
  }
  const lines = []
  if (value.projects) {
    lines.push(`已有项目 ${value.projects.length} 个：`)
    for (const project of value.projects) {
      lines.push(`- ${project.project_id} | ${project.title} | ${project.state} | ${project.scene_count} 分镜`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(`项目 ${value.project_id}｜${value.title}｜状态 ${value.state}｜${value.scene_count} 分镜`)
  if (value.scenes?.length) {
    lines.push('分镜：')
    for (const scene of value.scenes) {
      lines.push(`${scene.index}. ${scene.title}${scene.cite ? `（${scene.cite}）` : ''}`)
      lines.push(`   旁白：${scene.narration}`)
    }
  }
  if (value.message) lines.push(value.message)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 模型可见文本：video_build 的结果。 */
export function renderBuildResult(_args, value) {
  if (value.status !== 'ok') {
    return [{ type: 'text', text: `[video_build:error] ${value.message ?? '未知错误'}` }]
  }
  const lines = [`项目 ${value.project_id}｜状态 ${value.state}｜stage=${value.stage}｜${value.scenes?.length ?? 0} 分镜`]
  if (value.subtitle_source) {
    lines.push(`字幕时间轴来源：${value.subtitle_source === 'word-boundary' ? 'TTS 词级时间戳' : '按时长估算'}`)
  }
  if (value.bgm) {
    lines.push(value.bgm.enabled
      ? `BGM：${value.bgm.file}（音量 ${value.bgm.volume}，候选 ${value.bgm.candidates} 个）`
      : `BGM：未使用（${value.bgm.reason}）`)
  }
  if (value.output_path) lines.push(`成片：${value.output_path}（${value.duration_seconds ?? '?'} 秒）`)
  else lines.push(value.message ?? '')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 模型可见文本：video_bgm 的结果。 */
export function renderBgmResult(_args, value) {
  if (value.status !== 'ok') {
    return [{ type: 'text', text: `[video_bgm:error] ${value.message ?? '未知错误'}` }]
  }
  const lines = [`BGM 素材目录：${value.dir || '（未配置）'}`]
  if (value.tracks?.length) {
    lines.push(`共 ${value.count} 首：`)
    for (const name of value.tracks) {
      lines.push(`  ${name === value.selected ? '▶' : ' '} ${name}`)
    }
  }
  if (value.message) lines.push(value.message)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 模型可见文本：video_doctor 的结果。 */
export function renderDoctorResult(_args, value) {
  const lines = [`环境自检：${value.ready ? '通过' : '未通过'}`]
  for (const check of value.checks ?? []) {
    lines.push(`${check.ok ? '[OK]  ' : '[FAIL]'} ${check.id}：${check.note}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}
