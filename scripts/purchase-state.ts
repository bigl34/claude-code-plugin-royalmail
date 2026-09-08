import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { withFileArbitrationGuard } from "./arbitration-guard.js";

export type RoyalMailPurchaseState =
  | "planned"
  | "order_adopted"
  | "draft_created"
  | "checkout_ready"
  | "checkout_started"
  | "payment_uncertain"
  | "paid"
  | "artifact_saved"
  | "completed"
  | "manual_review"
  | "failed_no_charge";

export interface RoyalMailPurchaseEvent {
  runId: string;
  state: RoyalMailPurchaseState;
  at: string;
  intentHash: string;
  noProhibitedOrRestrictedGoods?: true;
  shopifyOrderNumber?: string;
  providerOrderId?: number;
  providerOrderReference?: string;
  origin?: "adopted" | "bot-created";
  serviceKey?: string;
  expectedGrossMinor?: number;
  confirmedGrossMinor?: number;
  grossMinor?: number;
  vatMinor?: number;
  netMinor?: number;
  currency?: "GBP";
  paymentReference?: string;
  paidAt?: string;
  receiptId?: string;
  trackingNumber?: string;
  trackingKind?: "none" | "delivery_confirmation" | "full";
  packageFormat?: "letter" | "largeLetter" | "smallParcel" | "mediumParcel";
  pdfPath?: string;
  pdfSha256?: string;
  pngPath?: string;
  pngSha256?: string;
  manualReviewCode?: string;
  message?: string;
}

const ALLOWED_TRANSITIONS: Record<RoyalMailPurchaseState, ReadonlySet<RoyalMailPurchaseState>> = {
  planned: new Set(["order_adopted", "draft_created", "manual_review", "failed_no_charge"]),
  order_adopted: new Set(["checkout_ready", "manual_review", "failed_no_charge"]),
  draft_created: new Set(["checkout_ready", "manual_review", "failed_no_charge"]),
  checkout_ready: new Set(["checkout_started", "manual_review", "failed_no_charge"]),
  checkout_started: new Set(["payment_uncertain", "paid", "manual_review"]),
  payment_uncertain: new Set(["paid", "manual_review", "failed_no_charge"]),
  paid: new Set(["artifact_saved", "manual_review"]),
  artifact_saved: new Set(["completed", "manual_review"]),
  completed: new Set(),
  manual_review: new Set(["paid", "artifact_saved", "completed", "failed_no_charge"]),
  failed_no_charge: new Set(),
};

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function defaultRoyalMailStateDir(): string {
  return process.env.YOUR_BOT_STATE_DIR
    ? join(process.env.YOUR_BOT_STATE_DIR, "royalmail")
    : join(process.env.HOME ?? "/tmp", "biz", "var", "royalmail-label");
}

export class RoyalMailPurchaseJournal {
  readonly path: string;

  constructor(stateDir = defaultRoyalMailStateDir()) {
    ensurePrivateDirectory(stateDir);
    this.path = join(stateDir, "royalmail-purchases-v1.jsonl");
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "", { mode: 0o600 });
    }
    chmodSync(this.path, 0o600);
  }

  events(runId?: string): RoyalMailPurchaseEvent[] {
    const content = readFileSync(this.path, "utf8").trim();
    if (!content) {
      return [];
    }
    const events = content
      .split("\n")
      .map((line) => JSON.parse(line) as RoyalMailPurchaseEvent);
    return runId ? events.filter((event) => event.runId === runId) : events;
  }

  latest(runId: string): RoyalMailPurchaseEvent | undefined {
    return this.events(runId).at(-1);
  }

  private runsForOrder(shopifyOrderNumber: string): RoyalMailPurchaseEvent[][] {
    const eventsByRun = new Map<string, RoyalMailPurchaseEvent[]>();
    for (const event of this.events()) {
      const run = eventsByRun.get(event.runId) ?? [];
      run.push(event);
      eventsByRun.set(event.runId, run);
    }
    const normalizedOrder = shopifyOrderNumber.trim().replace(/^#+/, "").toUpperCase();
    return [...eventsByRun.values()].filter((run) => {
      const runOrder = run
        .map((event) => event.shopifyOrderNumber)
        .find((value): value is string => Boolean(value))
        ?.trim()
        .replace(/^#+/, "")
        .toUpperCase();
      return runOrder === normalizedOrder;
    });
  }

  completedPurchaseForOrder(
    shopifyOrderNumber: string,
    excludeRunId?: string,
  ): RoyalMailPurchaseEvent | undefined {
    let completed: RoyalMailPurchaseEvent | undefined;
    for (const run of this.runsForOrder(shopifyOrderNumber)) {
      const latest = run.at(-1)!;
      if (latest.runId !== excludeRunId && latest.state === "completed") {
        completed = latest;
      }
    }
    return completed;
  }

  unresolvedPurchaseForOrder(
    shopifyOrderNumber: string,
    excludeRunId?: string,
  ): RoyalMailPurchaseEvent | undefined {
    for (const run of this.runsForOrder(shopifyOrderNumber)) {
      const latest = run.at(-1)!;
      if (latest.runId === excludeRunId) continue;
      const chargedOrUncertain = [
        "checkout_started",
        "payment_uncertain",
        "paid",
        "artifact_saved",
      ].includes(latest.state)
        || (latest.state === "manual_review" && latest.expectedGrossMinor != null);
      if (chargedOrUncertain) {
        return latest;
      }
    }
    return undefined;
  }

  append(event: RoyalMailPurchaseEvent): void {
    const previous = this.latest(event.runId);
    if (
      event.noProhibitedOrRestrictedGoods !== undefined
      && event.noProhibitedOrRestrictedGoods !== true
    ) {
      throw new Error("Royal Mail goods attestation journal evidence must be literal true");
    }
    const eventToPersist = previous?.noProhibitedOrRestrictedGoods === true
      && event.noProhibitedOrRestrictedGoods === undefined
      ? { ...event, noProhibitedOrRestrictedGoods: true as const }
      : event;
    if (previous) {
      if (!ALLOWED_TRANSITIONS[previous.state].has(eventToPersist.state)) {
        throw new Error(
          `Invalid Royal Mail purchase transition: ${previous.state} -> ${eventToPersist.state}`,
        );
      }
      if (previous.intentHash !== eventToPersist.intentHash) {
        throw new Error("Royal Mail purchase intent hash changed within one run");
      }
    } else if (eventToPersist.state !== "planned") {
      throw new Error("Royal Mail purchase journal must begin with planned");
    }

    const descriptor = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(eventToPersist)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

interface BrowserLock {
  operationId: string;
  pid: number;
  startedAt: string;
  token?: string;
}

interface BrowserLockSnapshot {
  raw: string;
  owner: BrowserLock;
  device: number;
  inode: number;
}

interface MutexOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  pid?: number;
  staleMs?: number;
  tokenFactory?: () => string;
}

function defaultPidCheck(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export class RoyalMailBrowserMutex {
  readonly path: string;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly pid: number;
  private readonly staleMs: number;
  private readonly tokenFactory: () => string;

  constructor(stateDir = defaultRoyalMailStateDir(), options: MutexOptions = {}) {
    ensurePrivateDirectory(stateDir);
    this.path = join(stateDir, "browser.lock");
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? defaultPidCheck;
    this.pid = options.pid ?? process.pid;
    this.staleMs = options.staleMs ?? 45 * 60 * 1000;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  private activeLockError(owner?: BrowserLock): Error {
    if (owner) {
      return new Error(
        `Royal Mail browser operation already active: ${owner.operationId} (pid ${owner.pid})`,
      );
    }
    return new Error(`Royal Mail browser lock transition already active: ${this.path}.guard`);
  }

  private withLockArbitration<T>(operation: () => T): T {
    return withFileArbitrationGuard({
      path: `${this.path}.guard`,
      pid: this.pid,
      staleMs: this.staleMs,
      now: this.now,
      isPidAlive: this.isPidAlive,
      tokenFactory: this.tokenFactory,
      activeError: () => this.activeLockError(),
    }, operation);
  }

  private readLockSnapshot(): BrowserLockSnapshot | null {
    let descriptor: number;
    try {
      descriptor = openSync(this.path, "r");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const stat = fstatSync(descriptor);
      const raw = readFileSync(descriptor, "utf8");
      let owner: BrowserLock;
      try {
        owner = JSON.parse(raw) as BrowserLock;
      } catch {
        throw new Error("Royal Mail browser lock exists but is unreadable; manual review is required");
      }
      if (
        typeof owner?.operationId !== "string"
        || !Number.isSafeInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.startedAt !== "string"
        || !Number.isFinite(Date.parse(owner.startedAt))
        || (owner.token !== undefined && (
          typeof owner.token !== "string" || owner.token.length === 0
        ))
      ) {
        throw new Error("Royal Mail browser lock exists but is unreadable; manual review is required");
      }
      return { raw, owner, device: stat.dev, inode: stat.ino };
    } finally {
      closeSync(descriptor);
    }
  }

  private isReclaimable(snapshot: BrowserLockSnapshot): boolean {
    const ageMs = this.now() - Date.parse(snapshot.owner.startedAt);
    return ageMs > this.staleMs && !this.isPidAlive(snapshot.owner.pid);
  }

  private isSameReclaimCandidate(
    observed: BrowserLockSnapshot,
    confirmed: BrowserLockSnapshot,
  ): boolean {
    if (observed.device !== confirmed.device || observed.inode !== confirmed.inode) {
      return false;
    }
    if (observed.owner.token) {
      return confirmed.owner.token === observed.owner.token;
    }
    return observed.raw === confirmed.raw;
  }

  private tryWriteLock(
    operationId: string,
    token: string,
  ): { device: number; inode: number } | null {
    let descriptor: number;
    try {
      descriptor = openSync(this.path, "wx", 0o600);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return null;
      }
      throw error;
    }

    try {
      const lock: Required<BrowserLock> = {
        operationId,
        pid: this.pid,
        startedAt: new Date(this.now()).toISOString(),
        token,
      };
      writeFileSync(descriptor, JSON.stringify(lock), "utf8");
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      return { device: stat.dev, inode: stat.ino };
    } catch (error) {
      try {
        const createdStat = fstatSync(descriptor);
        const current = this.readLockSnapshot();
        if (
          current
          && current.device === createdStat.dev
          && current.inode === createdStat.ino
        ) {
          unlinkSync(this.path);
        }
      } catch {
      }
      throw error;
    } finally {
      closeSync(descriptor);
    }
  }

  acquire(operationId: string): () => void {
    const token = this.tokenFactory();
    const owned = this.withLockArbitration(() => {
      const created = this.tryWriteLock(operationId, token);
      if (created) {
        return created;
      }

      const observed = this.readLockSnapshot();
      if (!observed) {
        const retried = this.tryWriteLock(operationId, token);
        if (!retried) throw this.activeLockError();
        return retried;
      }
      if (!this.isReclaimable(observed)) {
        throw this.activeLockError(observed.owner);
      }

      const confirmed = this.readLockSnapshot();
      if (!confirmed) {
        const retried = this.tryWriteLock(operationId, token);
        if (!retried) throw this.activeLockError();
        return retried;
      }
      if (
        !this.isSameReclaimCandidate(observed, confirmed)
        || !this.isReclaimable(confirmed)
      ) {
        throw this.activeLockError(confirmed.owner);
      }

      unlinkSync(this.path);
      const retried = this.tryWriteLock(operationId, token);
      if (!retried) throw this.activeLockError();
      return retried;
    });

    let released = false;
    return () => {
      if (released) {
        return;
      }
      const current = this.readLockSnapshot();
      if (!current) {
        released = true;
        return;
      }
      if (
        current.device === owned.device
        && current.inode === owned.inode
        && current.owner.operationId === operationId
        && current.owner.pid === this.pid
        && current.owner.token === token
      ) {
        unlinkSync(this.path);
      }
      released = true;
    };
  }
}
