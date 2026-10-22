import { lstat, realpath } from 'fs/promises';
import { basename, dirname, join, resolve, sep } from 'path';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // This prevents access to files outside the working directory
    const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
    const normalizedWorkingDir = process.platform === 'win32' ? resolvedWorkingDir.toLowerCase() : resolvedWorkingDir
    const workingDirPrefix = normalizedWorkingDir.endsWith(sep) ? normalizedWorkingDir : normalizedWorkingDir + sep

    if (normalizedTarget !== normalizedWorkingDir && !normalizedTarget.startsWith(workingDirPrefix)) {
        return {
            valid: false,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true };
}

export type ContainedPathResult =
    /** path: lexical path for display; realPath: canonical path checked against the root. */
    | { valid: true; path: string; realPath: string }
    | { valid: false; error: string };

function isWithin(target: string, root: string): boolean {
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
    const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootPrefix)
}

/**
 * Like validatePath, but also follows symlinks: the real location of the target
 * (or of its nearest existing ancestor, for paths that do not exist yet) must stay
 * inside the real working directory. This is a static check: a concurrent writer
 * with the user's own rights can still swap path components afterwards, so file
 * I/O should open realPath with O_NOFOLLOW and verify the opened handle.
 */
export async function resolveContainedPath(targetPath: string, workingDirectory: string): Promise<ContainedPathResult> {
    const validation = validatePath(targetPath, workingDirectory);
    if (!validation.valid) {
        return { valid: false, error: validation.error ?? 'Invalid path' };
    }

    const resolvedTarget = resolve(workingDirectory, targetPath);
    const outside: ContainedPathResult = {
        valid: false,
        error: `Access denied: Path '${targetPath}' is outside the working directory`
    };

    let realRoot: string;
    try {
        realRoot = await realpath(resolve(workingDirectory));
    } catch {
        return outside;
    }

    let existing = resolvedTarget;
    let suffix: string[] = [];
    for (;;) {
        try {
            const realExisting = await realpath(existing);
            const realTarget = suffix.length > 0 ? join(realExisting, ...suffix) : realExisting;
            return isWithin(realTarget, realRoot) ? { valid: true, path: resolvedTarget, realPath: realTarget } : outside;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const parent = dirname(existing);
            if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === existing) {
                return outside;
            }
            // A dangling symlink would let a later write create its (unchecked) target.
            if (await lstat(existing).then(() => true, () => false)) {
                return outside;
            }
            suffix = [basename(existing), ...suffix];
            existing = parent;
        }
    }
}
