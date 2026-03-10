/**
 * Royal Mail Label Manager Client
 *
 * Browser automation client for creating Royal Mail shipping labels
 * and downloading Royal Mail invoices via Click & Drop.
 */

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
} from "fs";
import { dirname, join, resolve, isAbsolute, sep, basename } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const SESSION_PATH = "/tmp/royalmail-session.json";
const SCREENSHOT_DIR = "/Users/USER/biz/.playwright-mcp";
const LABEL_DIR = "/Users/USER/biz/shipping-labels";
const CONFIG_PATH = join(__dirname, "..", "config.json");
const DOWNLOAD_LOCK_PATH = "/tmp/download-invoices-royal-mail.lock";
const INVOICE_ROOT_DIR = "/Users/USER/biz/mydrive/Downloads/From Claude/Invoices";
const INVOICE_STATE_FILENAME = ".download-invoices-state.json";

// Royal Mail URLs
const ROYALMAIL_LOGIN_URL = "https://business.parcel.royalmail.com/";
const ROYALMAIL_CREATE_ORDER_URL = "https://business.parcel.royalmail.com/orders/single/create";
const ROYALMAIL_INVOICES_URL = "https://business.parcel.royalmail.com/payments/invoices/";

const BW_TIMEOUT_MS = 6000;
const LOCK_STALE_MS = 45 * 60 * 1000;
const MAX_INVOICE_PAGES = 12;

// Service code mappings
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

interface Config {
  royalmail?: {
    username?: string;
    password?: string;
  };
}

interface RoyalMailCredentials {
  username: string;
  password: string;
}

interface InvoiceState {
  knownRowKeys: string[];
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
  legacyDir?: string;
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
  message?: string;
  screenshot?: string;
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

export class RoyalMailClient {
  private config: Config;
  private credentials: RoyalMailCredentials | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserHeadless = true;
  private downloadLockFd: number | null = null;

  constructor() {
    this.config = this.loadConfig();
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    if (!existsSync(LABEL_DIR)) {
      mkdirSync(LABEL_DIR, { recursive: true });
    }
  }

  // ============================================
  // INTERNAL
  // ============================================

  setHeaded(headed: boolean): void {
    const desiredHeadless = !headed;
    if (this.browserHeadless === desiredHeadless) {
      return;
    }

    this.browserHeadless = desiredHeadless;

    // Switching headed/headless should not reuse an old incompatible session.
    try {
      if (existsSync(SESSION_PATH)) {
        unlinkSync(SESSION_PATH);
      }
    } catch {
      // Ignore cleanup errors.
    }
  }

  private loadConfig(): Config {
    if (!existsSync(CONFIG_PATH)) {
      return {};
    }

    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return parsed as Config;
    } catch {
      throw new Error(`Invalid JSON in config file at ${CONFIG_PATH}`);
    }
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

    const bitwardenCreds = this.tryResolveBitwardenCredentials(username);
    if (bitwardenCreds) {
      this.credentials = bitwardenCreds;
      return this.credentials;
    }

    throw new Error(
      "Royal Mail credentials not found. Configure scripts/config.json with royalmail.username/password, " +
      "or provide an unlocked Bitwarden session via BW_SESSION."
    );
  }

  private tryResolveBitwardenCredentials(preferredUsername?: string): RoyalMailCredentials | null {
    const bwSession = process.env.BW_SESSION?.trim();
    if (!bwSession) {
      return null;
    }

    const candidates = [
      "royalmail.com",
      "business.parcel.royalmail.com",
      "Royal Mail",
      "royalmail",
    ];

    for (const item of candidates) {
      const rawItem = this.runBw(["get", "item", item, "--session", bwSession]);
      if (!rawItem) {
        continue;
      }

      try {
        const parsed = JSON.parse(rawItem) as {
          login?: { username?: string; password?: string };
        };
        const username = parsed.login?.username?.trim();
        const password = parsed.login?.password?.trim();
        if (username && password) {
          return { username, password };
        }
      } catch {
        // Ignore parse errors and continue candidate search.
      }
    }

    if (preferredUsername) {
      for (const target of ["royalmail.com", "business.parcel.royalmail.com", "royalmail"]) {
        const rawPassword = this.runBw(["get", "password", target, "--session", bwSession]);
        if (rawPassword) {
          const password = rawPassword.trim();
          if (password) {
            return { username: preferredUsername, password };
          }
        }
      }
    }

    return null;
  }

  private runBw(args: string[]): string | null {
    try {
      return execFileSync("bw", args, {
        encoding: "utf-8",
        timeout: BW_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          BW_NOINTERACTION: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
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
          // Ignore deletion errors
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
      writeFileSync(
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
      writeFileSync(SESSION_PATH, JSON.stringify(session));
    }
  }

  private async login(): Promise<boolean> {
    const credentials = this.resolveCredentials();
    const page = await this.ensureBrowser();

    // Check if already logged in
    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (session.loggedIn) {
        try {
          await page.goto(ROYALMAIL_CREATE_ORDER_URL, { waitUntil: "networkidle", timeout: 30000 });
          if (!page.url().includes("login") && !page.url().includes("signin")) {
            return true;
          }
        } catch {
          // Continue to login
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
        // Continue trying other selectors.
      }
    }

    // Last-resort fallback for overlay-only blockers.
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
      // Ignore non-fatal cookie dismissal failures.
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

  private validateOutputDirPath(outputDir: string): string {
    if (!isAbsolute(outputDir)) {
      throw new Error("--output-dir must be an absolute path.");
    }

    const normalizedRoot = resolve(INVOICE_ROOT_DIR);
    const normalizedOutput = resolve(outputDir);

    if (normalizedOutput !== normalizedRoot && !normalizedOutput.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error(
        `--output-dir must be under ${normalizedRoot}. Received: ${normalizedOutput}`
      );
    }

    return normalizedOutput;
  }

  private validateLegacyDirPath(legacyDir: string): string {
    if (!isAbsolute(legacyDir)) {
      throw new Error("--legacy-dir must be an absolute path.");
    }
    return resolve(legacyDir);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private readLockMetadata(): { pid?: number; createdAt?: string } | null {
    if (!existsSync(DOWNLOAD_LOCK_PATH)) {
      return null;
    }

    try {
      const raw = readFileSync(DOWNLOAD_LOCK_PATH, "utf-8");
      const parsed = JSON.parse(raw) as { pid?: number; createdAt?: string };
      return parsed;
    } catch {
      return null;
    }
  }

  private acquireDownloadLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(DOWNLOAD_LOCK_PATH, "wx");
        const payload = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        writeFileSync(fd, JSON.stringify(payload));
        this.downloadLockFd = fd;
        return;
      } catch (error: any) {
        if (error?.code !== "EEXIST") {
          throw new Error(`Failed to create download lock: ${error?.message || String(error)}`);
        }

        const metadata = this.readLockMetadata();
        const createdAtMs = metadata?.createdAt ? new Date(metadata.createdAt).getTime() : 0;
        const tooOld = !createdAtMs || Date.now() - createdAtMs > LOCK_STALE_MS;
        const processDead = !metadata?.pid || !this.isProcessAlive(metadata.pid);

        if (tooOld || processDead) {
          try {
            rmSync(DOWNLOAD_LOCK_PATH, { force: true });
            continue;
          } catch {
            // fall through to lock error below
          }
        }

        throw new Error(
          `Another download-invoices run is already active (lock: ${DOWNLOAD_LOCK_PATH}).`
        );
      }
    }

    throw new Error(`Could not acquire lock at ${DOWNLOAD_LOCK_PATH}`);
  }

  private releaseDownloadLock(): void {
    try {
      if (this.downloadLockFd !== null) {
        closeSync(this.downloadLockFd);
      }
    } catch {
      // Ignore close errors.
    } finally {
      this.downloadLockFd = null;
    }

    try {
      if (existsSync(DOWNLOAD_LOCK_PATH)) {
        rmSync(DOWNLOAD_LOCK_PATH, { force: true });
      }
    } catch {
      // Ignore unlock errors.
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
        const sourceStat = statSync(sourcePath);
        if (!sourceStat.isFile()) {
          continue;
        }

        if (existsSync(destinationPath)) {
          const destinationStat = statSync(destinationPath);
          if (destinationStat.size > 0) {
            migration.skippedExisting += 1;
            if (destinationStat.size === sourceStat.size) {
              unlinkSync(sourcePath);
            }
            continue;
          }

          // Remove zero-byte destination so migration can repair it.
          rmSync(destinationPath, { force: true });
        }

        copyFileSync(sourcePath, tempPath);

        const tempStat = statSync(tempPath);
        if (tempStat.size <= 0 || tempStat.size !== sourceStat.size) {
          throw new Error("migrated file size mismatch");
        }

        renameSync(tempPath, destinationPath);
        unlinkSync(sourcePath);
        migration.moved += 1;
      } catch (error: any) {
        migration.errors.push(`Migration failed for ${entry}: ${error.message}`);
        try {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { force: true });
          }
        } catch {
          // Ignore cleanup errors.
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
      if (entry.toLowerCase().endsWith(".pdf")) {
        existingFiles.add(entry);
      }
    }
    return existingFiles;
  }

  // ============================================
  // LABEL OPERATIONS
  // ============================================

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
        message: "Form filled successfully. Please review the screenshot before calling submit.",
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
      // continue
    }

    try {
      const tile = await page.$(`[data-service="${serviceCode}"], [data-value="${serviceCode}"], .service-tile:has-text("${serviceName}")`);
      if (tile) {
        await tile.click();
        return;
      }
    } catch {
      // continue
    }

    try {
      const label = await page.$(`label:has-text("${serviceName}"), div:has-text("${serviceName}"):not(:has(div))`);
      if (label) {
        await label.click();
      }
    } catch {
      // continue
    }
  }

  async submit(): Promise<Result> {
    const page = await this.ensureBrowser();

    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (!session.formFilled) {
        return {
          error: true,
          message: "Form has not been filled yet. Call create-label first.",
        };
      }
    }

    try {
      const submitButtonSelectors = [
        'button:has-text("Buy postage")',
        'button:has-text("Apply postage")',
        'button:has-text("Create label")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'button:has-text("Submit")',
        'button[type="submit"]',
        '[data-testid="submit-button"]',
        '[data-testid="create-label-button"]',
      ];

      for (const selector of submitButtonSelectors) {
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

      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3000);

      const reviewScreenshot = `${SCREENSHOT_DIR}/royalmail-review-${Date.now()}.png`;
      await page.screenshot({ path: reviewScreenshot, fullPage: true });

      const confirmButtons = [
        'button:has-text("Confirm")',
        'button:has-text("Pay")',
        'button:has-text("Complete")',
        'button:has-text("Finish")',
      ];

      for (const selector of confirmButtons) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.click();
            await page.waitForLoadState("networkidle");
            await page.waitForTimeout(3000);
            break;
          }
        } catch {
          continue;
        }
      }

      const confirmationScreenshot = `${SCREENSHOT_DIR}/royalmail-confirmation-${Date.now()}.png`;
      await page.screenshot({ path: confirmationScreenshot, fullPage: true });

      const extractedData = await this.extractConfirmation(page);

      this.updateSession({ labelGenerated: true });

      return {
        success: true,
        screenshot: confirmationScreenshot,
        trackingNumber: extractedData.trackingNumber,
        cost: extractedData.cost,
        message: "Label created successfully. Call download-label to save the PDF.",
      };
    } catch (error: any) {
      const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-submit-error-${Date.now()}.png`;
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      return {
        error: true,
        message: `Submit failed: ${error.message}`,
        screenshot: errorScreenshot,
      };
    }
  }

  private async extractConfirmation(page: Page): Promise<{ trackingNumber?: string; cost?: string }> {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText;

        const trackingPatterns = [
          /Tracking[:\s#]*([A-Z]{2}\d{9}GB)/i,
          /Reference[:\s#]*([A-Z]{2}\d{9}GB)/i,
          /([A-Z]{2}\d{9}GB)/,
          /Barcode[:\s#]*(\d+)/i,
        ];

        let trackingNumber: string | undefined = undefined;
        for (const pattern of trackingPatterns) {
          const match = text.match(pattern);
          if (match) {
            trackingNumber = match[1];
            break;
          }
        }

        const costPatterns = [
          /Total[:\s]*[£\$]?([\d.,]+)/i,
          /Cost[:\s]*[£\$]?([\d.,]+)/i,
          /Price[:\s]*[£\$]?([\d.,]+)/i,
          /[£]([\d.,]+)/,
        ];

        let cost: string | undefined = undefined;
        for (const pattern of costPatterns) {
          const match = text.match(pattern);
          if (match) {
            cost = `£${match[1]}`;
            break;
          }
        }

        return { trackingNumber, cost };
      });
    } catch {
      return {};
    }
  }

  // ============================================
  // DOWNLOAD OPERATIONS
  // ============================================

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
    this.setHeaded(options.headed === true);

    const outputDir = this.validateOutputDirPath(options.outputDir);
    const legacyDir = options.legacyDir ? this.validateLegacyDirPath(options.legacyDir) : undefined;

    this.acquireDownloadLock();

    const startedAt = new Date().toISOString();
    const downloaded: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const migration = this.migrateLegacyInvoices(legacyDir, outputDir);
      const knownRowKeys = this.loadInvoiceState(outputDir);
      const existingFiles = this.collectExistingInvoiceFiles(outputDir);

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
          const knownByRowKey = info.rowKey ? knownRowKeys.has(info.rowKey) : false;
          const knownByFilename = info.filenameHint ? existingFiles.has(info.filenameHint) : false;

          if (knownByRowKey || knownByFilename) {
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

            const suggestedFilename = this.sanitizePdfFilename(
              download.suggestedFilename() || info.filenameHint || `invoice-${Date.now()}-${index + 1}.pdf`
            );

            const finalPath = join(outputDir, suggestedFilename);
            const tempPath = `${finalPath}.part-${process.pid}-${Date.now()}`;

            if (existsSync(finalPath) && statSync(finalPath).size > 0) {
              skipped.push(suggestedFilename);
              if (info.rowKey) {
                knownRowKeys.add(info.rowKey);
              }
              continue;
            }

            await download.saveAs(tempPath);

            const tempStat = statSync(tempPath);
            if (tempStat.size <= 0) {
              rmSync(tempPath, { force: true });
              pageHadErrors = true;
              errors.push(`Downloaded zero-byte invoice for ${rowLabel}`);
              continue;
            }

            if (existsSync(finalPath)) {
              const currentStat = statSync(finalPath);
              if (currentStat.size > 0) {
                rmSync(tempPath, { force: true });
                skipped.push(suggestedFilename);
                if (info.rowKey) {
                  knownRowKeys.add(info.rowKey);
                }
                continue;
              }

              rmSync(finalPath, { force: true });
            }

            renameSync(tempPath, finalPath);
            existingFiles.add(suggestedFilename);
            downloaded.push(suggestedFilename);

            if (info.rowKey) {
              knownRowKeys.add(info.rowKey);
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

  // ============================================
  // SERVICE INFORMATION
  // ============================================

  async listServices(): Promise<ServiceInfo[]> {
    return [
      { code: "TRACKED24", name: "Royal Mail Tracked 24", description: "Next working day delivery with tracking" },
      { code: "TRACKED48", name: "Royal Mail Tracked 48", description: "2-3 working day delivery with tracking" },
      { code: "SPECIALDELIVERY9", name: "Special Delivery Guaranteed by 9am", description: "Next day by 9am, compensation up to £2,500" },
      { code: "SPECIALDELIVERY1", name: "Special Delivery Guaranteed by 1pm", description: "Next day by 1pm, compensation up to £500" },
      { code: "SIGNED", name: "Royal Mail Signed For 1st Class", description: "1st class with signature on delivery" },
      { code: "SIGNED2", name: "Royal Mail Signed For 2nd Class", description: "2nd class with signature on delivery" },
    ];
  }

  // ============================================
  // SCREENSHOT OPERATIONS
  // ============================================

  async takeScreenshot(options?: ScreenshotOptions): Promise<Result> {
    const page = await this.ensureBrowser();

    const filename = options?.filename || `royalmail-${Date.now()}.png`;
    const screenshotPath = `${SCREENSHOT_DIR}/${filename}`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: options?.fullPage ?? false,
    });

    return {
      success: true,
      screenshot: screenshotPath,
    };
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

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
