/**
 * 注册 arknights-video 技能，把「怎么做出片」的流程知识按需注入模型。
 *
 * 技能正文通过 resourceBase 指向 skills/ 目录，模型可自行读取，
 * 因此这里只加载 SKILL.md 主体，不占用额外 system prompt 预算。
 * @module arknights-video/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'arknights-video-skill'
export const inject = ['skills']

const skillDirectoryUrl = new URL('../skills/arknights-video/', import.meta.url)

/** 去掉 YAML frontmatter，只保留正文。 */
function skillBody(source) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (!match) throw new Error('arknights-video/SKILL.md 缺少有效 YAML frontmatter')
  return match[1].trim()
}

/** Cordis 插件入口。 */
export async function apply(ctx) {
  const source = await readFile(new URL('SKILL.md', skillDirectoryUrl), 'utf8')
  const dispose = ctx.skills.register({
    name: 'arknights-video',
    description:
      '把《明日方舟》剧情资料制作成带旁白、字幕、出处的解说视频：写分镜稿、配音、烧字幕、合成 mp4。',
    source: 'bundled',
    provider: 'arknights-video',
    resourceBase: { kind: 'directory', path: fileURLToPath(skillDirectoryUrl) },
    content: skillBody(source),
  })
  return () => dispose?.()
}
