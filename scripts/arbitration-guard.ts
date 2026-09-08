import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

const MAX_RECLAIM_DEPTH = 8;

interface ArbitrationGuardMetadata {
  pid: number;
  startedAt: string;
  token: string;
}

type ArbitrationGuardSnapshot =
  | {
      kind: "file";
      device: number;
      inode: number;
      modifiedAtMs: number;
      raw: string;
      metadata: ArbitrationGuardMetadata | null;
    }
  | {
      kind: "legacy-directory" | "other";
      device: number;
      inode: number;
      modifiedAtMs: number;
    };

interface OwnedArbitrationGuard {
  device: number;
  inode: number;
  token: string;
}

export interface ArbitrationGuardOptions {
  path: string;
  pid: number;
  staleMs: number;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
  tokenFactory: () => string;
  activeError: () => Error;
  beforeRemove?: () => void;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parseMetadata(raw: string): ArbitrationGuardMetadata | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const metadata = candidate as Partial<ArbitrationGuardMetadata>;
  if (
    !Number.isSafeInteger(metadata.pid)
    || (metadata.pid as number) <= 0
    || typeof metadata.startedAt !== "string"
    || !Number.isFinite(Date.parse(metadata.startedAt))
    || typeof metadata.token !== "string"
    || metadata.token.length === 0
  ) {
    return null;
  }
  return metadata as ArbitrationGuardMetadata;
}

function readSnapshot(path: string): ArbitrationGuardSnapshot | null {
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  if (pathStat.isDirectory()) {
    return {
      kind: "legacy-directory",
      device: pathStat.dev,
      inode: pathStat.ino,
      modifiedAtMs: pathStat.mtimeMs,
    };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "other",
      device: pathStat.dev,
      inode: pathStat.ino,
      modifiedAtMs: pathStat.mtimeMs,
    };
  }

  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor);
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || !stat.isFile()) {
      return {
        kind: "other",
        device: stat.dev,
        inode: stat.ino,
        modifiedAtMs: stat.mtimeMs,
      };
    }
    const raw = readFileSync(descriptor, "utf8");
    return {
      kind: "file",
      device: stat.dev,
      inode: stat.ino,
      modifiedAtMs: stat.mtimeMs,
      raw,
      metadata: parseMetadata(raw),
    };
  } finally {
    closeSync(descriptor);
  }
}

function isReclaimable(
  snapshot: ArbitrationGuardSnapshot,
  options: ArbitrationGuardOptions,
): boolean {
  if (snapshot.kind === "other") return false;
  if (snapshot.kind === "file" && snapshot.metadata) {
    return !options.isPidAlive(snapshot.metadata.pid);
  }
  return options.now() - snapshot.modifiedAtMs > options.staleMs;
}

function isSameCandidate(
  observed: ArbitrationGuardSnapshot,
  confirmed: ArbitrationGuardSnapshot,
): boolean {
  if (
    observed.kind !== confirmed.kind
    || observed.device !== confirmed.device
    || observed.inode !== confirmed.inode
  ) {
    return false;
  }
  if (observed.kind === "file" && confirmed.kind === "file") {
    return observed.metadata
      ? confirmed.metadata?.token === observed.metadata.token
      : confirmed.raw === observed.raw;
  }
  return observed.modifiedAtMs === confirmed.modifiedAtMs;
}

function removeCandidate(path: string, snapshot: ArbitrationGuardSnapshot): void {
  if (snapshot.kind === "file") {
    unlinkSync(path);
    return;
  }
  if (snapshot.kind === "legacy-directory") {
    rmdirSync(path);
  }
}

function reclaimClaimPath(path: string, snapshot: ArbitrationGuardSnapshot): string {
  const identity = snapshot.kind === "file"
    ? `${snapshot.kind}\0${snapshot.device}\0${snapshot.inode}\0${snapshot.modifiedAtMs}\0${snapshot.raw}`
    : `${snapshot.kind}\0${snapshot.device}\0${snapshot.inode}\0${snapshot.modifiedAtMs}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `${path}.reclaim-${digest}`;
}

function publishGuard(options: ArbitrationGuardOptions): OwnedArbitrationGuard | null {
  const token = options.tokenFactory();
  if (!token) throw new Error("Arbitration guard token must not be empty");
  const candidatePath = `${options.path}.candidate-${options.pid}-${token.replace(/[^a-zA-Z0-9-]/g, "")}`;
  let descriptor: number;
  try {
    descriptor = openSync(candidatePath, "wx", 0o600);
  } catch (error: unknown) {
    throw error;
  }

  let candidateStat: ReturnType<typeof fstatSync>;
  try {
    const metadata: ArbitrationGuardMetadata = {
      pid: options.pid,
      startedAt: new Date(options.now()).toISOString(),
      token,
    };
    writeFileSync(descriptor, JSON.stringify(metadata), "utf8");
    fsyncSync(descriptor);
    candidateStat = fstatSync(descriptor);
  } catch (error) {
    try {
      unlinkSync(candidatePath);
    } catch {
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }

  try {
    linkSync(candidatePath, options.path);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    return null;
  } finally {
    try {
      unlinkSync(candidatePath);
    } catch {
    }
  }

  return {
    device: candidateStat.dev,
    inode: candidateStat.ino,
    token,
  };
}

function releaseGuard(path: string, owned: OwnedArbitrationGuard): void {
  try {
    const current = readSnapshot(path);
    if (
      current?.kind === "file"
      && current.device === owned.device
      && current.inode === owned.inode
      && current.metadata?.token === owned.token
    ) {
      unlinkSync(path);
    }
  } catch {
  }
}

function acquireGuard(
  options: ArbitrationGuardOptions,
  reclaimDepth: number,
): OwnedArbitrationGuard {
  let owned = publishGuard(options);
  if (owned) return owned;

  const observed = readSnapshot(options.path);
  if (!observed) {
    owned = publishGuard(options);
    if (owned) return owned;
    throw options.activeError();
  }
  if (!isReclaimable(observed, options) || reclaimDepth >= MAX_RECLAIM_DEPTH) {
    throw options.activeError();
  }

  const claimPath = reclaimClaimPath(options.path, observed);
  const claimOwned = acquireGuard({
    ...options,
    path: claimPath,
    beforeRemove: undefined,
  }, reclaimDepth + 1);

  try {
    const confirmed = readSnapshot(options.path);
    if (
      !confirmed
      || !isSameCandidate(observed, confirmed)
      || !isReclaimable(confirmed, options)
    ) {
      throw options.activeError();
    }

    if (reclaimDepth === 0) options.beforeRemove?.();

    const removable = readSnapshot(options.path);
    if (
      !removable
      || !isSameCandidate(confirmed, removable)
      || !isReclaimable(removable, options)
    ) {
      throw options.activeError();
    }
    removeCandidate(options.path, removable);

    owned = publishGuard(options);
    if (!owned) throw options.activeError();
    return owned;
  } finally {
    releaseGuard(claimPath, claimOwned);
  }
}

export function withFileArbitrationGuard<T>(
  options: ArbitrationGuardOptions,
  operation: () => T,
): T {
  const owned = acquireGuard(options, 0);

  try {
    return operation();
  } finally {
    releaseGuard(options.path, owned);
  }
}

