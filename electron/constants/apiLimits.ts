/**
 * API 限制常量
 *
 * 依赖-free 以防止循环导入。
 * 定义图片、PDF、媒体发送到 Anthropic API 的大小和数量限制。
 */

// 图片限制
/** API 允许的最大 Base64 图片大小 (5 MB) */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

/** 图片压缩目标大小 (3.75 MB) */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4;

/** 图片最大宽度/高度 (px) */
export const IMAGE_MAX_DIMENSION = 2000;

/** 超过此大小的图片需要缩放后再发送 (1.5 MB) */
export const IMAGE_SHARP_THRESHOLD_BYTES = 1_500_000;

/** 缩放后图片的最大边长 (px) */
export const IMAGE_SHARP_MAX_EDGE = 2048;

// PDF 限制
/** PDF 目标原始大小 (20 MB) */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024;

/** API 允许的最大 PDF 页数 */
export const API_PDF_MAX_PAGES = 100;

/** 超过此大小的 PDF 走页面提取路径而非 base64 (3 MB) */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024;

/** PDF 最大提取大小 (100 MB) */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;

/** 每次请求最大 PDF 页数 */
export const PDF_MAX_PAGES_PER_READ = 20;

/** 超过此页数的 PDF 在 @ 提及时作为引用而非内联 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10;

// 媒体限制
/** 单个请求最大媒体数量 */
export const API_MAX_MEDIA_PER_REQUEST = 100;
