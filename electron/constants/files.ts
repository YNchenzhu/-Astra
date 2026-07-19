/**
 * 文件类型常量
 *
 * 定义二进制文件扩展名集合和二进制内容检测函数。
 * 依赖-free 以防止循环导入。
 */

/**
 * 二进制文件扩展名集合。
 * 用于判断文件是否应该作为二进制处理（不可直接读取为文本）。
 */
export const BINARY_EXTENSIONS = new Set([
  // 图片
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".tif",
  ".avif",
  // 视频
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".wmv",
  ".flv",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".ogv",
  // 音频
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".wma",
  ".aiff",
  ".opus",
  // 压缩包
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".z",
  ".tgz",
  ".iso",
  // 可执行文件
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".obj",
  ".lib",
  ".app",
  ".msi",
  ".deb",
  ".rpm",
  // 文档
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  // 字体
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  // 字节码
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".ear",
  ".node",
  ".wasm",
  ".rlib",
  // 数据库
  ".sqlite",
  ".sqlite3",
  ".db",
  ".mdb",
  ".idx",
  // 设计/3D
  ".psd",
  ".ai",
  ".eps",
  ".sketch",
  ".fig",
  ".xd",
  ".blend",
  ".3ds",
  ".max",
  // Flash
  ".swf",
  ".fla",
  // 锁/分析数据
  ".lockb",
  ".dat",
  ".data",
  // 磁盘镜像
  ".dmg",
  ".img",
]);

/**
 * 判断文件路径是否为二进制文件扩展名。
 * 忽略大小写。
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  return BINARY_EXTENSIONS.has(ext);
}

/** 二进制检测采样大小 (8 KB) */
const BINARY_CHECK_SIZE = 8192;

/** 非可打印字符比例阈值 (10%) */
const BINARY_NON_PRINTABLE_THRESHOLD = 0.1;

/**
 * 通过检测 null 字节和不可打印字符比例判断缓冲区是否为二进制内容。
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkSize; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  let nonPrintable = 0;
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i];
    // 可打印 ASCII: 32-126, 常见控制字符: 9(\t), 10(\n), 13(\r)
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / checkSize > BINARY_NON_PRINTABLE_THRESHOLD;
}

/**
 * 判断文件扩展名是否被阻止读取（禁止类二进制扩展名）。
 * 比 hasBinaryExtension 更严格 — 允许部分二进制格式（图片、PDF、SVG）。
 */
export const BLOCKED_READ_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".o",
  ".a",
  ".lib",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".wasm",
  ".class",
  ".pyc",
  ".pyo",
  ".sqlite",
  ".db",
  ".mdb",
  ".iso",
  ".dmg",
  ".img",
]);

export function isBlockedBinaryExtensionForRead(filePath: string): boolean {
  const ext = "." + filePath.split(".").pop()?.toLowerCase();
  return BLOCKED_READ_EXTENSIONS.has(ext);
}

/**
 * 图片扩展名集合（工具层可直接读取的图片格式，含 SVG）。
 */
export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);
