#!/usr/bin/env node
/**
 * 视频出片 CLI —— ZCode 工作流的「出片」节点。
 *
 * 复用 arknights-video 插件（MIT）的管线模块：project / render / tts /
 * subtitle / bgm / ffmpeg，不经 DSH 工具层。引擎源码已 vendored 到
 * ../engine/src（本目录自包含，随整个文件夹搬运即可）；项目格式与 DSH 版
 * 完全一致（project.json + subtitle.ass + episode.mp4），两边可以互相接手。
 *
 * 用法：
 *   node bin/video-cli.mjs doctor
 *   node bin/video-cli.mjs create --title "标题" --scenes-file scenes.json
 *   node bin/video-cli.mjs script <项目id> --scenes-file scenes.json
 *   node bin/video-cli.mjs render <项目id>          # 只出画面（快速预览排版）
 *   node bin/video-cli.mjs voice <项目id>           # 配音+字幕（provider=none 时为无声估算）
 *   node bin/video-cli.mjs build <项目id> [--force] # 合成成片
 *   node bin/video-cli.mjs all <项目id> [--force]   # render → voice → build
 *   node bin/video-cli.mjs list | show <项目id>
 *
 * 分镜文件（scenes.json）：[ { "title": "...", "narration": "...（必填）",
 *   "body": "屏显正文（省略用 narration）", "cite": "《篇章名》第 N 行",
 *   "evidence": ["依据的语料证据"] } ]
 * 配置：zcode-video/config.json（缺省用内置默认值；tts.provider=none 出无声片）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_SRC = join(ROOT, 'engine', 'src')
const src = (name) => import(pathToFileURL(join(ENGINE_SRC, name)).href)

function parseArgv(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) { args._.push(raw); continue }
    let key = raw.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq) }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { value = argv[++i] }
    else { value = true }
    if (value === true) { args[key] = true; continue }
    if (Array.isArray(args[key])) args[key].push(value)
    else if (args[key] !== undefined) args[key] = [args[key], value]
    else args[key] = value
  }
  return args
}

/** 配置：内置默认 ← zcode-video/config.json。基准目录 = zcode-video（相对路径以此为准）。 */
async function loadConfig(args) {
  const { mergeConfig } = await src('config.js')
  const configPath = join(ROOT, 'config.json')
  const user = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const patch = {}
  if (args.provider) patch.tts = { provider: String(args.provider) }
  const config = mergeConfig(patch, user, ROOT)
  const outputDir = config.outputDir ?? join(ROOT, 'output')
  return { config, outputDir, configPath }
}

async function readScenesFile(args) {
  if (!args['scenes-file'] && !args.scenes) {
    console.error('需要 --scenes-file <path>（或 --scenes \'<json 数组>\'）')
    process.exit(2)
  }
  const text = args['scenes-file']
    ? readFileSync(resolve(String(args['scenes-file'])), 'utf8')
    : String(args.scenes)
  return JSON.parse(text)
}

async function cmdDoctor() {
  const { config, outputDir, configPath } = await loadConfig(parseArgv([]))
  const { resolveFfmpeg } = await src('ffmpeg.js')
  const { ensureCanvasFont, CANVAS_FONT_PROBE } = await src('render.js')
  const { detectEdgeTts } = await src('tts.js')
  const lines = []
  try {
    const ffmpeg = await resolveFfmpeg(config.ffmpegPath)
    lines.push(['OK', `ffmpeg ${ffmpeg}`])
  } catch (error) { lines.push(['FAIL', `ffmpeg: ${error.message}`]) }
  try {
    const family = ensureCanvasFont()
    lines.push(['OK', `画布字体 ${family}；字幕字体族名 ${config.render.subtitleFontFamily}`])
  } catch (error) { lines.push(['FAIL', `字体: ${error.message}`]) }
  try {
    const tts = await detectEdgeTts(config.tts.pythonPath)
    lines.push([tts.available ? 'OK' : 'NOTE', tts.available
      ? `edge-tts 可用（音色 ${config.tts.voice}）`
      : `edge-tts 不可用（provider=${config.tts.provider} 时不需要）`])
  } catch { lines.push(['NOTE', 'edge-tts 检测失败']) }
  lines.push(['INFO', `tts.provider = ${config.tts.provider}（none = 无声视频）`])
  lines.push(['INFO', `输出目录 ${outputDir}`])
  lines.push(['INFO', `配置文件 ${configPath}${existsSync(configPath) ? '' : '（不存在，用默认值）'} ${CANVAS_FONT_PROBE ? '' : ''}`])
  for (const [tag, msg] of lines) console.log(`[${tag}] ${msg}`)
  if (lines.some(([t]) => t === 'FAIL')) process.exit(1)
}

async function cmdCreate(args) {
  const { createProject } = await src('project.js')
  const { outputDir } = await loadConfig(args)
  const scenes = await readScenesFile(args)
  const manifest = await createProject(outputDir, { title: args.title ? String(args.title) : undefined, scenes })
  console.log(JSON.stringify({ project_id: manifest.project_id, state: manifest.state, scenes: manifest.scenes.length }, null, 2))
}

async function cmdScript(args) {
  const { updateScenes } = await src('project.js')
  const { outputDir } = await loadConfig(args)
  const scenes = await readScenesFile(args)
  const manifest = await updateScenes(outputDir, args._[0], scenes)
  console.log(JSON.stringify({ project_id: manifest.project_id, state: manifest.state, scenes: manifest.scenes.length }, null, 2))
}

async function cmdRender(args) {
  const { renderProject } = await src('project.js')
  const { config, outputDir } = await loadConfig(args)
  const manifest = await renderProject(outputDir, args._[0], { ...config.render, theme: config.theme })
  console.log(JSON.stringify({ project_id: manifest.project_id, state: manifest.state, frames: manifest.scenes.map((s) => s.frame_file) }, null, 2))
}

async function cmdVoice(args) {
  const { voiceProject } = await src('project.js')
  const { config, outputDir } = await loadConfig(args)
  const manifest = await voiceProject(outputDir, args._[0], { config, maxCharsPerLine: args['max-chars'] ? Number(args['max-chars']) : undefined })
  console.log(JSON.stringify({
    project_id: manifest.project_id,
    state: manifest.state,
    duration_seconds: manifest.timeline?.duration_seconds,
    subtitle_source: manifest.timeline?.subtitle_source,
    artifacts: manifest.artifacts,
  }, null, 2))
}

async function cmdBuild(args) {
  const { buildProject } = await src('project.js')
  const { config, outputDir } = await loadConfig(args)
  const manifest = await buildProject(outputDir, args._[0], { config, force: Boolean(args.force) })
  console.log(JSON.stringify({
    project_id: manifest.project_id,
    state: manifest.state,
    output: manifest.artifacts.output_path,
    duration_seconds: manifest.artifacts.duration_seconds,
    subtitles_burned_in: manifest.artifacts.subtitles_burned_in,
  }, null, 2))
}

async function cmdAll(args) {
  await cmdRender(args)
  await cmdVoice(args)
  await cmdBuild(args)
}

async function cmdList(args) {
  const { listProjects } = await src('project.js')
  const { outputDir } = await loadConfig(args)
  const items = await listProjects(outputDir)
  console.log(JSON.stringify(items, null, 2))
}

async function cmdShow(args) {
  const { loadProject } = await src('project.js')
  const { outputDir } = await loadConfig(args)
  console.log(JSON.stringify(await loadProject(outputDir, args._[0]), null, 2))
}

const [, , command, ...rest] = process.argv
const args = parseArgv(rest)
const commands = {
  doctor: () => cmdDoctor(),
  create: cmdCreate,
  script: cmdScript,
  render: cmdRender,
  voice: cmdVoice,
  build: cmdBuild,
  all: cmdAll,
  list: cmdList,
  show: cmdShow,
}

if (!command || !commands[command] || (commands[command].length > 0 && !args._.length && command !== 'create' && command !== 'list')) {
  console.error('用法: node bin/video-cli.mjs <doctor|create|script|render|voice|build|all|list|show> [项目id] [参数]')
  if (command) process.exit(2)
  process.exit(0)
}

commands[command](args).catch((error) => {
  console.error(`[video-cli] ${error?.code ? error.code + ': ' : ''}${error?.message ?? error}`)
  process.exit(1)
})
