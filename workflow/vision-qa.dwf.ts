// 视觉验收 run：用 step-5-preview 目检主出片 run 抽好的帧。
// FRAMES_DIR 在主 run（渲染+程序化验收）完成后填入 output/<id>/qa 再提交。
const ROOT = "D:/DSH workspace/zcode-video";
const FRAMES_DIR = "TO_BE_FILLED_AFTER_RENDER";

interface VisionIssue {
  /** 一句话：画面上看到的问题 */
  what: string;
  /** 严重程度。high 只留给成片损坏、字幕大面积错位这类交付性问题 */
  severity: "low" | "medium" | "high";
}

interface VisionVerdict {
  /** 一句话目检结论 */
  verdict: string;
  /** 发现的问题清单，没有就空数组 */
  issues: VisionIssue[];
  /** 亲眼看过并作为结论依据的帧文件名 */
  frameFiles: string[];
}

phase("逐帧目检画面");
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

const lines: string[] = ["# 视觉验收结论（step-5-preview）", "", verdict.verdict, ""];
if (verdict.issues.length > 0) {
  lines.push("## 问题");
  for (const i of verdict.issues) lines.push("- [" + i.severity + "] " + i.what);
} else {
  lines.push("未发现问题。");
}
lines.push("", "目检帧：" + verdict.frameFiles.join("、"));
await artifact.markdown("vision-report", lines.join("\n"), { title: "视觉验收 · step-5-preview" });

return {
  conclusion: verdict.verdict + "（目检 " + verdict.frameFiles.length + " 帧，发现 " + verdict.issues.length + " 个问题）",
  issues: verdict.issues,
};