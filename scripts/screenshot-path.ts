import { basename, isAbsolute, relative, resolve } from "path";

export function resolveScreenshotPath(filename: string, screenshotDir: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    throw new Error("Screenshot filename cannot be empty");
  }
  if (isAbsolute(trimmed) || basename(trimmed) !== trimmed) {
    throw new Error("Screenshot filename must not include path components");
  }
  const root = resolve(screenshotDir);
  const screenshotPath = resolve(root, trimmed);
  const rel = relative(root, screenshotPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Screenshot filename escapes the screenshot directory");
  }
  return screenshotPath;
}
