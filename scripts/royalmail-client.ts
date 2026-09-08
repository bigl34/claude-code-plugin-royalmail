
import { chromium, Browser, Page, BrowserContext, Download, Locator } from "playwright";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  openSync,
  closeSync,
  fstatSync,
  realpathSync,
  lstatSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { join, resolve, isAbsolute, sep, basename, dirname, extname } from "path";
import { loadPassCredentials, loadServiceConfig, z } from "@local/cli-utils";
import { secureStatePath, secureWrite } from "./vendor/secure-state/index.js";
import { resolveScreenshotPath } from "./screenshot-path.js";
import { ROYAL_MAIL_SERVICES } from "./royalmail-domain.js";
import { withFileArbitrationGuard } from "./arbitration-guard.js";

const SESSION_PATH = secureStatePath("royalmail", "session.json");
const SCREENSHOT_DIR = process.env.HOME + "/biz/.playwright-mcp";
const LABEL_DIR = process.env.HOME + "/biz/shipping-labels";
const DOWNLOAD_LOCK_PATH = "/tmp/download-invoices-royal-mail.lock";
const INVOICE_ROOT_DIR = process.env.HOME + "/biz/mydrive/Downloads/From Claude/Invoices";
const INVOICE_STATE_FILENAME = ".download-invoices-state.json";

const ROYALMAIL_LOGIN_URL = "https://business.parcel.royalmail.com/";
const ROYALMAIL_CREATE_ORDER_URL = "https://business.parcel.royalmail.com/orders/single/create";
const ROYALMAIL_INVOICES_URL = "https://business.parcel.royalmail.com/payments/invoices/";

const LOCK_STALE_MS = 45 * 60 * 1000;
const MAX_INVOICE_PAGES = 12;

const SERVICE_CODES: Record<string, string> = {
  TRACKED24: "Royal Mail Tracked 24",
  TRACKED48: "Royal Mail Tracked 48",
  SPECIALDELIVERY9: "Special Delivery Guaranteed by 9am",
  SPECIALDELIVERY1: "Special Delivery Guaranteed by 1pm",
  SIGNED: "Royal Mail Signed For 1st Class",
  SIGNED2: "Royal Mail Signed For 2nd Class",
};

interface SessionInfo {
  wsEndpoint: string;
  createdAt: string;
  loggedIn: boolean;
  formFilled: boolean;
  labelGenerated: boolean;
  headless?: boolean;
}

const RoyalMailConfigSchema = z.object({
  royalmail: z
    .object({
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

type Config = z.infer<typeof RoyalMailConfigSchema>;

interface RoyalMailCredentials {
  username: string;
  password: string;
}

interface InvoiceState {
  knownRowKeys: string[];
}

interface DownloadLockMetadata {
  pid?: number;
  createdAt?: string;
  token?: string;
}

interface DownloadLockSnapshot {
  raw: string;
  metadata: DownloadLockMetadata | null;
  device: number;
  inode: number;
  modifiedAtMs: number;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RoyalMailClientOptions {
  downloadLockPath?: string;
}

export interface CreateLabelOptions {
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  postcode: string;
  email?: string;
  phone?: string;
  weight: number;
  length?: number;
  width?: number;
  height?: number;
  service: string;
  reference?: string;
  contents?: string;
}

export interface DownloadInvoicesOptions {
  outputDir: string;
  headed?: boolean;
}

interface ScreenshotOptions {
  filename?: string;
  fullPage?: boolean;
}

interface FormState {
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  postcode: string;
  weight: number;
  service: string;
  reference?: string;
}

interface Result {
  success?: boolean;
  error?: boolean;
  code?: string;
  message?: string;
  screenshot?: string;
  requiresManualConfirmation?: boolean;
  formState?: FormState;
  labelPath?: string;
  trackingNumber?: string;
  cost?: string;
}

interface ServiceInfo {
  code: string;
  name: string;
  description: string;
}

interface MigrationResult {
  moved: number;
  skippedExisting: number;
  errors: string[];
}

export interface DownloadInvoicesResult {
  schemaVersion: "1.0";
  provider: "royal-mail";
  success: true;
  partialFailure: boolean;
  outputDir: string;
  startedAt: string;
  finishedAt: string;
  totalSeen: number;
  downloaded: string[];
  skipped: string[];
  errors: string[];
  warnings: string[];
  migration: MigrationResult;
}

interface InvoiceRowInfo {
  rowText: string;
  rowIndex: number;
  invoiceNumber?: string;
  dateToken?: string;
  amountToken?: string;
  rowKey?: string;
  filenameHint?: string;
}

interface SavedInvoiceResult {
  filename: string;
  downloaded: boolean;
}

export class RoyalMailClient {
  private config: Config;
  private credentials: RoyalMailCredentials | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserHeadless = true;
  private downloadLockFd: number | null = null;
  private downloadLockToken: string | null = null;
  private readonly downloadLockPath: string;

  constructor(options: RoyalMailClientOptions = {}) {
    this.downloadLockPath = options.downloadLockPath ?? DOWNLOAD_LOCK_PATH;
    this.config = this.loadConfig();
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    if (!existsSync(LABEL_DIR)) {
      mkdirSync(LABEL_DIR, { recursive: true });
    }
  }


  setHeaded(headed: boolean): void {
    const desiredHeadless = !headed;
    if (this.browserHeadless === desiredHeadless) {
      return;
    }

    this.browserHeadless = desiredHeadless;

    try {
      if (existsSync(SESSION_PATH)) {
        unlinkSync(SESSION_PATH);
      }
    } catch {
    }
  }

  private loadConfig(): Config {
    const raw = loadServiceConfig("royalmail-label-manager", {
      schema: RoyalMailConfigSchema,
      optional: true,
    });
    return raw ?? {};
  }

  private resolveCredentials(): RoyalMailCredentials {
    if (this.credentials) {
      return this.credentials;
    }

    const username = this.config.royalmail?.username?.trim();
    const password = this.config.royalmail?.password?.trim();

    if (username && password) {
      this.credentials = { username, password };
      return this.credentials;
    }

    const passCreds = this.tryResolvePassCredentials();
    if (passCreds) {
      this.credentials = passCreds;
      return this.credentials;
    }

    throw new Error(
      "Royal Mail credentials not found. Configure scripts/config.json with royalmail.username/password, " +
      "or store them in pass as your-secret-store/royalmail/username and your-secret-store/royalmail/password."
    );
  }

  private tryResolvePassCredentials(): RoyalMailCredentials | null {
    const creds = loadPassCredentials({
      prefix: "your-secret-store/royalmail",
      keys: ["username", "password"],
      optional: true,
    });
    if (creds.username && creds.password) {
      return { username: creds.username, password: creds.password };
    }
    return null;
  }

  private async ensureBrowser(): Promise<Page> {
    if (existsSync(SESSION_PATH)) {
      try {
        const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));

        if (typeof session.headless === "boolean" && session.headless !== this.browserHeadless) {
          unlinkSync(SESSION_PATH);
        } else {
          this.browser = await chromium.connectOverCDP(session.wsEndpoint);
          const contexts = this.browser.contexts();
          if (contexts.length > 0) {
            this.context = contexts[0];
            const pages = this.context.pages();
            if (pages.length > 0) {
              this.page = pages[0];
              return this.page;
            }
          }
        }
      } catch {
        try {
          unlinkSync(SESSION_PATH);
        } catch {
        }
      }
    }

    this.browser = await chromium.launch({
      headless: this.browserHeadless,
      args: ["--remote-debugging-port=0"],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      acceptDownloads: true,
    });

    this.page = await this.context.newPage();

    const wsEndpoint = (this.browser as any).wsEndpoint?.() as string | undefined;
    if (wsEndpoint) {
      secureWrite(
        SESSION_PATH,
        JSON.stringify({
          wsEndpoint,
          createdAt: new Date().toISOString(),
          loggedIn: false,
          formFilled: false,
          labelGenerated: false,
          headless: this.browserHeadless,
        } as SessionInfo)
      );
    }

    return this.page;
  }

  private updateSession(updates: Partial<SessionInfo>): void {
    if (existsSync(SESSION_PATH)) {
      const session = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      Object.assign(session, updates);
      secureWrite(SESSION_PATH, JSON.stringify(session));
    }
  }

  private async login(): Promise<boolean> {
    const credentials = this.resolveCredentials();
    const page = await this.ensureBrowser();

    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (session.loggedIn) {
        try {
          await page.goto(ROYALMAIL_CREATE_ORDER_URL, { waitUntil: "networkidle", timeout: 30000 });
          if (!page.url().includes("login") && !page.url().includes("signin")) {
            return true;
          }
        } catch {
        }
      }
    }

    await page.goto(ROYALMAIL_LOGIN_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    await this.dismissCookieBanner(page);

    const loginScreenshot = `${SCREENSHOT_DIR}/royalmail-login-${Date.now()}.png`;
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="email" i]',
      'input[name="username"]',
      "#username",
      "#email",
    ];

    let emailFilled = false;
    for (const selector of emailSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(credentials.username);
          emailFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      "#password",
    ];

    let passwordFilled = false;
    for (const selector of passwordSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(credentials.password);
          passwordFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!emailFilled || !passwordFilled) {
      const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-login-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      throw new Error(`Could not find login fields. See screenshot: ${errorScreenshot}`);
    }

    const loginButtonSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button:has-text("Login")',
      'button:has-text("Continue")',
      '[data-testid="login-button"]',
    ];

    for (const selector of loginButtonSelectors) {
      try {
        await this.dismissCookieBanner(page);
        const button = await page.$(selector);
        if (button) {
          await button.click();
          break;
        }
      } catch {
        continue;
      }
    }

    try {
      await Promise.race([
        page.waitForURL(/orders|dashboard|home|payments/i, { timeout: 30000 }),
        page.waitForSelector('[aria-label*="account"]', { timeout: 30000 }),
        page.waitForSelector('.user-menu, .account-menu, [data-testid="user-menu"]', { timeout: 30000 }),
      ]);
    } catch {
      if (page.url().includes("login") || page.url().includes("signin")) {
        const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-login-failed-${Date.now()}.png`;
        await page.screenshot({ path: errorScreenshot, fullPage: true });
        throw new Error(`Login failed. Check credentials. See screenshot: ${errorScreenshot}`);
      }
    }

    await page.waitForTimeout(2000);
    this.updateSession({ loggedIn: true });
    return true;
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const selectors = [
      "#onetrust-accept-btn-handler",
      "#onetrust-reject-all-handler",
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Reject all")',
      'button:has-text("Reject All")',
    ];

    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        if (!(await button.count())) {
          continue;
        }

        if (await button.isVisible({ timeout: 300 })) {
          await button.click({ timeout: 2000 });
          await page.waitForTimeout(300);
          return;
        }
      } catch {
      }
    }

    try {
      await page.evaluate(() => {
        const candidates = [
          "#onetrust-consent-sdk",
          "#onetrust-banner-sdk",
          ".onetrust-pc-dark-filter",
          '[class*="cookie"][class*="overlay"]',
          '[id*="cookie"][id*="overlay"]',
        ];

        for (const selector of candidates) {
          for (const element of document.querySelectorAll(selector)) {
            (element as HTMLElement).style.display = "none";
          }
        }
      });
    } catch {
    }
  }

  private getStatePath(outputDir: string): string {
    return join(outputDir, INVOICE_STATE_FILENAME);
  }

  private loadInvoiceState(outputDir: string): Set<string> {
    const statePath = this.getStatePath(outputDir);
    if (!existsSync(statePath)) {
      return new Set<string>();
    }

    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as InvoiceState;
      return new Set((parsed.knownRowKeys || []).filter((item) => typeof item === "string"));
    } catch {
      return new Set<string>();
    }
  }

  private saveInvoiceState(outputDir: string, knownRowKeys: Set<string>): void {
    const statePath = this.getStatePath(outputDir);
    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(
      tmpPath,
      JSON.stringify({
        knownRowKeys: Array.from(knownRowKeys),
      } as InvoiceState, null, 2)
    );
    renameSync(tmpPath, statePath);
  }

  private validateOutputDirPath(
    outputDir: string,
    invoiceRoot = INVOICE_ROOT_DIR,
    expectedProviderDir?: string,
  ): string {
    if (!isAbsolute(outputDir)) {
      throw new Error("--output-dir must be an absolute path.");
    }

    const normalizedRoot = resolve(invoiceRoot); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const normalizedOutput = resolve(outputDir);

    if (normalizedOutput !== normalizedRoot && !normalizedOutput.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error(
        `--output-dir must be under ${normalizedRoot}. Received: ${normalizedOutput}`
      );
    }

    if (expectedProviderDir) {
      const parts = normalizedOutput.startsWith(`${normalizedRoot}${sep}`)
        ? normalizedOutput.slice(normalizedRoot.length + 1).split(sep)
        : [];
      if (parts.length !== 3 || parts[0] !== ".staging" || !parts[1]) {
        throw new Error(
          `--output-dir must be a timestamped staging directory: ${normalizedRoot}/.staging/<run>/${expectedProviderDir}`,
        );
      }
      if (parts[2] !== expectedProviderDir) {
        throw new Error(`--output-dir provider directory must be ${expectedProviderDir}.`);
      }
    }

    let existingAncestor = normalizedRoot;
    const missingRootParts: string[] = [];
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("--output-dir has no existing trusted ancestor.");
      }
      missingRootParts.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
    let realRoot = realpathSync(existingAncestor);
    for (const part of missingRootParts) {
      const next = join(realRoot, part); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      if (existsSync(next)) {
        const metadata = lstatSync(next);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("--output-dir root path contains a non-directory or symbolic link.");
        }
      } else {
        mkdirSync(next, { mode: 0o755 });
      }
      realRoot = realpathSync(next);
    }

    let current = realRoot;
    const parts = normalizedOutput === normalizedRoot
      ? []
      : normalizedOutput.slice(normalizedRoot.length + 1).split(sep);
    for (const part of parts) {
      const next = join(current, part); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      if (existsSync(next)) {
        const metadata = lstatSync(next);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("--output-dir path contains a non-directory or symbolic link.");
        }
      } else {
        mkdirSync(next, { mode: 0o755 });
      }
      current = realpathSync(next);
      if (current !== realRoot && !current.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`--output-dir resolves outside ${realRoot}. Received: ${current}`);
      }
    }
    return current;
  }

  private validateLegacyDirPath(legacyDir: string): string {
    if (!isAbsolute(legacyDir)) {
      throw new Error("--legacy-dir must be an absolute path.");
    }
    return resolve(legacyDir);
  }

  private resolveRealPathAllowMissing(targetPath: string): string {
    let existingAncestor = resolve(targetPath);
    const missingSegments: string[] = [];

    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        return resolve(targetPath);
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }

    return resolve(realpathSync(existingAncestor), ...missingSegments);
  }

  private validateInvoiceDirectorySeparation(legacyDir: string, outputDir: string): void {
    const realLegacyDir = this.resolveRealPathAllowMissing(legacyDir);
    const realOutputDir = this.resolveRealPathAllowMissing(outputDir);
    const legacyContainsOutput = realOutputDir.startsWith(`${realLegacyDir}${sep}`);
    const outputContainsLegacy = realLegacyDir.startsWith(`${realOutputDir}${sep}`);

    if (realLegacyDir === realOutputDir || legacyContainsOutput || outputContainsLegacy) {
      throw new Error(
        "--legacy-dir and --output-dir must be distinct, non-overlapping real directories."
      );
    }
  }

  private sha256File(filePath: string): string {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return errorCode(error) !== "ESRCH";
    }
  }

  private withDownloadLockArbitration<T>(operation: () => T): T {
    const activeError = this.activeDownloadLockError();
    try {
      return withFileArbitrationGuard({
        path: `${this.downloadLockPath}.guard`,
        pid: process.pid,
        staleMs: LOCK_STALE_MS,
        now: Date.now,
        isPidAlive: (pid) => this.isProcessAlive(pid),
        tokenFactory: randomUUID,
        activeError: () => activeError,
      }, operation);
    } catch (error: unknown) {
      if (error === activeError) {
        throw error;
      }
      throw new Error(`Failed to arbitrate download lock: ${errorMessage(error)}`);
    }
  }

  private readLockSnapshot(): DownloadLockSnapshot | null {
    let fd: number;
    try {
      fd = openSync(this.downloadLockPath, "r");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const stat = fstatSync(fd);
      const raw = readFileSync(fd, "utf-8");
      let metadata: DownloadLockMetadata | null = null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as DownloadLockMetadata;
        }
      } catch {
      }
      return {
        raw,
        metadata,
        device: stat.dev,
        inode: stat.ino,
        modifiedAtMs: stat.mtimeMs,
      };
    } finally {
      closeSync(fd);
    }
  }

  private isCompleteLockMetadata(
    metadata: DownloadLockMetadata | null
  ): metadata is Required<DownloadLockMetadata> {
    if (!metadata) return false;
    const createdAtMs = typeof metadata.createdAt === "string"
      ? new Date(metadata.createdAt).getTime()
      : Number.NaN;
    return typeof metadata.pid === "number"
      && Number.isSafeInteger(metadata.pid)
      && metadata.pid > 0
      && Number.isFinite(createdAtMs)
      && typeof metadata.token === "string"
      && metadata.token.length > 0;
  }

  private isLockSnapshotReclaimable(snapshot: DownloadLockSnapshot): boolean {
    const pid = snapshot.metadata?.pid;
    if (Number.isSafeInteger(pid) && (pid as number) > 0) {
      return !this.isProcessAlive(pid as number);
    }

    const createdAtMs = typeof snapshot.metadata?.createdAt === "string"
      ? new Date(snapshot.metadata.createdAt).getTime()
      : Number.NaN;
    const ageAnchorMs = Number.isFinite(createdAtMs) ? createdAtMs : snapshot.modifiedAtMs;
    return Date.now() - ageAnchorMs > LOCK_STALE_MS;
  }

  private isSameReclaimCandidate(
    observed: DownloadLockSnapshot,
    confirmed: DownloadLockSnapshot
  ): boolean {
    if (observed.device !== confirmed.device || observed.inode !== confirmed.inode) {
      return false;
    }

    const observedToken = observed.metadata?.token;
    if (typeof observedToken === "string" && observedToken.length > 0) {
      return confirmed.metadata?.token === observedToken;
    }

    return observed.raw === confirmed.raw;
  }

  private tryCreateDownloadLock(token: string): boolean {
    let fd: number;
    try {
      fd = openSync(this.downloadLockPath, "wx");
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        return false;
      }
      throw new Error(`Failed to create download lock: ${errorMessage(error)}`);
    }

    try {
      const payload: Required<DownloadLockMetadata> = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token,
      };
      writeFileSync(fd, JSON.stringify(payload));

      this.downloadLockFd = fd;
      this.downloadLockToken = token;
      return true;
    } catch (error: unknown) {
      try {
        const createdStat = fstatSync(fd);
        const current = this.readLockSnapshot();
        if (
          current
          && current.device === createdStat.dev
          && current.inode === createdStat.ino
        ) {
          unlinkSync(this.downloadLockPath);
        }
      } catch {
      }
      try {
        closeSync(fd);
      } catch {
      }
      throw new Error(`Failed to write download lock: ${errorMessage(error)}`);
    }
  }

  private activeDownloadLockError(): Error {
    return new Error(
      `Another download-invoices run is already active (lock: ${this.downloadLockPath}).`
    );
  }

  private acquireDownloadLock(): void {
    if (this.downloadLockFd !== null || this.downloadLockToken !== null) {
      throw new Error("This client already owns the download-invoices lock.");
    }

    this.withDownloadLockArbitration(() => {
      const token = randomUUID();
      if (this.tryCreateDownloadLock(token)) {
        return;
      }

      const observed = this.readLockSnapshot();
      if (!observed) {
        if (!this.tryCreateDownloadLock(token)) {
          throw this.activeDownloadLockError();
        }
        return;
      }
      if (!this.isLockSnapshotReclaimable(observed)) {
        throw this.activeDownloadLockError();
      }

      const confirmed = this.readLockSnapshot();
      if (!confirmed) {
        if (!this.tryCreateDownloadLock(token)) {
          throw this.activeDownloadLockError();
        }
        return;
      }
      if (
        !this.isSameReclaimCandidate(observed, confirmed)
        || !this.isLockSnapshotReclaimable(confirmed)
      ) {
        throw this.activeDownloadLockError();
      }

      try {
        unlinkSync(this.downloadLockPath);
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") {
          throw new Error(`Failed to reclaim download lock: ${errorMessage(error)}`);
        }
      }

      if (!this.tryCreateDownloadLock(token)) {
        throw this.activeDownloadLockError();
      }
    });
  }

  private releaseDownloadLock(): void {
    const fd = this.downloadLockFd;
    const token = this.downloadLockToken;
    let releaseComplete = false;

    try {
      if (fd === null || token === null) {
        releaseComplete = true;
        return;
      }

      const ownedStat = fstatSync(fd);
      const current = this.readLockSnapshot();
      if (!current) {
        releaseComplete = true;
        return;
      }

      const stillOwned = current.device === ownedStat.dev
        && current.inode === ownedStat.ino
        && this.isCompleteLockMetadata(current.metadata)
        && current.metadata.token === token;
      if (stillOwned) {
        unlinkSync(this.downloadLockPath);
      }
      releaseComplete = true;
    } catch {
    } finally {
      if (!releaseComplete) {
        return;
      }
      try {
        if (fd !== null) {
          closeSync(fd);
        }
      } catch {
      }
      this.downloadLockFd = null;
      this.downloadLockToken = null;
    }
  }

  private migrateLegacyInvoices(legacyDir: string | undefined, outputDir: string): MigrationResult {
    const migration: MigrationResult = {
      moved: 0,
      skippedExisting: 0,
      errors: [],
    };

    if (!legacyDir || !existsSync(legacyDir)) {
      return migration;
    }

    let entries: string[] = [];
    let quarantineDir: string | null = null;
    const quarantineSource = (sourcePath: string, entry: string): void => {
      if (!quarantineDir) {
        const quarantineRoot = join(legacyDir, ".migrated-quarantine"); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        if (existsSync(quarantineRoot)) {
          const rootStat = lstatSync(quarantineRoot);
          if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error("legacy quarantine root is not a real directory");
          }
        } else {
          mkdirSync(quarantineRoot, { mode: 0o700 });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const quarantineStem = `${timestamp}-${process.pid}`;
        quarantineDir = join(quarantineRoot, quarantineStem); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        let suffix = 0;
        while (existsSync(quarantineDir)) {
          suffix += 1;
          quarantineDir = join(quarantineRoot, `${quarantineStem}-${suffix}`); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        }
        mkdirSync(quarantineDir, { mode: 0o700 });
      }
      renameSync(sourcePath, join(quarantineDir, entry)); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    };
    try {
      entries = readdirSync(legacyDir);
    } catch (error: any) {
      migration.errors.push(`Could not read legacy dir ${legacyDir}: ${error.message}`);
      return migration;
    }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".pdf")) {
        continue;
      }

      const sourcePath = join(legacyDir, entry);
      const destinationPath = join(outputDir, entry);
      const tempPath = `${destinationPath}.migrating-${process.pid}-${Date.now()}`;

      try {
        const sourceStat = lstatSync(sourcePath);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
          continue;
        }
        if (sourceStat.size <= 0) {
          throw new Error("legacy source is empty");
        }

        const sourceHash = this.sha256File(sourcePath);

        if (existsSync(destinationPath)) {
          const destinationStat = lstatSync(destinationPath);
          if (destinationStat.isSymbolicLink()) {
            throw new Error("destination is a symbolic link");
          }
          if (destinationStat.isFile() && destinationStat.size > 0) {
            if (this.sha256File(destinationPath) !== sourceHash) {
              throw new Error("destination exists with different SHA-256 content");
            }

            migration.skippedExisting += 1;
            quarantineSource(sourcePath, entry);
            continue;
          }
        }

        copyFileSync(sourcePath, tempPath);

        const tempStat = statSync(tempPath);
        if (!tempStat.isFile() || tempStat.size <= 0 || this.sha256File(tempPath) !== sourceHash) {
          throw new Error("migrated file SHA-256 mismatch");
        }

        if (existsSync(destinationPath)) {
          const destinationStat = lstatSync(destinationPath);
          if (destinationStat.isSymbolicLink()) {
            throw new Error("destination became a symbolic link during migration");
          }
          if (destinationStat.isFile() && destinationStat.size > 0) {
            if (this.sha256File(destinationPath) !== sourceHash) {
              throw new Error("destination changed during migration");
            }

            rmSync(tempPath, { force: true });
            migration.skippedExisting += 1;
            quarantineSource(sourcePath, entry);
            continue;
          }

          rmSync(destinationPath, { force: true });
        }

        renameSync(tempPath, destinationPath);

        const destinationStat = lstatSync(destinationPath);
        if (
          !destinationStat.isFile() ||
          destinationStat.size <= 0 ||
          this.sha256File(destinationPath) !== sourceHash
        ) {
          throw new Error("saved destination SHA-256 mismatch");
        }

        quarantineSource(sourcePath, entry);
        migration.moved += 1;
      } catch (error: any) {
        migration.errors.push(`Migration failed for ${entry}: ${error.message}`);
        try {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { force: true });
          }
        } catch {
        }
      }
    }

    return migration;
  }

  private sanitizePdfFilename(filename: string): string {
    const trimmed = basename(filename.trim());
    const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
    if (cleaned.toLowerCase().endsWith(".pdf")) {
      return cleaned;
    }
    return `${cleaned}.pdf`;
  }

  private buildRowIdentity(info: InvoiceRowInfo): string {
    return createHash("sha256")
      .update(info.rowKey || info.rowText)
      .digest("hex")
      .slice(0, 12);
  }

  private appendRowIdentity(filename: string, info: InvoiceRowInfo): string {
    const extension = extname(filename) || ".pdf";
    const stem = filename.slice(0, filename.length - extension.length);
    return `${stem}-${this.buildRowIdentity(info)}${extension}`;
  }

  private invoiceFilePath(outputDir: string, filename: string): string {
    return join(outputDir, basename(filename));
  }

  private resolveDedupeKey(info: InvoiceRowInfo): string {
    if (info.rowKey) {
      return info.rowKey;
    }
    return `rowtext:${this.buildRowIdentity(info)}`;
  }

  private claimExistingInvoiceFile(
    outputDir: string,
    knownRowKeys: Set<string>,
    claimedExistingFiles: Set<string>,
    preRunFiles: Set<string>,
    info: InvoiceRowInfo
  ): boolean {
    const fallbackFilename = `invoice-${this.buildRowIdentity(info)}.pdf`;
    const candidates: string[] = [];
    if (info.filenameHint) {
      const preferred = this.sanitizePdfFilename(info.filenameHint);
      candidates.push(preferred, this.appendRowIdentity(preferred, info));
    }
    candidates.push(fallbackFilename);

    let filename: string | undefined;
    for (const candidate of candidates) {
      if (claimedExistingFiles.has(candidate) || !preRunFiles.has(candidate)) continue;
      if (!this.isNonEmptyFile(this.invoiceFilePath(outputDir, candidate))) continue;
      filename = candidate;
      break;
    }
    if (!filename) return false;

    claimedExistingFiles.add(filename);
    this.persistSavedRowKey(outputDir, knownRowKeys, info, filename);
    return true;
  }

  private resolveInvoiceFilename(
    info: InvoiceRowInfo,
    suggestedFilename: string,
    existingFiles: Set<string>
  ): string {
    const fallbackFilename = `invoice-${this.buildRowIdentity(info)}.pdf`;
    const preferredFilename = info.filenameHint
      ? this.sanitizePdfFilename(info.filenameHint)
      : fallbackFilename;

    if (!existingFiles.has(preferredFilename)) {
      return preferredFilename;
    }

    return this.appendRowIdentity(preferredFilename, info);
  }

  private isNonEmptyFile(filePath: string): boolean {
    if (!existsSync(filePath)) {
      return false;
    }

    const fileStat = lstatSync(filePath);
    return fileStat.isFile() && fileStat.size > 0;
  }

  private async saveInvoiceDownload(
    download: Pick<Download, "suggestedFilename" | "saveAs">,
    info: InvoiceRowInfo,
    outputDir: string,
    existingFiles: Set<string>
  ): Promise<SavedInvoiceResult> {
    const filename = this.resolveInvoiceFilename(
      info,
      download.suggestedFilename(),
      existingFiles
    );
    const finalPath = join(outputDir, filename);
    const tempPath = `${finalPath}.part-${process.pid}-${Date.now()}`;

    if (this.isNonEmptyFile(finalPath)) {
      return { filename, downloaded: false };
    }

    try {
      await download.saveAs(tempPath);

      if (!this.isNonEmptyFile(tempPath)) {
        throw new Error("downloaded file is empty");
      }

      if (this.isNonEmptyFile(finalPath)) {
        rmSync(tempPath, { force: true });
        existingFiles.add(filename);
        return { filename, downloaded: false };
      }

      if (existsSync(finalPath)) {
        rmSync(finalPath, { force: true });
      }

      renameSync(tempPath, finalPath);
      if (!this.isNonEmptyFile(finalPath)) {
        throw new Error("saved invoice is empty");
      }

      existingFiles.add(filename);
      return { filename, downloaded: true };
    } catch (error) {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { force: true });
      }
      throw error;
    }
  }

  private persistSavedRowKey(
    outputDir: string,
    knownRowKeys: Set<string>,
    info: InvoiceRowInfo,
    filename: string
  ): void {
    if (!this.isNonEmptyFile(this.invoiceFilePath(outputDir, filename))) {
      throw new Error(`Refusing to persist row key before ${filename} is proven saved.`);
    }

    knownRowKeys.add(this.resolveDedupeKey(info));
    this.saveInvoiceState(outputDir, knownRowKeys);
  }

  private normalizeAmountToken(text: string): string | undefined {
    const match = text.match(/£\s*([\d,]+(?:\.\d{2})?)/i);
    if (!match) {
      return undefined;
    }
    return match[1].replace(/,/g, "");
  }

  private normalizeDateToken(text: string): string | undefined {
    const yearMonth = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
    if (yearMonth) {
      return `${yearMonth[1]}${String(yearMonth[2]).padStart(2, "0")}`;
    }

    const monthYear = text.match(/\b(0?[1-9]|1[0-2])[-/](20\d{2})\b/);
    if (monthYear) {
      return `${monthYear[2]}${String(monthYear[1]).padStart(2, "0")}`;
    }

    const monthNames: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };

    const namedMonth = text.match(/\b(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\b\s*(20\d{2})/i);
    if (namedMonth) {
      const key = namedMonth[1].slice(0, 3).toLowerCase();
      return `${namedMonth[2]}${monthNames[key]}`;
    }

    return undefined;
  }

  private extractInvoiceNumber(text: string): string | undefined {
    const invoiceMatch = text.match(/\b(?:invoice|inv)\D{0,6}(\d{5,})\b/i);
    if (invoiceMatch) {
      return invoiceMatch[1];
    }

    const genericLongNumber = text.match(/\b(\d{7,})\b/);
    if (genericLongNumber) {
      return genericLongNumber[1];
    }

    return undefined;
  }

  private buildRowKey(info: InvoiceRowInfo): string | undefined {
    const parts: string[] = [];
    if (info.invoiceNumber) {
      parts.push(`invoice:${info.invoiceNumber}`);
    }
    if (info.dateToken) {
      parts.push(`date:${info.dateToken}`);
    }
    if (info.amountToken) {
      parts.push(`amount:${info.amountToken}`);
    }

    if (parts.length < 2) {
      return undefined;
    }

    return parts.join("|");
  }

  private buildFilenameHint(info: InvoiceRowInfo): string | undefined {
    if (info.invoiceNumber && info.dateToken) {
      return this.sanitizePdfFilename(`invoice-${info.dateToken}-${info.invoiceNumber}.pdf`);
    }
    if (info.invoiceNumber) {
      return this.sanitizePdfFilename(`invoice-${info.invoiceNumber}.pdf`);
    }
    if (info.dateToken) {
      return this.sanitizePdfFilename(`invoice-${info.dateToken}.pdf`);
    }
    return undefined;
  }

  private async rowHasDownloadControl(row: Locator): Promise<boolean> {
    const selectors = [
      'a:has-text("Download")',
      'button:has-text("Download")',
      "a[download]",
      "button[download]",
      'a[href*=".pdf"]',
      '[data-testid*="download"]',
    ];

    for (const selector of selectors) {
      const control = row.locator(selector).first();
      if (await control.count()) {
        return true;
      }
    }

    return false;
  }

  private async findDownloadControl(row: Locator): Promise<Locator | null> {
    const selectors = [
      'a:has-text("Download")',
      'button:has-text("Download")',
      "a[download]",
      "button[download]",
      'a[href*=".pdf"]',
      '[data-testid*="download"]',
    ];

    for (const selector of selectors) {
      const control = row.locator(selector).first();
      if (await control.count()) {
        return control;
      }
    }

    return null;
  }

  private async extractRowInfo(row: Locator, rowIndex: number): Promise<InvoiceRowInfo | null> {
    const hasDownload = await this.rowHasDownloadControl(row);
    if (!hasDownload) {
      return null;
    }

    const rowText = (await row.innerText()).replace(/\s+/g, " ").trim();
    if (!rowText) {
      return null;
    }

    const info: InvoiceRowInfo = {
      rowText,
      rowIndex,
      invoiceNumber: this.extractInvoiceNumber(rowText),
      dateToken: this.normalizeDateToken(rowText),
      amountToken: this.normalizeAmountToken(rowText),
    };

    info.rowKey = this.buildRowKey(info);
    info.filenameHint = this.buildFilenameHint(info);

    return info;
  }

  private describeInvoiceRow(info: InvoiceRowInfo): string {
    if (info.invoiceNumber) {
      return `invoice ${info.invoiceNumber}`;
    }
    if (info.filenameHint) {
      return info.filenameHint;
    }
    return `row-${info.rowIndex}`;
  }

  private async resolveInvoiceRowSelector(page: Page): Promise<string | null> {
    const selectors = [
      "table tbody tr",
      'tr:has(a:has-text("Download"))',
      'tr:has(button:has-text("Download"))',
      '[data-testid*="invoice"] tr',
    ];

    for (const selector of selectors) {
      if (await page.locator(selector).count()) {
        return selector;
      }
    }

    return null;
  }

  private async goToNextInvoicePage(page: Page): Promise<boolean> {
    const nextSelectors = [
      'a[aria-label*="Next"]',
      'button[aria-label*="Next"]',
      'a:has-text("Next")',
      'button:has-text("Next")',
      "li.next a",
      '[data-testid*="next"]',
    ];

    for (const selector of nextSelectors) {
      const next = page.locator(selector).first();
      if (!(await next.count())) {
        continue;
      }

      const ariaDisabled = (await next.getAttribute("aria-disabled")) === "true";
      const disabledAttr = (await next.getAttribute("disabled")) !== null;
      const className = (await next.getAttribute("class")) || "";
      const classDisabled = /disabled/i.test(className);
      if (ariaDisabled || disabledAttr || classDisabled) {
        continue;
      }

      try {
        await next.click({ timeout: 10000 });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private collectExistingInvoiceFiles(outputDir: string): Set<string> {
    const existingFiles = new Set<string>();
    for (const entry of readdirSync(outputDir)) {
      if (entry.toLowerCase().endsWith(".pdf") && this.isNonEmptyFile(join(outputDir, entry))) {
        existingFiles.add(entry);
      }
    }
    return existingFiles;
  }


  async createLabel(options: CreateLabelOptions): Promise<Result> {
    const page = await this.ensureBrowser();

    try {
      await this.login();
      await page.goto(ROYALMAIL_CREATE_ORDER_URL, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(2000);

      const initialScreenshot = `${SCREENSHOT_DIR}/royalmail-form-initial-${Date.now()}.png`;
      await page.screenshot({ path: initialScreenshot, fullPage: true });

      await this.fillField(page, ["Full name", "Name", "Recipient name", "fullName"], options.name);

      if (options.company) {
        await this.fillField(page, ["Company", "Company name", "Business name", "companyName"], options.company);
      }

      await this.fillField(page, ["Address line 1", "Address 1", "Street address", "addressLine1", "address1"], options.address1);

      if (options.address2) {
        await this.fillField(page, ["Address line 2", "Address 2", "addressLine2", "address2"], options.address2);
      }

      await this.fillField(page, ["City", "Town", "Town/City", "city"], options.city);
      await this.fillField(page, ["Postcode", "Post code", "ZIP", "Postal code", "postcode"], options.postcode);

      if (options.email) {
        await this.fillField(page, ["Email", "Email address", "email"], options.email);
      }

      if (options.phone) {
        await this.fillField(page, ["Phone", "Telephone", "Mobile", "Contact number", "phone"], options.phone);
      }

      await this.fillField(page, ["Weight", "Package weight", "weight"], String(options.weight));

      if (options.length) {
        await this.fillField(page, ["Length", "length"], String(options.length));
      }
      if (options.width) {
        await this.fillField(page, ["Width", "width"], String(options.width));
      }
      if (options.height) {
        await this.fillField(page, ["Height", "height"], String(options.height));
      }

      await this.selectService(page, options.service);

      if (options.reference) {
        await this.fillField(page, ["Reference", "Order reference", "Customer reference", "Your reference", "reference"], options.reference);
      }

      if (options.contents) {
        await this.fillField(page, ["Contents", "Package contents", "Description", "Item description", "contents"], options.contents);
      }

      const previewScreenshot = `${SCREENSHOT_DIR}/royalmail-form-preview-${Date.now()}.png`;
      await page.screenshot({ path: previewScreenshot, fullPage: true });

      this.updateSession({ formFilled: true });

      const formState: FormState = {
        name: options.name,
        company: options.company,
        address1: options.address1,
        address2: options.address2,
        city: options.city,
        postcode: options.postcode,
        weight: options.weight,
        service: SERVICE_CODES[options.service] || options.service,
        reference: options.reference,
      };

      return {
        success: true,
        screenshot: previewScreenshot,
        formState,
        message:
          "Form preview created. Review the screenshot, then recreate and complete the purchase manually in the Royal Mail portal. The CLI cannot safely continue this browser session in another command.",
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-form-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Form fill error: ${error.message}`,
        screenshot: errorScreenshot,
      };
    }
  }

  private async fillField(page: Page, labelVariants: string[], value: string): Promise<void> {
    for (const label of labelVariants) {
      try {
        let field = await page.$(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        field = await page.$(`input[placeholder*="${label}" i], textarea[placeholder*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        const labelEl = await page.$(`label:has-text("${label}")`);
        if (labelEl) {
          const forAttr = await labelEl.getAttribute("for");
          if (forAttr) {
            field = await page.$(`#${forAttr}`);
            if (field) {
              await field.fill(value);
              return;
            }
          }

          field = await labelEl.$("xpath=following-sibling::input | following-sibling::textarea | ../input | ../textarea | .//input | .//textarea");
          if (field) {
            await field.fill(value);
            return;
          }
        }

        const nameVariant = label.toLowerCase().replace(/\s+/g, "");
        field = await page.$(`input[name*="${nameVariant}" i], textarea[name*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        field = await page.$(`input[id*="${nameVariant}" i], textarea[id*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        field = await page.$(`input[data-testid*="${nameVariant}" i], textarea[data-testid*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }
      } catch {
        continue;
      }
    }
  }

  private async selectService(page: Page, serviceCode: string): Promise<void> {
    const serviceName = SERVICE_CODES[serviceCode] || serviceCode;

    const selectSelectors = [
      'select[name*="service" i]',
      'select[id*="service" i]',
      'select[aria-label*="service" i]',
      "#serviceType",
      "#service",
    ];

    for (const selector of selectSelectors) {
      try {
        const select = await page.$(selector);
        if (select) {
          try {
            await select.selectOption({ value: serviceCode });
            return;
          } catch {
            await select.selectOption({ label: serviceName });
            return;
          }
        }
      } catch {
        continue;
      }
    }

    try {
      const radio = await page.$(`input[type="radio"][value*="${serviceCode}" i], input[type="radio"][value*="${serviceName}" i]`);
      if (radio) {
        await radio.click();
        return;
      }
    } catch {
    }

    try {
      const tile = await page.$(`[data-service="${serviceCode}"], [data-value="${serviceCode}"], .service-tile:has-text("${serviceName}")`);
      if (tile) {
        await tile.click();
        return;
      }
    } catch {
    }

    try {
      const label = await page.$(`label:has-text("${serviceName}"), div:has-text("${serviceName}"):not(:has(div))`);
      if (label) {
        await label.click();
      }
    } catch {
    }
  }

  async submit(): Promise<Result> {
    return {
      error: true,
      code: "manual-finalization-required",
      requiresManualConfirmation: true,
      message:
        "Automated Royal Mail submission is disabled because the CLI cannot reconnect to the exact filled form safely. Recreate and complete the purchase manually in the Royal Mail portal.",
    };
  }


  async downloadLabel(): Promise<Result> {
    const page = await this.ensureBrowser();

    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (!session.labelGenerated) {
        return {
          error: true,
          message: "Label has not been generated yet. Call submit first.",
        };
      }
    }

    try {
      const downloadSelectors = [
        'button:has-text("Download")',
        'button:has-text("Print")',
        'button:has-text("Get label")',
        'a:has-text("Download")',
        'a:has-text("Print label")',
        '[data-testid="download-label"]',
        ".download-label",
      ];

      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });

      for (const selector of downloadSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.click();
            break;
          }
        } catch {
          continue;
        }
      }

      const download: Download = await downloadPromise;
      const suggestedFilename = download.suggestedFilename();

      let trackingNumber = suggestedFilename.match(/([A-Z]{2}\d{9}GB)/)?.[1];
      if (!trackingNumber) {
        trackingNumber = `label-${Date.now()}`;
      }

      const labelPath = `${LABEL_DIR}/${trackingNumber}.pdf`;
      await download.saveAs(labelPath);

      return {
        success: true,
        labelPath,
        trackingNumber,
        message: `Label downloaded successfully to ${labelPath}`,
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-download-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Download failed: ${error.message}`,
        screenshot: errorScreenshot,
      };
    }
  }

  async downloadInvoices(options: DownloadInvoicesOptions): Promise<DownloadInvoicesResult> {
    const legacyDir = (options as DownloadInvoicesOptions & { legacyDir?: string }).legacyDir;
    if (legacyDir) {
      throw new Error(
        "Royal Mail --legacy-dir migration is retired; bind legacy files through invoice-providers prepare-promotion and exact promote-staging instead."
      );
    }
    this.setHeaded(options.headed === true);

    const outputDir = this.validateOutputDirPath(options.outputDir, INVOICE_ROOT_DIR, "Royal Mail");

    this.acquireDownloadLock();

    const startedAt = new Date().toISOString();
    const downloaded: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const migration: MigrationResult = { moved: 0, skippedExisting: 0, errors: [] };

    try {
      const knownRowKeys = this.loadInvoiceState(outputDir);
      const existingFiles = this.collectExistingInvoiceFiles(outputDir);
      const preRunFiles = new Set(existingFiles);
      const claimedExistingFiles = new Set<string>();

      if (migration.errors.length > 0) {
        warnings.push(...migration.errors.map((e) => `Migration warning: ${e}`));
      }

      const page = await this.ensureBrowser();
      await this.login();
      await page.goto(ROYALMAIL_INVOICES_URL, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1200);

      let totalSeen = 0;

      for (let currentPage = 1; currentPage <= MAX_INVOICE_PAGES; currentPage++) {
        const rowSelector = await this.resolveInvoiceRowSelector(page);
        if (!rowSelector) {
          break;
        }

        const rowCount = await page.locator(rowSelector).count();
        if (!rowCount) {
          break;
        }

        let pageAllKnown = true;
        let pageHadErrors = false;

        for (let index = 0; index < rowCount; index++) {
          const row = page.locator(rowSelector).nth(index);
          const info = await this.extractRowInfo(row, index + 1);
          if (!info) {
            continue;
          }

          totalSeen += 1;

          const rowLabel = this.describeInvoiceRow(info);
          const knownByRowKey = knownRowKeys.has(this.resolveDedupeKey(info));
          const adoptedExistingFile = knownByRowKey
            ? false
            : this.claimExistingInvoiceFile(
                outputDir,
                knownRowKeys,
                claimedExistingFiles,
                preRunFiles,
                info
              );

          if (knownByRowKey || adoptedExistingFile) {
            skipped.push(rowLabel);
            continue;
          }

          pageAllKnown = false;

          try {
            const control = await this.findDownloadControl(row);
            if (!control) {
              pageHadErrors = true;
              errors.push(`No download control found for ${rowLabel}`);
              continue;
            }

            const downloadPromise = page.waitForEvent("download", { timeout: 45000 });
            await control.click({ timeout: 10000 });
            const download = await downloadPromise;
            const savedInvoice = await this.saveInvoiceDownload(
              download,
              info,
              outputDir,
              existingFiles
            );

            this.persistSavedRowKey(
              outputDir,
              knownRowKeys,
              info,
              savedInvoice.filename
            );
            claimedExistingFiles.add(savedInvoice.filename);

            if (savedInvoice.downloaded) {
              downloaded.push(savedInvoice.filename);
            } else {
              skipped.push(savedInvoice.filename);
            }
          } catch (error: any) {
            pageHadErrors = true;
            errors.push(`Download failed for ${rowLabel}: ${error.message}`);
          }
        }

        if (pageAllKnown && !pageHadErrors) {
          break;
        }

        const movedToNext = await this.goToNextInvoicePage(page);
        if (!movedToNext) {
          break;
        }
      }

      this.saveInvoiceState(outputDir, knownRowKeys);

      const finishedAt = new Date().toISOString();
      const partialFailure = errors.length > 0 || migration.errors.length > 0;

      return {
        schemaVersion: "1.0",
        provider: "royal-mail",
        success: true,
        partialFailure,
        outputDir,
        startedAt,
        finishedAt,
        totalSeen,
        downloaded,
        skipped,
        errors,
        warnings,
        migration,
      };
    } finally {
      this.releaseDownloadLock();
    }
  }


  async listServices(): Promise<ServiceInfo[]> {
    return ROYAL_MAIL_SERVICES.map((service) => ({
      code: service.key,
      name: service.displayName,
      description: `${service.trackingKind === "none" ? "Untracked" : service.trackingKind === "full" ? "Tracked" : "Delivery confirmation"}; ${service.vatTreatment === "standard20" ? "20% VAT" : "VAT exempt"}`,
    }));
  }


  async takeScreenshot(options?: ScreenshotOptions): Promise<Result> {
    const page = await this.ensureBrowser();

    const filename = options?.filename || `royalmail-${Date.now()}.png`;
    const screenshotPath = resolveScreenshotPath(filename, SCREENSHOT_DIR);

    await page.screenshot({
      path: screenshotPath,
      fullPage: options?.fullPage ?? false,
    });

    return {
      success: true,
      screenshot: screenshotPath,
    };
  }


  async reset(): Promise<Result> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
      }

      if (existsSync(SESSION_PATH)) {
        unlinkSync(SESSION_PATH);
      }

      return {
        success: true,
        message: "Browser session closed and cleared.",
      };
    } catch (error: any) {
      return {
        error: true,
        message: `Reset failed: ${error.message}`,
      };
    }
  }
}
