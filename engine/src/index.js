/**
 * arknights-video：基于 PRTS 语料的明日方舟剧情解说视频插件。
 *
 * 职责边界（与 prts-terrarchive 的约定保持一致）：
 *   - host 常驻实例只做配置管理与产物目录准备（config.registerTools !== true 时）；
 *   - Agent 工具由「PRTS 视频模式」或用户自定义预设按需注册。
 *
 * 本插件**不**复制 prts-terrarchive 的语料检索能力，而是在 PRTS 模式之上
 * 叠加影视化产物：检索由 prts-terrarchive 提供，写稿与出片由本插件提供。
 * @module arknights-video
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeConfig, readUserConfig, resolveConfigPath, resolveDshHome, resolveOutputDir } from './config.js'
import { mountVideoTools } from './tools.js'

/** Cordis 插件名（Loader 诊断用，与 Node 包名相互独立）。 */
export const name = 'arknights-video'

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {object} config - cordis.patch.yml 行内 config。
 * @returns {Promise<void>}
 */
export async function apply(ctx, config = {}) {
  // Cordis 传空配置时可能是 null 而非 undefined，默认参数不生效，需兜底。
  const patchConfig = config ?? {}

  const dshHome = resolveDshHome()
  const configPath = resolveConfigPath(dshHome)

  /**
   * 每次调用现读配置。
   *
   * 用户在设置页或直接改 JSON 后无需重载插件即可生效，
   * 与 prts-terrestore 的「配置热读」约定一致。
   */
  const resolve = async () => {
    const userConfig = await readUserConfig(configPath)
    // 基准传配置文件所在目录：用户在配置里写的相对路径以此为家，
    // 这样无论 DSH 从哪启动、给哪个项目出片，解析结果都一致。
    const effective = mergeConfig(patchConfig, userConfig, dshHome)
    const outputDir = resolveOutputDir(effective, dshHome)
    return { config: effective, outputDir, configPath }
  }

  // 产物目录在加载期就准备好：出片阶段不再有「目录不存在」这类可避免的失败。
  const initial = await resolve()
  await mkdir(initial.outputDir, { recursive: true })

  ctx.logger?.info?.(`arknights-video: 产物目录 ${initial.outputDir}`)

  // tools / systemPrompt 是可选部署能力；ctx.inject 会等待其出现，
  // 并在其消失时自动卸载子树，避免「插件 ACTIVE 但工具缺失」的竞态。
  if (patchConfig.registerTools === true) {
    await ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
      mountVideoTools(toolCtx, { resolve })
    })
  }

  // 健康检查入口：把当前生效配置暴露给设置页 / 诊断脚本。
  ctx.effect?.(() => () => {}, 'arknights-video: lifecycle')
}

/** 供设置页与 bin/doctor.js 复用的配置解析。 */
export async function inspectConfig(patchConfig = {}) {
  const dshHome = resolveDshHome()
  const configPath = resolveConfigPath(dshHome)
  const userConfig = await readUserConfig(configPath)
  // 与 apply() 用同一基准，保证 doctor 与出片看到同一份解析结果。
  const config = mergeConfig(patchConfig, userConfig, dshHome)
  return {
    dshHome,
    configPath,
    config,
    outputDir: resolveOutputDir(config, dshHome),
    configExists: await readUserConfig(configPath).then(
      (value) => Object.keys(value).length > 0,
      () => false,
    ),
  }
}

/** 默认产物目录的便捷导出，供文档与 doctor 引用。 */
export const defaultOutputDir = (dshHome = resolveDshHome()) => join(dshHome, 'arknights-video')
