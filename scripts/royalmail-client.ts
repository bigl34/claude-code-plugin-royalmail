/**
 * Royal Mail Label Manager Client
 *
 * Browser automation client for creating Royal Mail shipping labels
 * via Click & Drop. Uses Playwright in headless mode.
 *
 * Key features:
 * - Login: Automated authentication
 * - Label creation: Fill recipient and package details
 * - Service selection: Tracked 24, Tracked 48, Special Delivery, etc.
 * - Download: Save PDF labels to shipping-labels directory
 *
 * Default sender: YOUR_COMPANY YOUR_CITY warehouse (YOUR_POSTCODE)
 * Labels saved to: ~/biz/shipping-labels/
 */

import { chromium, Browser, Page, BrowserContext, Download } from "playwright";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const SESSION_PATH = "/tmp/royalmail-session.json";
const SCREENSHOT_DIR = "/home/USER/biz/.playwright-mcp";
const LABEL_DIR = "/home/USER/biz/shipping-labels";
const CONFIG_PATH = join(__dirname, "..", "config.json");

// Royal Mail URLs
const ROYALMAIL_LOGIN_URL = "https://business.parcel.royalmail.com/";
const ROYALMAIL_CREATE_ORDER_URL = "https://business.parcel.royalmail.com/orders/single/create";

// Default sender values (YOUR_COMPANY warehouse)
const SENDER_DEFAULTS = {
  company: "YOUR_COMPANY",
  address1: "YOUR_WAREHOUSE_ADDRESS_LINE_1",
  address2: "YOUR_WAREHOUSE_ADDRESS_LINE_2",
  city: "YOUR_CITY",
  postcode: "YOUR_POSTCODE",
  phone: "YOUR_PHONE_NUMBER",
  email: "YOUR_LOGISTICS_EMAIL",
};

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
}

interface Config {
  royalmail: {
    username: string;
    password: string;
  };
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

export class RoyalMailClient {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor() {
    this.config = this.loadConfig();
    // Ensure directories exist
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

  private loadConfig(): Config {
    if (!existsSync(CONFIG_PATH)) {
      throw new Error(`Config file not found at ${CONFIG_PATH}`);
    }
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }

  private async ensureBrowser(): Promise<Page> {
    // Try to reconnect to existing session
    if (existsSync(SESSION_PATH)) {
      try {
        const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
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
      } catch {
        // Session invalid, clean up
        try {
          unlinkSync(SESSION_PATH);
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Launch new browser with remote debugging
    this.browser = await chromium.launch({
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      acceptDownloads: true,
    });
    this.page = await this.context.newPage();

    // Save session for reconnection
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
    const page = await this.ensureBrowser();

    // Check if already logged in
    if (existsSync(SESSION_PATH)) {
      const session: SessionInfo = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
      if (session.loggedIn) {
        // Verify still logged in by checking page
        try {
          await page.goto(ROYALMAIL_CREATE_ORDER_URL, { waitUntil: "networkidle", timeout: 30000 });
          // If we're not redirected to login, we're still logged in
          if (!page.url().includes("login") && !page.url().includes("signin")) {
            return true;
          }
        } catch {
          // Continue to login
        }
      }
    }

    // Navigate to login page
    await page.goto(ROYALMAIL_LOGIN_URL, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Take screenshot to see what we're working with
    const loginScreenshot = `${SCREENSHOT_DIR}/royalmail-login-${Date.now()}.png`;
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    // Try to find and fill login form
    // Royal Mail Click & Drop uses various login patterns
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="email" i]',
      'input[name="username"]',
      '#username',
      '#email',
    ];

    let emailFilled = false;
    for (const selector of emailSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(this.config.royalmail.username);
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
      '#password',
    ];

    let passwordFilled = false;
    for (const selector of passwordSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          await field.fill(this.config.royalmail.password);
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

    // Click login button
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
        const button = await page.$(selector);
        if (button) {
          await button.click();
          break;
        }
      } catch {
        continue;
      }
    }

    // Wait for navigation after login
    try {
      await Promise.race([
        page.waitForURL(/orders|dashboard|home/i, { timeout: 30000 }),
        page.waitForSelector('[aria-label*="account"]', { timeout: 30000 }),
        page.waitForSelector('.user-menu, .account-menu, [data-testid="user-menu"]', { timeout: 30000 }),
      ]);
    } catch {
      // Check if we're still on login page (login failed)
      if (page.url().includes("login") || page.url().includes("signin")) {
        const errorScreenshot = `${SCREENSHOT_DIR}/royalmail-login-failed-${Date.now()}.png`;
        await page.screenshot({ path: errorScreenshot, fullPage: true });
        throw new Error(`Login failed. Check credentials. See screenshot: ${errorScreenshot}`);
      }
    }

    // Additional wait for page to stabilize
    await page.waitForTimeout(2000);

    this.updateSession({ loggedIn: true });
    return true;
  }

  // ============================================
  // LABEL OPERATIONS
  // ============================================

  /**
   * Creates a shipping label by filling the Click & Drop form.
   *
   * Logs in if needed and fills all recipient and package details.
   * Does not submit - use submit() after reviewing the screenshot.
   *
   * @param options - Label details
   * @param options.name - Recipient full name (required)
   * @param options.company - Recipient company name
   * @param options.address1 - Address line 1 (required)
   * @param options.address2 - Address line 2
   * @param options.city - City/town (required)
   * @param options.postcode - UK postcode (required)
   * @param options.email - Recipient email for notifications
   * @param options.phone - Recipient phone number
   * @param options.weight - Package weight in grams (required)
   * @param options.length - Package length in cm
   * @param options.width - Package width in cm
   * @param options.height - Package height in cm
   * @param options.service - Service code (e.g., "TRACKED24", "SPECIALDELIVERY1")
   * @param options.reference - Your reference (e.g., order number)
   * @param options.contents - Package contents description
   * @returns Result with screenshot and form state
   */
  async createLabel(options: CreateLabelOptions): Promise<Result> {
    const page = await this.ensureBrowser();

    try {
      // Login first
      await this.login();

      // Navigate to create order page
      await page.goto(ROYALMAIL_CREATE_ORDER_URL, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(2000);

      // Take initial screenshot
      const initialScreenshot = `${SCREENSHOT_DIR}/royalmail-form-initial-${Date.now()}.png`;
      await page.screenshot({ path: initialScreenshot, fullPage: true });

      // Fill recipient details
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

      // Fill package details
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

      // Select service
      await this.selectService(page, options.service);

      // Fill reference if provided
      if (options.reference) {
        await this.fillField(page, ["Reference", "Order reference", "Customer reference", "Your reference", "reference"], options.reference);
      }

      // Fill contents description if provided
      if (options.contents) {
        await this.fillField(page, ["Contents", "Package contents", "Description", "Item description", "contents"], options.contents);
      }

      // Take preview screenshot
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
        // Try by aria-label
        let field = await page.$(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by placeholder
        field = await page.$(`input[placeholder*="${label}" i], textarea[placeholder*="${label}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by label text
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
          // Try sibling/child input
          field = await labelEl.$("xpath=following-sibling::input | following-sibling::textarea | ../input | ../textarea | .//input | .//textarea");
          if (field) {
            await field.fill(value);
            return;
          }
        }

        // Try by name attribute
        const nameVariant = label.toLowerCase().replace(/\s+/g, "");
        field = await page.$(`input[name*="${nameVariant}" i], textarea[name*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by id
        field = await page.$(`input[id*="${nameVariant}" i], textarea[id*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }

        // Try by data-testid
        field = await page.$(`input[data-testid*="${nameVariant}" i], textarea[data-testid*="${nameVariant}" i]`);
        if (field) {
          await field.fill(value);
          return;
        }
      } catch {
        // Continue to next variant
      }
    }
    // Field not found - not throwing to allow partial form fills
    // The form may have different field names depending on the context
  }

  private async selectService(page: Page, serviceCode: string): Promise<void> {
    const serviceName = SERVICE_CODES[serviceCode] || serviceCode;

    // Try various selection methods

    // Method 1: Select dropdown
    const selectSelectors = [
      'select[name*="service" i]',
      'select[id*="service" i]',
      'select[aria-label*="service" i]',
      '#serviceType',
      '#service',
    ];

    for (const selector of selectSelectors) {
      try {
        const select = await page.$(selector);
        if (select) {
          // Try by value first, then by label
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

    // Method 2: Radio buttons
    try {
      const radio = await page.$(`input[type="radio"][value*="${serviceCode}" i], input[type="radio"][value*="${serviceName}" i]`);
      if (radio) {
        await radio.click();
        return;
      }
    } catch {
      // Continue
    }

    // Method 3: Clickable service cards/tiles
    try {
      const tile = await page.$(`[data-service="${serviceCode}"], [data-value="${serviceCode}"], .service-tile:has-text("${serviceName}")`);
      if (tile) {
        await tile.click();
        return;
      }
    } catch {
      // Continue
    }

    // Method 4: Label containing service name (for custom controls)
    try {
      const label = await page.$(`label:has-text("${serviceName}"), div:has-text("${serviceName}"):not(:has(div))`);
      if (label) {
        await label.click();
        return;
      }
    } catch {
      // Continue
    }
  }

  /**
   * Submits the label form and completes payment.
   *
   * Must be called after createLabel(). Navigates through confirmation
   * steps and extracts tracking number and cost.
   *
   * @returns Result with tracking number, cost, and screenshot
   * @throws {Error} If form has not been filled yet
   */
  async submit(): Promise<Result> {
    const page = await this.ensureBrowser();

    // Check if form was filled
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
      // Look for submit/next/continue buttons
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

      // Wait for processing
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3000);

      // Take screenshot of result
      const reviewScreenshot = `${SCREENSHOT_DIR}/royalmail-review-${Date.now()}.png`;
      await page.screenshot({ path: reviewScreenshot, fullPage: true });

      // Check if we need to confirm on a review page
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

      // Take confirmation screenshot
      const confirmationScreenshot = `${SCREENSHOT_DIR}/royalmail-confirmation-${Date.now()}.png`;
      await page.screenshot({ path: confirmationScreenshot, fullPage: true });

      // Try to extract tracking number and cost
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

        // Try to find tracking number
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

        // Try to find cost
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

  /**
   * Downloads the generated label PDF.
   *
   * Must be called after successful submit(). Saves the PDF to
   * ~/biz/shipping-labels/ with the tracking number as filename.
   *
   * @returns Result with label path and tracking number
   * @throws {Error} If label has not been generated yet
   */
  async downloadLabel(): Promise<Result> {
    const page = await this.ensureBrowser();

    // Check if label was generated
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
      // Look for download/print button
      const downloadSelectors = [
        'button:has-text("Download")',
        'button:has-text("Print")',
        'button:has-text("Get label")',
        'a:has-text("Download")',
        'a:has-text("Print label")',
        '[data-testid="download-label"]',
        '.download-label',
      ];

      // Set up download handler
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

      // Wait for download
      const download: Download = await downloadPromise;

      // Get suggested filename and tracking number
      const suggestedFilename = download.suggestedFilename();

      // Extract tracking number from filename or use timestamp
      let trackingNumber = suggestedFilename.match(/([A-Z]{2}\d{9}GB)/)?.[1];
      if (!trackingNumber) {
        trackingNumber = `label-${Date.now()}`;
      }

      // Save to labels directory
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

  // ============================================
  // SERVICE INFORMATION
  // ============================================

  /**
   * Lists available Royal Mail shipping services.
   *
   * @returns Array of service codes, names, and descriptions
   */
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

  /**
   * Takes a screenshot of the current browser state.
   *
   * @param options - Screenshot options
   * @param options.filename - Custom filename (default: timestamped)
   * @param options.fullPage - Capture full scrollable page (default: false)
   * @returns Result with screenshot path
   */
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

  /**
   * Closes browser session and clears saved state.
   *
   * Call this to start fresh or after completing a label.
   *
   * @returns Success/error result
   */
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
