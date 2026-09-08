import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadPassCredentials } from "@local/cli-utils";
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";

import type {
  RoyalMailPortalPayment,
  RoyalMailPurchasePortal,
} from "./purchase-flow.js";
import type { RoyalMailServiceKey } from "./royalmail-domain.js";

const LOGIN_URL = "https://business.parcel.royalmail.com/";
const ORDERS_URL = "https://business.parcel.royalmail.com/orders/";

function normalizedIdentity(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function normalizedReference(value: string): string {
  return normalizedIdentity(value.replace(/^#+/, ""));
}

function containsDelimitedNumber(value: string, expected: number): boolean {
  return value.split(/\D+/).includes(String(expected));
}

export function parseGbpMinor(text: string): number {
  const match = text.match(/£\s*([\d,]+)(?:\.(\d{2}))?/);
  if (!match) {
    throw new Error("Click & Drop did not expose a GBP amount");
  }
  const pounds = Number(match[1].replace(/,/g, ""));
  const pence = Number(match[2] ?? "00");
  const minor = (pounds * 100) + pence;
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("Click & Drop exposed an invalid GBP amount");
  }
  return minor;
}

export function parsePaymentReference(text: string): string | undefined {
  const patterns = [
    /(?:payment|transaction|confirmation)\s+(?:reference|id)\s*[:#]?\s*([A-Z0-9-]{5,})/i,
    /(?:payment|transaction|confirmation)\s*[:#]\s*([A-Z0-9-]{5,})/i,
  ];
  for (const pattern of patterns) {
    const reference = text.match(pattern)?.[1];
    if (reference && /\d/.test(reference)) {
      return reference;
    }
  }
  return undefined;
}

function parseLastGbpMinor(text: string): number {
  const matches = [...text.matchAll(/£\s*([\d,]+)(?:\.(\d{2}))?/g)];
  const last = matches.at(-1);
  if (!last) {
    throw new Error("Click & Drop service row did not expose a GBP amount");
  }
  return parseGbpMinor(last[0]);
}

export function recipientIdentityMatches(
  text: string,
  fullName: string,
  postcode: string,
): boolean {
  const normalized = normalizedIdentity(text);
  return normalized.includes(normalizedIdentity(fullName))
    && normalized.includes(normalizedIdentity(postcode));
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function clickRequired(page: Page, selectors: string[], description: string): Promise<void> {
  const locator = await firstVisible(selectors.map((selector) => page.locator(selector)));
  if (!locator) {
    throw new Error(`Click & Drop ${description} control was not found`);
  }
  await locator.click({ timeout: 15_000 });
}

async function fillIfPresent(
  page: Page,
  selectors: string[],
  value: string,
): Promise<boolean> {
  const locator = await firstVisible(selectors.map((selector) => page.locator(selector)));
  if (!locator) {
    return false;
  }
  await locator.fill(value);
  return true;
}

async function waitForFrame(
  page: Page,
  predicate: (frame: Frame) => Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await predicate(frame)) {
        return frame;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Click & Drop ${description} was not found`);
}

export class RoyalMailClickDropPortal implements RoyalMailPurchasePortal {
  private readonly stateDir: string;
  private readonly headed: boolean;
  private readonly resolveCardCvv: () => string;
  private readonly resolveClickToPayOtp?: () => string | Promise<string>;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(options: {
    stateDir: string;
    headed?: boolean;
    resolveCardCvv?: () => string;
    resolveClickToPayOtp?: () => string | Promise<string>;
  }) {
    this.stateDir = options.stateDir;
    this.headed = options.headed ?? false;
    this.resolveCardCvv = options.resolveCardCvv ?? (() => {
      const credentials = loadPassCredentials({
        prefix: "your-secret-store/royalmail",
        keys: ["card-cvv"],
      });
      const cardCvv = credentials["card-cvv"] ?? "";
      if (!/^\d{3,4}$/.test(cardCvv)) {
        throw new Error("Royal Mail saved-card security code is invalid");
      }
      return cardCvv;
    });
    this.resolveClickToPayOtp = options.resolveClickToPayOtp;
  }

  private credentials(): { username: string; password: string } {
    const credentials = loadPassCredentials({
      prefix: "your-secret-store/royalmail",
      keys: ["username", "password"],
    });
    if (!credentials.username || !credentials.password) {
      throw new Error("Royal Mail browser credentials are unavailable in pass");
    }
    return {
      username: credentials.username,
      password: credentials.password,
    };
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) {
      return this.page;
    }
    const profileDir = join(this.stateDir, "browser-profile");
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: !this.headed,
      ...(this.headed
        ? {
            channel: "chrome",
            ignoreDefaultArgs: ["--enable-automation"],
            args: ["--disable-blink-features=AutomationControlled"],
          }
        : {}),
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    return this.page;
  }

  private async dismissCookies(page: Page): Promise<void> {
    const candidates = [
      page.locator("#consent_prompt_decline"),
      page.locator("#consent_prompt_submit"),
      page.locator("#onetrust-accept-btn-handler"),
      page.getByRole("button", { name: /accept all/i }),
      page.getByRole("button", { name: /reject all/i }),
    ];
    await Promise.race([
      ...candidates.map((candidate) => candidate.first().waitFor({
        state: "visible",
        timeout: 4_000,
      })),
      page.waitForTimeout(4_000),
    ]).catch(() => undefined);
    const button = await firstVisible(candidates);
    await button?.click({ timeout: 3_000 }).catch(() => undefined);
  }

  private async login(): Promise<Page> {
    const page = await this.ensurePage();
    await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.dismissCookies(page);

    const email = await firstVisible([
      page.locator('input[type="email"]'),
      page.locator('input[name*="email" i]'),
      page.locator('input[name*="username" i]'),
    ]);
    if (!page.url().match(/login|signin/i) && !email) {
      return page;
    }

    const credentials = this.credentials();
    if (!email) {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    const emailField = email ?? await firstVisible([
      page.locator('input[type="email"]'),
      page.locator('input[name*="email" i]'),
      page.locator('input[name*="username" i]'),
    ]);
    const passwordField = await firstVisible([
      page.locator('input[type="password"]'),
      page.locator('input[name*="password" i]'),
    ]);
    if (!emailField || !passwordField) {
      throw new Error("Click & Drop login fields were not found");
    }
    await emailField.fill(credentials.username);
    await passwordField.fill(credentials.password);
    await clickRequired(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
    ], "login");
    const loginOutcome = await Promise.race([
      page.waitForURL((url) => !/login|signin/i.test(url.toString()), {
        timeout: 45_000,
      }).then(() => "navigated" as const),
      page.getByText(/unable to login/i).first().waitFor({
        state: "visible",
        timeout: 45_000,
      }).then(() => "rejected" as const),
    ]).catch(async (error) => {
      if (await page.getByText(/unable to login/i).first().isVisible().catch(() => false)) {
        return "rejected" as const;
      }
      throw error;
    });
    if (loginOutcome === "rejected") {
      throw new Error(
        "Click & Drop login failed; verify your-secret-store/royalmail username/password in pass before retrying",
      );
    }
    await page.goto(ORDERS_URL, { waitUntil: "networkidle", timeout: 45_000 });
    const remainingLoginField = await firstVisible([
      page.locator('input[type="email"]'),
      page.locator('input[name*="email" i]'),
      page.locator('input[name*="username" i]'),
    ]);
    if (/login|signin/i.test(page.url()) || remainingLoginField) {
      throw new Error(
        "Click & Drop login failed; verify your-secret-store/royalmail username/password in pass before retrying",
      );
    }
    return page;
  }

  private async locateUniqueOrderRow(
    providerOrderId: number,
    providerOrderReference: string,
  ): Promise<Locator> {
    const page = await this.login();
    if (!/\/orders/i.test(page.url())) {
      await page.goto(ORDERS_URL, { waitUntil: "networkidle", timeout: 45_000 });
    }
    const orderGridSearch = await firstVisible([
      page.locator('input[placeholder*="search orders" i]:not([placeholder*="pages" i]):not([placeholder*="actions" i])'),
      page.locator('input[aria-label*="search orders" i]'),
      page.locator('input[name*="order" i][name*="search" i]'),
    ]);
    if (orderGridSearch) {
      await orderGridSearch.fill(providerOrderReference || String(providerOrderId));
      await orderGridSearch.press("Enter").catch(() => undefined);
      await page.waitForTimeout(1_500);
    }

    const candidateSelectors = [
      "table tbody tr",
      '[role="row"]',
      '[data-testid*="order-row"]',
    ];
    const exactReference = normalizedReference(providerOrderReference);
    const exactId = String(providerOrderId);
    const matches: Locator[] = [];
    for (const selector of candidateSelectors) {
      const rows = page.locator(selector);
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        if (!(await row.isVisible().catch(() => false))) {
          continue;
        }
        const text = await row.innerText().catch(() => "");
        const normalized = normalizedReference(text);
        if (
          (exactReference && normalized.includes(exactReference))
          || normalized.includes(exactId)
        ) {
          matches.push(row);
        }
      }
      if (matches.length > 0) {
        break;
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `Click & Drop order search returned ${matches.length} rows for ${providerOrderReference}`,
      );
    }
    return matches[0];
  }

  async verifyOrderRecipient(input: {
    providerOrderId: number;
    providerOrderReference: string;
    fullName: string;
    postcode: string;
  }): Promise<boolean> {
    const row = await this.locateUniqueOrderRow(
      input.providerOrderId,
      input.providerOrderReference,
    );
    const rowText = await row.innerText();
    if (recipientIdentityMatches(rowText, input.fullName, input.postcode)) {
      return true;
    }

    const detailsLink = await firstVisible([
      row.locator('a[href*="/orders/"]'),
      row.getByRole("link", { name: new RegExp(input.providerOrderReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }),
    ]);
    if (!detailsLink) {
      return false;
    }
    await detailsLink.click();
    const page = await this.ensurePage();
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
    return recipientIdentityMatches(
      await page.locator("body").innerText(),
      input.fullName,
      input.postcode,
    );
  }

  private async selectPackageFormat(page: Page, format: string): Promise<void> {
    const labelByFormat: Record<string, string> = {
      letter: "Letter",
      largeLetter: "Large Letter",
      smallParcel: "Small Parcel",
      mediumParcel: "Medium Parcel",
    };
    const label = labelByFormat[format];
    const select = await firstVisible([
      page.locator('select[name*="package" i]'),
      page.locator('select[id*="package" i]'),
      page.locator('select[aria-label*="format" i]'),
    ]);
    if (select) {
      try {
        await select.selectOption({ value: format });
      } catch {
        await select.selectOption({ label });
      }
      return;
    }
    const stableOption = page.locator(`#${label.replace(/\s+/g, "")}`).first();
    if (await stableOption.count()) {
      await stableOption.waitFor({
        state: "visible",
        timeout: 10_000,
      }).catch(() => undefined);
    }
    if (await stableOption.isVisible().catch(() => false)) {
      if (await stableOption.isChecked().catch(() => false)) {
        return;
      }
      if (await stableOption.isDisabled().catch(() => false)) {
        throw new Error(`Click & Drop package format ${label} is unavailable`);
      }
      await stableOption.click();
      return;
    }
    const option = await firstVisible([
      page.getByRole("radio", { name: new RegExp(`^${label}$`, "i") }),
      page.getByText(label, { exact: true }),
    ]);
    if (!option) {
      throw new Error(`Click & Drop package format ${label} is unavailable`);
    }
    await option.click();
  }

  private async selectService(
    page: Page,
    serviceDisplayName: string,
    serviceKey: string,
  ): Promise<number> {
    const currentRows = page.locator("tr").filter({
      hasText: serviceDisplayName,
    }).filter({
      has: page.locator('input[id^="findaservice_"]'),
    });
    const visibleCurrentRows: Locator[] = [];
    for (let index = 0; index < await currentRows.count(); index += 1) {
      const row = currentRows.nth(index);
      if (await row.isVisible().catch(() => false)) {
        visibleCurrentRows.push(row);
      }
    }
    if (visibleCurrentRows.length > 1) {
      throw new Error(`Click & Drop exposed multiple rows for service ${serviceDisplayName}`);
    }
    if (visibleCurrentRows.length === 1) {
      const row = visibleCurrentRows[0];
      await row.locator("td").first().click();
      const serviceCheckbox = row.locator('input[id^="findaservice_"]').first();
      if (!(await serviceCheckbox.isChecked().catch(() => false))) {
        throw new Error(`Click & Drop did not select service ${serviceDisplayName}`);
      }
      const grossMinor = parseLastGbpMinor(await row.innerText());

      if (serviceKey === "tracked24_signature") {
        const signature = await firstVisible([
          page.getByRole("checkbox", { name: /signature/i }),
          page.locator('input[type="checkbox"][name*="signature" i]'),
          page.locator("#requestSignature"),
        ]);
        if (!signature || await signature.isDisabled()) {
          throw new Error("Click & Drop signature option is unavailable for Tracked 24");
        }
        if (!(await signature.isChecked())) {
          await signature.check({ force: true });
        }
      }
      return grossMinor;
    }

    const exact = new RegExp(`^${serviceDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const option = await firstVisible([
      page.getByRole("radio", { name: exact }),
      page.getByRole("button", { name: exact }),
      page.getByText(serviceDisplayName, { exact: true }),
    ]);
    if (!option) {
      throw new Error(`Click & Drop service ${serviceDisplayName} is unavailable for this package`);
    }
    await option.click();

    if (serviceKey === "tracked24_signature") {
      const signature = await firstVisible([
        page.getByRole("checkbox", { name: /signature/i }),
        page.locator('input[type="checkbox"][name*="signature" i]'),
      ]);
      if (!signature) {
        throw new Error("Click & Drop signature option is unavailable for Tracked 24");
      }
      if (!(await signature.isChecked())) {
        await signature.check();
      }
    }
    return 0;
  }

  private async openApplyPostageEditor(page: Page): Promise<void> {
    const currentActions = await firstVisible([
      page.locator("#openorders-actions"),
      page.getByRole("button", { name: /^apply postage$/i }),
    ]);
    if (currentActions) {
      await currentActions.click();
      const applyPostage = await firstVisible([
        page.locator('#applypostage[role="menuitem"]'),
        page.getByRole("menuitem", { name: /^apply postage$/i }),
      ]);
      const go = await firstVisible([
        page.getByRole("button", { name: /^go$/i }),
      ]);
      if (applyPostage && go) {
        await applyPostage.click();
        await go.click();
        await page.locator("#packageWeight").waitFor({
          state: "visible",
          timeout: 30_000,
        });
        return;
      }
    }

    await clickRequired(page, [
      'button:has-text("Apply postage")',
      'button:has-text("Buy postage")',
      'button:has-text("Apply Postage")',
    ], "apply postage");
  }

  private async applyPostageWithoutPayment(page: Page): Promise<void> {
    const safeApply = await firstVisible([
      page.locator('button[automated-test-id="apply-postage-button"]'),
      page.getByRole("button", { name: /^apply$/i }),
      page.getByRole("button", { name: /^add to basket$/i }),
    ]);
    if (!safeApply) {
      throw new Error("Click & Drop non-payment Apply control was not found");
    }
    await safeApply.click();
  }

  private async clickPayAndGenerate(row: Locator): Promise<void> {
    const payment = await firstVisible([
      row.getByRole("button", { name: /^pay\s*(?:&|and)\s*generate labels$/i }),
      row.getByRole("link", { name: /^pay\s*(?:&|and)\s*generate labels$/i }),
      row.locator('button:has-text("Pay & generate labels")'),
    ]);
    if (!payment) {
      throw new Error("Click & Drop intended order does not expose Pay & generate labels");
    }
    await payment.click();
  }

  private async confirmProviderGoodsAttestation(
    page: Page,
    noProhibitedOrRestrictedGoods: boolean,
  ): Promise<void> {
    if (noProhibitedOrRestrictedGoods !== true) {
      throw new Error(
        "Click & Drop prohibited/restricted/dangerous-goods attestation requires an explicit operator assertion",
      );
    }
    const providerAttestation = await firstVisible([
      page.getByRole("checkbox", { name: /prohibited|restricted|dangerous goods/i }),
      page.locator('input[type="checkbox"][name*="danger" i]'),
      page.locator('input[type="checkbox"][name*="prohibited" i]'),
    ]);
    if (providerAttestation && !(await providerAttestation.isChecked())) {
      await providerAttestation.check();
    }
  }

  private async checkoutTotal(page: Page): Promise<number> {
    const totalLabel = await firstVisible([
      page.getByText(/^(order\s+)?total/i),
      page.locator('[data-testid*="total" i]'),
      page.locator('[class*="total" i]'),
    ]);
    if (!totalLabel) {
      throw new Error("Click & Drop checkout total was not found");
    }
    const containerText = await totalLabel.locator("xpath=..").innerText().catch(
      () => totalLabel.innerText(),
    );
    return parseGbpMinor(containerText);
  }

  private async clickFinalPaymentIfTokenized(
    page: Page,
    input: {
      providerOrderId: number;
      providerOrderReference: string;
      expectedGrossMinor: number;
    },
  ): Promise<void> {
    const bodyText = await page.locator("body").innerText();
    const normalizedOrderReference = normalizedReference(input.providerOrderReference);
    if (!normalizedOrderReference) {
      throw new Error("Click & Drop payment requires a non-empty provider reference");
    }
    if (!containsDelimitedNumber(bodyText, input.providerOrderId)) {
      throw new Error("Click & Drop payment page is not bound to the intended order");
    }

    const displayedGrossMinor = await this.checkoutTotal(page);
    if (displayedGrossMinor !== input.expectedGrossMinor) {
      throw new Error(
        `Click & Drop payment page exposed a different total: expected ${input.expectedGrossMinor} minor units, received ${displayedGrossMinor}`,
      );
    }

    const rawCardNumber = await firstVisible([
      page.locator('input[autocomplete="cc-number"]'),
      page.locator('input[name*="cardnumber" i]'),
      page.locator('input[id*="cardnumber" i]'),
    ]);
    const cardPaymentChoice = await firstVisible([
      page.getByRole("button", { name: /pay with debit or credit card/i }),
    ]);
    const unsupportedPaymentChoice = await firstVisible([
      page.getByRole("button", { name: /pay with paypal/i }),
      page.getByRole("button", { name: /buy with g pay/i }),
      page.getByRole("button", { name: /apple pay/i }),
    ]);
    const tokenizedPaymentMethod = await firstVisible([
      page.locator('[data-testid*="saved-payment" i]'),
      page.locator('[data-testid*="tokenized" i]'),
      page.getByText(/card\s+(?:ending|ending in)\s+\d{4}|saved payment method/i),
    ]);
    const finalPayment = await firstVisible([
      page.getByRole("button", { name: /^pay now$/i }),
      page.getByRole("button", { name: /^complete payment$/i }),
    ]);

    if (rawCardNumber) {
      throw new Error(
        "Click & Drop exposed full card entry; refusing unattended payment",
      );
    }
    if (tokenizedPaymentMethod && finalPayment) {
      await finalPayment.click();
      return;
    }
    if (!cardPaymentChoice) {
      if (unsupportedPaymentChoice) {
        throw new Error("Click & Drop saved-card payment method is unavailable");
      }
      throw new Error(
        "Click & Drop unattended payment method is unavailable; use supervised headed checkout or configure a tokenized account payment method",
      );
    }

    await cardPaymentChoice.click();
    const buttonListFrame = await waitForFrame(
      page,
      async (frame) => frame.getByRole("button", {
        name: /checkout with card/i,
      }).isVisible().catch(() => false),
      "Click to Pay card control",
    );
    const checkoutWithCard = buttonListFrame.getByRole("button", {
      name: /checkout with card/i,
    });
    if (await checkoutWithCard.count() !== 1) {
      throw new Error("Click & Drop Click to Pay card control is ambiguous");
    }
    await checkoutWithCard.click();

    let walletFrame = await waitForFrame(
      page,
      async (frame) => {
        const text = await frame.locator("body").innerText().catch(() => "");
        return /saved click to pay|found your saved cards|card ending|pay with selected card|verification code|code sent to|didn.t find any saved/i
          .test(text);
      },
      "Click to Pay wallet",
    );
    let walletText = await walletFrame.locator("body").innerText().catch(() => "");
    if (/verification code|code sent to|one-time code|enter.*code/i.test(walletText)) {
      if (!this.resolveClickToPayOtp) {
        throw new Error("Click & Drop payment requires interactive Click to Pay verification");
      }
      const otp = await this.resolveClickToPayOtp();
      if (!/^\d{6}$/.test(otp)) {
        throw new Error("Click & Drop Click to Pay verification code is invalid");
      }
      const codeInputs = walletFrame.locator(
        'input[autocomplete="one-time-code"], input[name*="code" i], input[inputmode="numeric"]',
      );
      const visibleCodeInputs: Locator[] = [];
      for (let index = 0; index < await codeInputs.count(); index += 1) {
        const candidate = codeInputs.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          visibleCodeInputs.push(candidate);
        }
      }
      if (visibleCodeInputs.length >= otp.length) {
        for (let index = 0; index < otp.length; index += 1) {
          await visibleCodeInputs[index].fill(otp[index]);
        }
      } else if (visibleCodeInputs.length === 1) {
        await visibleCodeInputs[0].fill(otp);
      } else {
        throw new Error("Click & Drop Click to Pay verification field is unavailable");
      }
      const rememberDevice = walletFrame.getByRole("checkbox", {
        name: /skip verification next time|remember/i,
      }).first();
      if (await rememberDevice.isVisible().catch(() => false)) {
        await rememberDevice.check();
      }
      const verify = await firstVisible([
        walletFrame.getByRole("button", {
          name: /confirm|continue|verify|submit/i,
        }),
      ]);
      if (!verify) {
        throw new Error("Click & Drop Click to Pay verification action is unavailable");
      }
      await verify.click();
      walletFrame = await waitForFrame(
        page,
        async (frame) => {
          const text = await frame.locator("body").innerText().catch(() => "");
          return /card ending|pay with selected card|didn.t find any saved/i.test(text);
        },
        "verified Click to Pay wallet",
      );
      walletText = await walletFrame.locator("body").innerText().catch(() => "");
    }
    if (/didn.t find any saved|no saved cards/i.test(walletText)) {
      throw new Error("Click & Drop saved Click to Pay card is unavailable");
    }

    const payWithSelectedCard = walletFrame.getByRole("button", {
      name: /^pay with selected card$/i,
    });
    if (await payWithSelectedCard.isVisible().catch(() => false)) {
      if (await payWithSelectedCard.count() !== 1) {
        throw new Error("Click & Drop selected-card action is ambiguous");
      }
      await payWithSelectedCard.click();
    }

    const reviewFrame = await waitForFrame(
      page,
      async (frame) => frame.getByRole("button", {
        name: /^confirm and continue$/i,
      }).isVisible().catch(() => false),
      "Click to Pay card review",
    );
    const confirmAndContinue = reviewFrame.getByRole("button", {
      name: /^confirm and continue$/i,
    });
    if (await confirmAndContinue.count() !== 1) {
      throw new Error("Click & Drop Click to Pay card review is ambiguous");
    }
    await confirmAndContinue.click();

    const securityCodeFrame = await waitForFrame(
      page,
      async (frame) => {
        const text = await frame.locator("body").innerText().catch(() => "");
        return /enter the security code/i.test(text);
      },
      "saved-card security-code prompt",
    );
    const fullCardNumber = await firstVisible([
      securityCodeFrame.locator('input[autocomplete="cc-number"]'),
      securityCodeFrame.locator('input[name*="cardnumber" i]'),
      securityCodeFrame.locator('input[id*="cardnumber" i]'),
    ]);
    if (fullCardNumber) {
      throw new Error("Click & Drop exposed full card entry; refusing unattended payment");
    }
    const securityCodeFields = securityCodeFrame.locator([
      'input[autocomplete="cc-csc"]',
      'input[name*="security" i]',
      'input[id*="security" i]',
      'input[aria-label*="security" i]',
      'input[placeholder*="security" i]',
      'input[name*="cvv" i]',
      'input[id*="cvv" i]',
    ].join(", "));
    const visibleSecurityCodeFields: Locator[] = [];
    for (let index = 0; index < await securityCodeFields.count(); index += 1) {
      const candidate = securityCodeFields.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleSecurityCodeFields.push(candidate);
      }
    }
    const confirmSecurityCodeCandidates = securityCodeFrame.getByRole("button", {
      name: /^confirm$/i,
    });
    const visibleConfirmSecurityCodeCandidates: Locator[] = [];
    for (
      let index = 0;
      index < await confirmSecurityCodeCandidates.count();
      index += 1
    ) {
      const candidate = confirmSecurityCodeCandidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleConfirmSecurityCodeCandidates.push(candidate);
      }
    }
    if (visibleSecurityCodeFields.length !== 1) {
      throw new Error("Click & Drop saved-card security-code field is ambiguous");
    }
    if (visibleConfirmSecurityCodeCandidates.length !== 1) {
      throw new Error("Click & Drop saved-card confirmation is ambiguous");
    }
    const securityCodeField = visibleSecurityCodeFields[0];
    const confirmSecurityCode = visibleConfirmSecurityCodeCandidates[0];
    let cardCvv = this.resolveCardCvv();
    if (!/^\d{3,4}$/.test(cardCvv)) {
      throw new Error("Royal Mail saved-card security code is invalid");
    }
    await securityCodeField.fill(cardCvv);
    cardCvv = "";

    if (
      !await confirmSecurityCode.isEnabled().catch(() => false)
    ) {
      throw new Error("Click & Drop saved-card confirmation is unavailable");
    }
    await confirmSecurityCode.click();
  }

  async prepareCheckout(input: {
    providerOrderId: number;
    providerOrderReference: string;
    serviceKey: RoyalMailServiceKey;
    serviceDisplayName: string;
    requestSignature: boolean;
    package: {
      format: string;
      weightGrams: number;
      lengthMm: number;
      widthMm: number;
      heightMm: number;
    };
    outputDir: string;
    headed: boolean;
  }): Promise<{ expectedGrossMinor: number }> {
    const page = await this.login();
    const row = await this.locateUniqueOrderRow(
      input.providerOrderId,
      input.providerOrderReference,
    );
    const checkboxes = page.locator('table tbody input[type="checkbox"], [role="row"] input[type="checkbox"]');
    const targetCheckbox = await firstVisible([
      row.locator('input[type="checkbox"]'),
      row.getByRole("checkbox"),
    ]);
    if (!targetCheckbox) {
      throw new Error("Click & Drop order selection control was not found");
    }
    for (let index = 0; index < await checkboxes.count(); index += 1) {
      const checkbox = checkboxes.nth(index);
      if (await checkbox.isChecked().catch(() => false)) {
        await checkbox.uncheck();
      }
    }
    await targetCheckbox.check();
    await this.openApplyPostageEditor(page);

    await this.selectPackageFormat(page, input.package.format);
    await fillIfPresent(page, [
      'input[name*="weight" i]',
      'input[aria-label*="weight" i]',
    ], String(input.package.weightGrams));
    await fillIfPresent(page, [
      'input[name*="length" i]',
      'input[aria-label*="length" i]',
    ], String(input.package.lengthMm));
    await fillIfPresent(page, [
      'input[name*="width" i]',
      'input[aria-label*="width" i]',
    ], String(input.package.widthMm));
    await fillIfPresent(page, [
      'input[name*="height" i]',
      'input[aria-label*="height" i]',
    ], String(input.package.heightMm));
    const expectedGrossMinor = await this.selectService(
      page,
      input.serviceDisplayName,
      input.serviceKey,
    );
    if (expectedGrossMinor <= 0) {
      throw new Error("Click & Drop selected service did not expose its gross total");
    }
    await this.applyPostageWithoutPayment(page);
    await page.waitForURL(/\/orders\/?$/i, { timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });

    const appliedRow = await this.locateUniqueOrderRow(
      input.providerOrderId,
      input.providerOrderReference,
    );
    const appliedText = await appliedRow.innerText();
    if (
      !normalizedReference(appliedText).includes(normalizedReference(input.serviceDisplayName))
      || !/postage applied/i.test(appliedText)
    ) {
      throw new Error("Click & Drop did not confirm postage on the intended provider order");
    }
    return { expectedGrossMinor };
  }

  async completePaymentAndDownload(input: {
    providerOrderId: number;
    providerOrderReference: string;
    expectedGrossMinor: number;
    outputDir: string;
    noProhibitedOrRestrictedGoods: true;
  }): Promise<RoyalMailPortalPayment> {
    if (input.noProhibitedOrRestrictedGoods !== true) {
      throw new Error(
        "Click & Drop payment requires an explicit operator assertion that the parcel contains no prohibited, restricted, or dangerous goods",
      );
    }
    const page = await this.ensurePage();
    const row = await this.locateUniqueOrderRow(
      input.providerOrderId,
      input.providerOrderReference,
    );
    await this.clickPayAndGenerate(row);
    await page.waitForTimeout(1_000);

    await this.confirmProviderGoodsAttestation(
      page,
      input.noProhibitedOrRestrictedGoods,
    );

    await this.clickFinalPaymentIfTokenized(page, input);

    await Promise.race([
      page.waitForURL(/confirm|success|label|processed/i, { timeout: 60_000 }),
      page.getByText(/payment successful|payment complete|thank you/i).first()
        .waitFor({ state: "visible", timeout: 60_000 }),
    ]).catch(() => {
      throw new Error("Click & Drop did not provide a post-payment success confirmation");
    });

    const bodyText = await page.locator("body").innerText();
    if (/captcha|3d secure|verification code|authenticate your payment/i.test(bodyText)) {
      throw new Error("Click & Drop payment requires interactive verification");
    }
    const normalizedBody = normalizedReference(bodyText);
    if (
      !normalizedBody.includes(normalizedReference(input.providerOrderReference))
      && !normalizedBody.includes(String(input.providerOrderId))
    ) {
      throw new Error("Click & Drop payment confirmation is not bound to the intended order");
    }
    const confirmedGrossMinor = await this.checkoutTotal(page);
    const paymentReference = parsePaymentReference(bodyText);
    const trackingNumber = bodyText.match(/\b([A-Z]{2}\d{9}GB)\b/i)?.[1]?.toUpperCase();

    mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
    chmodSync(input.outputDir, 0o700);
    const downloadButton = await firstVisible([
      page.getByRole("button", { name: /download.*label|print.*label|get.*label/i }),
      page.getByRole("link", { name: /download.*label|print.*label|get.*label/i }),
      page.locator('[data-testid*="download-label"]'),
    ]);
    if (!downloadButton) {
      throw new Error("Click & Drop paid confirmation did not expose a label download");
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    const pdfPath = join(input.outputDir, `royalmail-${input.providerOrderId}.pdf`);
    await download.saveAs(pdfPath);
    chmodSync(pdfPath, 0o600);

    return {
      confirmedGrossMinor,
      paymentReference,
      paidAt: new Date().toISOString(),
      trackingNumber,
      pdfPath,
    };
  }

  async recoverPaidLabel(input: {
    providerOrderId: number;
    providerOrderReference: string;
    expectedGrossMinor: number;
    outputDir: string;
  }): Promise<RoyalMailPortalPayment | null> {
    const row = await this.locateUniqueOrderRow(
      input.providerOrderId,
      input.providerOrderReference,
    );
    const rowText = await row.innerText();
    const outstandingPayment = await firstVisible([
      row.getByRole("button", { name: /^pay\s*(?:&|and)\s*generate labels$/i }),
      row.getByRole("link", { name: /^pay\s*(?:&|and)\s*generate labels$/i }),
      row.locator('button:has-text("Pay & generate labels")'),
    ]);
    const explicitlyUnpaid = /\bunpaid\b/i.test(rowText);
    const paidStatus = /\bpaid\b|\blabel generated\b|\bready to print\b|\bdespatched\b|\bdispatched\b/i
      .test(rowText);
    if (
      outstandingPayment
      || explicitlyUnpaid
      || !paidStatus
    ) {
      return null;
    }

    const page = await this.ensurePage();
    let recoveryScope: Locator;
    const batchDetails = await firstVisible([
      row.locator('a[href*="/batch-history/"]'),
    ]);
    if (batchDetails) {
      await batchDetails.click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
      const exactReference = normalizedReference(input.providerOrderReference);
      const batchRows = page.locator("table tbody tr, [role='row']");
      const matchingBatchRows: Locator[] = [];
      for (let index = 0; index < await batchRows.count(); index += 1) {
        const candidate = batchRows.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) {
          continue;
        }
        const candidateText = await candidate.innerText().catch(() => "");
        if (
          containsDelimitedNumber(candidateText, input.providerOrderId)
          || (
            exactReference
            && normalizedReference(candidateText).includes(exactReference)
          )
        ) {
          matchingBatchRows.push(candidate);
        }
      }
      if (matchingBatchRows.length !== 1) {
        throw new Error(
          "Click & Drop paid batch is not bound to exactly one intended order",
        );
      }
      recoveryScope = matchingBatchRows[0];
    } else {
      const details = await firstVisible([
        row.locator('a[href*="/orders/"]'),
        row.getByRole("link", { name: /view|details|order|label/i }),
        row.getByRole("button", { name: /view|details|order|label/i }),
      ]);
      if (details) {
        const priorUrl = page.url();
        await details.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
        recoveryScope = page.url() !== priorUrl
          ? page.locator("body")
          : row;
      } else {
        recoveryScope = row;
      }
    }

    const bodyText = await page.locator("body").innerText();
    const bindingText = await recoveryScope.innerText();
    const normalizedBody = normalizedReference(bindingText);
    if (
      !normalizedBody.includes(normalizedReference(input.providerOrderReference))
      && !containsDelimitedNumber(bindingText, input.providerOrderId)
    ) {
      throw new Error("Click & Drop recovery page is not bound to the intended order");
    }
    const expectedText = `£${(input.expectedGrossMinor / 100).toFixed(2)}`;
    const pageRepeatsCheckoutTotal = bodyText.replace(/\s+/g, "").includes(expectedText);
    const paidLabelStatusProven = /\bpaid\b/i.test(rowText)
      && /\blabel generated\b|\bready to print\b|\bdespatched\b|\bdispatched\b/i
        .test(rowText);
    if (!pageRepeatsCheckoutTotal && !paidLabelStatusProven) {
      throw new Error("Click & Drop recovery page does not prove the recorded checkout total");
    }

    const recoveryDownloadCandidates = [
      recoveryScope.getByRole("button", {
        name: /re-?generate labels|download.*label|print.*label|get.*label/i,
      }),
      recoveryScope.getByRole("link", {
        name: /re-?generate labels|download.*label|print.*label|get.*label/i,
      }),
      recoveryScope.locator('button:has-text("Re-generate labels")'),
      recoveryScope.locator('[data-testid*="download-label"]'),
    ];
    await Promise.race(
      recoveryDownloadCandidates.map((candidate) => candidate.first().waitFor({
        state: "visible",
        timeout: 5_000,
      })),
    ).catch(() => undefined);
    const downloadButton = await firstVisible(recoveryDownloadCandidates);
    if (!downloadButton) {
      throw new Error("Click & Drop paid order does not expose its existing label");
    }
    mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
    chmodSync(input.outputDir, 0o700);
    const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    const pdfPath = join(input.outputDir, `royalmail-${input.providerOrderId}.pdf`);
    await download.saveAs(pdfPath);
    chmodSync(pdfPath, 0o600);

    return {
      confirmedGrossMinor: input.expectedGrossMinor,
      paymentReference: parsePaymentReference(bodyText),
      paidAt: new Date().toISOString(),
      trackingNumber: bodyText.match(/\b([A-Z]{2}\d{9}GB)\b/i)?.[1]?.toUpperCase(),
      pdfPath,
    };
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
