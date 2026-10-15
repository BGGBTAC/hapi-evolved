import { realpath, stat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';

const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.php', '.rb', '.c', '.h', '.cpp', '.hpp', '.swift', '.kt', '.scala', '.dart', '.svelte', '.vue', '.astro', '.lua', '.r', '.ex', '.exs', '.sh', '.bash', '.sql']);

export class AdapterError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

export function within(root, path) {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function isSensitivePath(path) {
    return path.split(/[\\/]/).some(part => /^(?:\.env(?:\..*)?|secrets?|credentials?|\.ssh|\.aws|\.gnupg|\.git|\.codegraph.*)$/i.test(part))
        || /(?:\.(?:pem|p12|pfx|key|keystore)|(?:^|[\\/])id_(?:rsa|ed25519))$/i.test(path);
}

export async function canonicalRoot(requested, allowedRoots) {
    if (typeof requested !== 'string' || !isAbsolute(requested)) throw new AdapterError('Absolute project root required');
    const path = await realpath(requested).catch(() => { throw new AdapterError('Project directory unavailable', 404); });
    const allowed = await Promise.all(allowedRoots.map(root => realpath(root)));
    if (!allowed.some(root => within(root, path))) throw new AdapterError('Project root outside configured workspaces', 403);
    if (!(await stat(path)).isDirectory()) throw new AdapterError('Project root must be a directory');
    return path;
}

export async function sourcePath(root, file) {
    if (typeof file !== 'string' || !file || isAbsolute(file) || isSensitivePath(file)) throw new AdapterError('File is excluded', 403);
    const candidate = resolve(root, file);
    if (!within(root, candidate)) throw new AdapterError('File outside project', 403);
    const actual = await realpath(candidate).catch(() => { throw new AdapterError('Source file unavailable', 404); });
    if (!within(root, actual) || isSensitivePath(relative(root, actual))) throw new AdapterError('File outside project or excluded', 403);
    return actual;
}

export async function sourceText(root, path) {
    const canonical = await sourcePath(root, path);
    // Opening a replaced FIFO must not block a worker before the descriptor type check.
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = process.platform === 'linux' ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(canonical);
        if (!within(root, opened) || isSensitivePath(relative(root, opened)) || !codeExtensions.has(extname(opened).toLowerCase())) throw new AdapterError('File outside project or excluded', 403);
        const info = await handle.stat(); const current = await stat(canonical);
        if (info.ino !== current.ino || info.dev !== current.dev) throw new AdapterError('Source changed during read', 409);
        if (!info.isFile() || info.size > 1_048_576) throw new AdapterError('Source file exceeds preview limit', 413);
        const buffer = Buffer.alloc(1_048_577);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (!bytesRead) break;
            total += bytesRead;
        }
        if (total > 1_048_576) throw new AdapterError('Source file exceeds preview limit', 413);
        return buffer.subarray(0, total).toString('utf8');
    } finally { await handle.close(); }
}

export function limitValue(value, fallback = 100, maximum = 200) {
    const number = Number(value ?? fallback);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new AdapterError(`Limit must be between 1 and ${maximum}`);
    return number;
}

export function normalizeGraph(graph, limit = 100) {
    const rawNodes = graph.nodes instanceof Map ? [...graph.nodes.values()] : graph.nodes ?? [];
    const rawEdges = graph.edges instanceof Map ? [...graph.edges.values()] : graph.edges ?? [];
    const safe = rawNodes.filter(node => !isSensitivePath(node.filePath ?? node.file ?? ''));
    const nodes = safe.slice(0, limit).map(normalizeNode);
    const ids = new Set(nodes.map(node => node.id));
    const edges = rawEdges.filter(edge => ids.has(edge.sourceId ?? edge.source) && ids.has(edge.targetId ?? edge.target))
        .slice(0, limit * 4).map(edge => ({ source: edge.sourceId ?? edge.source, target: edge.targetId ?? edge.target, kind: edge.kind }));
    return { nodes, edges, truncated: safe.length > limit || rawEdges.length > limit * 4 };
}

export function normalizeNode(node) {
    return { id: node.id, name: node.name, kind: node.kind, file: node.filePath, line: node.startLine, endLine: node.endLine };
}

/** Enumerate only source files before handing paths to the indexer. Never follow symlinks. */
export async function scanCodeFiles(root, maximum = 50_000) {
    const files = new Map();

    let directories = 0;
    async function walk(directory) {
        if (++directories > 10_000) throw new AdapterError('Workspace exceeds directory limit', 413);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const absolute = resolve(directory, entry.name);
            const path = relative(root, absolute);
            if (isSensitivePath(path) || /^(node_modules|vendor|dist|build|target|\.venv|venv|\.next|\.cache)$/.test(entry.name)) continue;
            if (entry.isDirectory()) { await walk(absolute); continue; }
            if (!entry.isFile() || !codeExtensions.has(extname(entry.name).toLowerCase())) continue;
            const info = await stat(absolute);
            if (info.size > 1_048_576) continue;
            files.set(path, `${info.mtimeMs}:${info.size}`);
            if (files.size > maximum) throw new AdapterError('Workspace exceeds source file limit', 413);
        }
    }
    await walk(root);
    return files;
}
