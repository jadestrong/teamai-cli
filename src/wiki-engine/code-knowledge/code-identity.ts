import path from "node:path";

/**
 * Canonical identity for a repository-local code file.
 *
 * The graph must never use a bare relative path as a cross-repository key:
 * identical paths are common in independently imported projects. Paths stay
 * case-preserving because repositories may be checked out on case-sensitive
 * file systems; normalization only removes syntax that cannot name a distinct
 * file inside the repository.
 */
export function codeFileId(origin: string, relativePath: string): string {
  const normalizedOrigin = origin.trim();
  if (!normalizedOrigin || normalizedOrigin.includes("/")) {
    throw new Error(`Invalid code origin: ${origin}`);
  }
  const normalizedPath = normalizeRelativeCodePath(relativePath);
  return `code://${normalizedOrigin}/${normalizedPath}`;
}

export function normalizeRelativeCodePath(relativePath: string): string {
  const portable = relativePath.replace(/\\/g, "/");
  if (!portable || portable.startsWith("/")) {
    throw new Error(`Code path must be repository-relative: ${relativePath}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Code path escapes repository root: ${relativePath}`);
  }
  return normalized;
}
