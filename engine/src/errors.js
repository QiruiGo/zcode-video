/**
 * 插件对外错误类型。
 *
 * 工具执行层把错误对象上的 `code` / `retryable` 透传给模型，
 * 因此所有可预期的失败都显式携带这两个字段，避免模型看到
 * 无结构的 TypeError 而无法自愈。
 * @module arknights-video/errors
 */

/** 可预期的插件运行失败：带稳定 code 与可重试标记。 */
export class VideoError extends Error {
  /**
   * @param {string} code - 稳定的机器可读错误码。
   * @param {string} message - 面向模型与用户的中文说明。
   * @param {{ retryable?: boolean, details?: unknown }} [options] - 附加信息。
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'VideoError'
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.details !== undefined) this.details = options.details
  }
}

/** 环境缺少外部依赖（ffmpeg / Python / 字体）时使用。 */
export const environmentError = (message, details) =>
  new VideoError('ENVIRONMENT_MISSING', message, { retryable: false, details })

/** 调用参数不合法。 */
export const invalidRequest = (message, details) =>
  new VideoError('INVALID_REQUEST', message, { retryable: false, details })

/** 项目或分镜不存在。 */
export const notFound = (message, details) =>
  new VideoError('NOT_FOUND', message, { retryable: false, details })

/** 外部命令（ffmpeg / python）执行失败。 */
export const processFailure = (message, details) =>
  new VideoError('PROCESS_FAILED', message, { retryable: true, details })

/** 项目状态机不允许当前操作。 */
export const invalidState = (message, details) =>
  new VideoError('INVALID_STATE', message, { retryable: false, details })
