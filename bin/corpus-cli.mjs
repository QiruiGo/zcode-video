#!/usr/bin/env node
/**
 * 明日方舟语料检索 CLI —— ZCode 工作流的「查证」节点。
 *
 * 直接复用 prts-terrarchive（MIT）的检索引擎：CorpusStore + executeSearch /
 * executeRead / executeTimelineSearch / ensureCorpusRelease，不引入 DSH 运行时。
 * 语料目录默认在 zcode-video/corpus/releases，与 DSH 的资料互不影响。
 *
 * 用法：
 *   node bin/corpus-cli.mjs status
 *   node bin/corpus-cli.mjs download [--release <id>]
 *   node bin/corpus-cli.mjs search --query 凯尔希 --types character_wiki --sections 相关活动
 *   node bin/corpus-cli.mjs read --stage-code 6-2 [--part before] [--line 12]
 *   node bin/corpus-cli.mjs read --character 凯尔希 --material profile
 *   node bin/corpus-cli.mjs read --activity 孤星 --mode activity
 *   node bin/corpus-cli.mjs read --title "标题" --line 3 --max-lines 80
 *   node bin/corpus-cli.mjs timeline --entities 凯尔希 --year-start 1102 --year-end 1102
 *
 * 公共参数：--json 输出原始 JSON；--corpus <dir> 指定语料 releases 目录。
 * 结果默认走插件自带的 render 投影（人读友好）；翻页锚点 next_after /
 * page.continuation 会原样出现在输出里，下次调用原样传回即可。
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(ROOT, 'node_modules', 'prts-terrarchive', 'src')

const mod = async (name) => import(pathToFileURL(join(ENGINE, name)).href)

/** 默认语料目录：zcode-video/corpus/releases（可用 --corpus 或 ZCODE_CORPUS_DIR 覆盖）。 */
function releasesDir(args) {
  const explicit = args.corpus ?? process.env.ZCODE_CORPUS_DIR
  return explicit ? resolve(explicit) : join(ROOT, 'corpus', 'releases')
}

/** 极简参数解析：--key value / --key=v / 重复 --key 累积为数组 / 布尔 flag。 */
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

const asList = (v) => v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap(
  (s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean)
const asInt = (v) => v === undefined ? undefined : Number.parseInt(String(v), 10)

/** --raw '<json>' 与具名 flag 合并：raw 优先，便于高级参数原样透传。 */
function withRaw(args, built) {
  if (!args.raw) return built
  const extra = JSON.parse(String(args.raw))
  return { ...built, ...extra }
}

async function openStore(args) {
  const dir = releasesDir(args)
  if (!existsSync(dir)) {
    console.error(`语料目录不存在：${dir}`)
    console.error('先执行：node bin/corpus-cli.mjs download')
    process.exit(2)
  }
  const { CorpusStore } = await mod('store.js')
  const store = new CorpusStore({ releasesDir: dir })
  await store.ready()
  return store
}

async function cmdStatus(args) {
  const dir = releasesDir(args)
  const { readCurrentReleasePointer, validateLocalRelease } = await mod('installer.js')
  const info = { releasesDir: dir, installed: false }
  if (existsSync(join(dir, 'current.json'))) {
    try {
      const pointer = await readCurrentReleasePointer(dir)
      const manifest = await validateLocalRelease(dir, pointer.release_id ?? pointer.releaseId, { verifyHashes: false })
      info.installed = true
      info.release_id = manifest.releaseId
      info.data_version = manifest.dataVersion
      info.document_count = manifest.documentCount ?? manifest.document_count
    } catch (error) {
      info.error = String(error?.message ?? error)
    }
  }
  console.log(JSON.stringify(info, null, 2))
}

async function cmdDownload(args) {
  const dir = releasesDir(args)
  const { ensureCorpusRelease } = await mod('installer.js')
  const started = Date.now()
  const result = await ensureCorpusRelease({
    releasesDir: dir,
    releaseId: args.release ? String(args.release) : null,
    signal: undefined,
    logger: { info: (m) => console.error(`[info] ${m}`), warn: (m) => console.error(`[warn] ${m}`) },
    onProgress: (p) => {
      if (p.phase === 'downloading') {
        const done = p.files_done ?? p.filesDone ?? '?'
        const total = p.files_total ?? p.filesTotal ?? '?'
        console.error(`[dl] ${done}/${total} 文件`)
      } else if (p.phase) {
        console.error(`[dl] ${p.phase}`)
      }
    },
  })
  console.log(JSON.stringify({ ...result, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), releasesDir: dir }, null, 2))
}

async function cmdSearch(args) {
  const store = await openStore(args)
  const { executeSearch, renderSearch } = await mod('search.js')
  const raw = withRaw(args, {
    query: args.query ? String(args.query) : undefined,
    games: asList(args.games),
    resource_types: asList(args.types ?? args['resource-types']),
    content_types: asList(args.content ?? args['content-types']),
    collection_names: asList(args.collection ?? args.collections),
    character_names: asList(args.characters),
    activity_names: asList(args.activities),
    story_names: asList(args.stories),
    entity_names: asList(args.entities),
    speakers: asList(args.speakers),
    wiki_sections: asList(args.sections ?? args['wiki-sections']),
    context_terms: asList(args.context),
    after: args.after ? JSON.parse(String(args.after)) : undefined,
  })
  const value = await executeSearch(store, raw, {
    allowedGames: asList(args.games) ?? ['arknights', 'endfield'],
  })
  if (args.json) { console.log(JSON.stringify(value, null, 2)); return }
  console.log(renderSearch(raw, value))
}

/**
 * 构造 corpus_read 契约。定位方式（恰好一个）：
 *   --source-ref / --uid / --title / --stage-code [--part] / --activity / --collection
 * 阅读方式（selection）：
 *   --line N（定点上下文）/ --section Wiki字段 / --range a:b / 整篇（默认）/ 活动·任务通读
 * 续读：--page '<上次输出的 page 对象 JSON>'
 */
async function buildReadContract(args, store, { documentUid, readContractFromCursor }) {
  const intentId = args.intent_id ? String(args.intent_id) : `cli-${randomUUID().slice(0, 8)}`

  if (args.page) {
    const page = JSON.parse(String(args.page))
    const restored = readContractFromCursor(page.continuation ?? page)
    return { ...restored, intent_id: intentId }
  }

  let locator
  if (args['source-ref']) locator = { source_ref: String(args['source-ref']) }
  else if (args.uid) locator = { document_uid: String(args.uid) }
  else if (args.title) locator = { display_title: String(args.title) }
  else if (args.activity) locator = { activity_name: String(args.activity) }
  else if (args.collection) locator = { collection_name: String(args.collection) }
  else if (args['stage-code']) {
    // 关卡代号是模型层便捷定位：用 store 的关卡索引解析成 uid。
    const record = await store.getDocumentByStoryStage(
      String(args['stage-code']), args.part ? String(args.part) : '')
    if (!record) {
      throw new Error(`未找到关卡 ${args['stage-code']} 对应的剧情文档；请先用 search 检索`)
    }
    const list = Array.isArray(record) ? record : [record]
    if (list.length > 1) {
      throw new Error(`关卡 ${args['stage-code']} 命中多篇（${list.map((r) => r.record?.document?.display_title ?? r.document?.display_title ?? '?').join(' / ')}）；请用 --part 或 search 消歧`)
    }
    const hit = list[0]
    const documentId = hit?.record?.document?.document_id ?? hit?.document?.document_id
    if (!documentId) throw new Error(`关卡 ${args['stage-code']} 解析结果异常`)
    locator = { document_uid: documentUid(documentId) }
  } else {
    throw new Error('需要一种定位方式：--source-ref / --uid / --title / --stage-code / --activity / --collection / --page')
  }

  const streamMode = locator.activity_name ? 'activity'
    : locator.collection_name ? 'collection' : null
  let selection
  if (args.section) selection = { mode: 'section', section: String(args.section) }
  else if (streamMode === 'activity') selection = { mode: 'activity', start_position: asInt(args['start-position']) ?? 1 }
  else if (streamMode === 'collection') {
    selection = { mode: 'collection', start_position: asInt(args['start-position']) ?? 1 }
    if (args.content) selection.content_types = asList(args.content)
  } else if (args.line !== undefined) {
    selection = { mode: 'around', center_line: asInt(args.line), before_lines: asInt(args.before) ?? 3, after_lines: asInt(args.after) ?? 3 }
  } else if (args.range) {
    const [a, b] = String(args.range).split(':').map((n) => Number.parseInt(n, 10))
    selection = { mode: 'range', start_line: a, end_line: b }
  } else {
    selection = { mode: 'document', start_line: asInt(args['start-line']) ?? 1 }
  }

  return {
    intent_id: intentId,
    locator,
    selection,
    format: 'lines',
    include_adjacent_documents: true,
    limits: {
      max_lines: asInt(args['max-lines']) ?? 100,
      max_chars: asInt(args['max-chars']) ?? 12000,
    },
  }
}

async function cmdRead(args) {
  const store = await openStore(args)
  const { executeRead, renderRead, readContractFromCursor } = await mod('read.js')
  const { documentUid } = await mod('store.js')
  const raw = await buildReadContract(args, store, { documentUid, readContractFromCursor })
  const value = await executeRead(store, raw, { signal: undefined })
  if (args.json) { console.log(JSON.stringify(value, null, 2)); return }
  console.log(renderRead(args, value))
}

async function cmdTimeline(args) {
  const store = await openStore(args)
  const { executeTimelineSearch, renderTimeline } = await mod('timeline.js')
  const raw = withRaw(args, {
    query: args.query ? String(args.query) : undefined,
    activity_names: asList(args.activities),
    entity_names: asList(args.entities),
    year_start: asInt(args['year-start']),
    year_end: asInt(args['year-end']),
    source_marker: args.marker ? String(args.marker) : undefined,
    max_results: asInt(args.max),
  })
  const value = await executeTimelineSearch(store, raw, { signal: undefined })
  if (args.json) { console.log(JSON.stringify(value, null, 2)); return }
  console.log(renderTimeline(args, value))
}

const [, , command, ...rest] = process.argv
const args = parseArgv(rest)
const commands = {
  status: cmdStatus,
  download: cmdDownload,
  search: cmdSearch,
  read: cmdRead,
  timeline: cmdTimeline,
}

if (!command || !commands[command]) {
  console.error('用法: node bin/corpus-cli.mjs <status|download|search|read|timeline> [参数]')
  process.exit(command ? 2 : 0)
}

commands[command](args).catch((error) => {
  console.error(`[corpus-cli] ${error?.code ? error.code + ': ' : ''}${error?.message ?? error}`)
  if (args.json) console.error(JSON.stringify({ stack: error?.stack }))
  process.exit(1)
})
