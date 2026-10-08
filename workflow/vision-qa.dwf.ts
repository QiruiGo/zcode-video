// 视觉验收 run：用 step-5-preview 做两类视觉检查。
// ① 图文对齐核对：逐张 CG 对照使用它的分镜旁白，查「讲的和画的不是一回事」
// ② 成片版式抽帧：中文渲染、字幕位置、排版、遮罩观感
// FRAMES_DIR 在主 run（渲染+程序化验收）完成后填入 output/<id>/qa 再提交。
const ROOT = "D:/DSH workspace/zcode-video";
const FRAMES_DIR = "TO_BE_FILLED_AFTER_RENDER";

interface AlignmentIssue {
  /** 涉及的 CG 文件名 */
  image: string;
  /** 使用它的分镜编号 */
  scenes: string;
  /** 一句话：画面内容与旁白哪里对不上 */
  what: string;
  /** 严重程度。high = 明显错图（画面内容与旁白剧情完全不符） */
  severity: "low" | "medium" | "high";
}

interface LayoutIssue {
  /** 一句话：画面上看到的问题 */
  what: string;
  /** 严重程度。high 只留给成片损坏、字幕大面积错位这类交付性问题 */
  severity: "low" | "medium" | "high";
}

interface AlignmentResult {
  /** 核对过的 CG 张数 */
  checked: number;
  /** 对不上的清单，没有就空数组 */
  issues: AlignmentIssue[];
  /** 无法目检的图（工具不支持/文件损坏），如实列出 */
  unviewable: string[];
}

interface VisionVerdict {
  /** 一句话目检结论 */
  verdict: string;
  /** 发现的版式问题清单，没有就空数组 */
  issues: LayoutIssue[];
  /** 亲眼看过并作为结论依据的帧文件名 */
  frameFiles: string[];
}

phase("图文对齐核对");
const aligner = agent("图文对齐核对员", {
  system:
    "你核对视频分镜的图文对齐：每张 CG 画面必须与使用它的分镜旁白讲的是同一件事。结论必须来自你亲眼看到的画面；看不了就如实列入 unviewable，绝不凭空描述。工作目录 ROOT=" + ROOT + "。",
});
const align = await aligner.ask<AlignmentResult>(
  "图文对齐核对。\n" +
  "素材图在 " + ROOT + "/assets/cg/ 下（与 scenes 文件里的 image 同名）；分镜定义在 " + ROOT + "/scenes-theresa-doctor.json（每镜 title/narration/cite/image）。\n" +
  "对每一张被引用的 CG：用 Read 看图，读出画面实际内容（人物/场景/事件），再对照所有使用它的分镜的旁白，判断是否讲的是同一剧情节点。重点抓三类：\n" +
  "① 错图——画面内容与旁白剧情完全不符（high）；\n" +
  "② 违和——大致相关但有明显出入，如旁白讲夜景画面是白天（medium）；\n" +
  "③ 复用不当——同一张图用在情绪/剧情矛盾的镜（如苏醒图用在诀别镜）且无呼应关系（low/medium）。\n" +
  "旁白引号内的台词是游戏原文，与画面的一致性以剧情节点为准。核对完返回 checked/issues/unviewable。不要修改任何文件。"
);

phase("成片版式抽帧目检");
const inspector = agent("视觉验收员", {
  system:
    "你是视频画面验收员，只看不改。结论必须来自你亲眼看到的画面；没有问题就说没有，不要凑数。" +
    "如果你无法看到图像内容（工具报错或不支持），如实说明并升级问题，绝不要凭空描述画面。" +
    "工作目录 ROOT=" + ROOT + "。",
});
const verdict = await inspector.ask<VisionVerdict>(
  "用 Read 逐张查看 " + FRAMES_DIR + " 下的全部 PNG 帧（frame-25/50/75.png）。逐项检查：\n" +
  "①中文渲染：有没有方块、乱码、缺字；\n" +
  "②字幕：是否压边、被裁切、明显错位；\n" +
  "③排版：标题/正文是否破版，文字与背景对比是否足够读清；\n" +
  "④CG 背景帧（若有）：遮罩压暗是否足够、整体观感是否协调。\n" +
  "问题写进 issues（带严重程度），没有问题返回空数组；frameFiles 列出你看过的帧。不要修改任何文件。"
);

const lines: string[] = ["# 视觉验收结论（step-5-preview）", ""];
lines.push("## 图文对齐", "");
lines.push("核对 " + align.checked + " 张 CG" + (align.unviewable.length ? "，无法目检 " + align.unviewable.length + " 张（" + align.unviewable.join("、") + "）" : "") + "，发现 " + align.issues.length + " 处不对齐。");
if (align.issues.length > 0) {
  for (const i of align.issues) lines.push("- [" + i.severity + "] " + i.image + "（镜 " + i.scenes + "）：" + i.what);
}
lines.push("", "## 成片版式", "", verdict.verdict);
if (verdict.issues.length > 0) {
  for (const i of verdict.issues) lines.push("- [" + i.severity + "] " + i.what);
}
lines.push("", "目检帧：" + verdict.frameFiles.join("、"));
await artifact.markdown("vision-report", lines.join("\n"), { title: "视觉验收 · step-5-preview" });

return {
  conclusion: "图文对齐 " + align.checked + " 张核对完成，" + align.issues.length + " 处不对齐；版式目检 " + verdict.frameFiles.length + " 帧，" + verdict.issues.length + " 个问题。",
  alignmentIssues: align.issues,
  layoutIssues: verdict.issues,
};