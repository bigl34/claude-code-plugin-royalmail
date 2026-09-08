import { loadPassCredentials } from "@local/cli-utils";

import type { RoyalMailPackageFormat } from "./royalmail-domain.js";

const API_BASE_URL = "https://api.parcel.royalmail.com/api/v1";
const MIN_REQUEST_INTERVAL_MS = 500;

export interface RoyalMailApiOrder {
  orderIdentifier: number;
  orderReference?: string;
  createdOn: string;
  orderDate?: string;
  printedOn?: string;
  manifestedOn?: string;
  shippedOn?: string;
  trackingNumber?: string;
  packages?: Array<{ packageNumber?: number; trackingNumber?: string }>;
}

export interface RoyalMailDomesticDraft {
  orderReference: string;
  orderDate: string;
  recipient: {
    fullName: string;
    companyName?: string;
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    county?: string;
    postcode: string;
    countryCode: "GB";
    emailAddress?: string;
    phoneNumber?: string;
  };
  package: {
    format: RoyalMailPackageFormat;
    weightGrams: number;
    lengthMm: number;
    widthMm: number;
    heightMm: number;
    contents: string;
  };
}

export type RoyalMailOrderMatch =
  | { kind: "none" }
  | { kind: "unique"; order: RoyalMailApiOrder }
  | { kind: "conflict"; orders: RoyalMailApiOrder[] };

interface RoyalMailApiClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function normalizedOrderReference(value: string | undefined): string {
  return (value ?? "").trim().replace(/^#+/, "").replace(/\s+/g, "").toUpperCase();
}

function isOpenOrder(order: RoyalMailApiOrder): boolean {
  return !order.printedOn
    && !order.manifestedOn
    && !order.shippedOn
    && !order.trackingNumber
    && !(order.packages ?? []).some((parcel) => parcel.trackingNumber);
}

export function findUniqueOpenRoyalMailOrder(
  orders: RoyalMailApiOrder[],
  orderReference: string,
): RoyalMailOrderMatch {
  const target = normalizedOrderReference(orderReference);
  const matching = orders.filter(
    (order) => isOpenOrder(order) && normalizedOrderReference(order.orderReference) === target,
  );

  if (matching.length === 0) {
    return { kind: "none" };
  }
  if (matching.length === 1) {
    return { kind: "unique", order: matching[0] };
  }
  return { kind: "conflict", orders: matching };
}

export class RoyalMailApiClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(options: RoyalMailApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? this.resolveApiKey();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private resolveApiKey(): string {
    const credentials = loadPassCredentials({
      prefix: "your-secret-store/royalmail",
      keys: ["api-key"],
    });
    const apiKey = credentials["api-key"]?.trim();
    if (!apiKey) {
      throw new Error("Royal Mail API key is unavailable in pass at your-secret-store/royalmail/api-key");
    }
    return apiKey;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const remainingDelay = MIN_REQUEST_INTERVAL_MS - (this.now() - this.lastRequestAt);
    if (this.lastRequestAt > 0 && remainingDelay > 0) {
      await this.sleep(remainingDelay);
    }

    const response = await this.fetchImpl(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    this.lastRequestAt = this.now();

    const responseText = await response.text();
    let body: unknown = undefined;
    if (responseText) {
      try {
        body = JSON.parse(responseText);
      } catch {
        body = responseText;
      }
    }

    if (!response.ok) {
      const safeBody = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body);
      throw new Error(`Royal Mail API ${response.status} for ${path}: ${safeBody}`);
    }

    return body as T;
  }

  async preflight(): Promise<unknown> {
    return this.request("/version");
  }

  async listRecentOrders(options: {
    startDateTime: string;
    endDateTime: string;
    pageSize?: number;
    maxPages?: number;
  }): Promise<RoyalMailApiOrder[]> {
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 3;
    const orders: RoyalMailApiOrder[] = [];
    let continuationToken: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({
        pageSize: String(pageSize),
        startDateTime: options.startDateTime,
        endDateTime: options.endDateTime,
      });
      if (continuationToken) {
        query.set("continuationToken", continuationToken);
      }

      const result = await this.request<{
        orders?: RoyalMailApiOrder[];
        continuationToken?: string;
      }>(`/orders?${query.toString()}`);
      orders.push(...(result.orders ?? []));
      continuationToken = result.continuationToken;
      if (!continuationToken) {
        break;
      }
    }

    return orders;
  }

  async getOrders(orderIdentifiers: number[]): Promise<RoyalMailApiOrder[]> {
    if (orderIdentifiers.length === 0) {
      return [];
    }
    return this.request(`/orders/${orderIdentifiers.join(";")}`);
  }

  async createDomesticDraft(input: RoyalMailDomesticDraft): Promise<RoyalMailApiOrder> {
    const {
      emailAddress,
      phoneNumber,
      ...address
    } = input.recipient;
    const result = await this.request<{
      createdOrders?: RoyalMailApiOrder[];
      failedOrders?: Array<{ errors?: Array<{ errorCode?: number; errorMessage?: string }> }>;
    }>("/orders", {
      method: "POST",
      body: JSON.stringify({
        items: [{
          orderReference: input.orderReference,
          recipient: {
            address,
            ...(phoneNumber ? { phoneNumber } : {}),
            ...(emailAddress ? { emailAddress } : {}),
          },
          billing: {
            address,
          },
          orderDate: input.orderDate,
          subtotal: 0,
          shippingCostCharged: 0,
          total: 0,
          currencyCode: "GBP",
          packages: [{
            weightInGrams: input.package.weightGrams,
            packageFormatIdentifier: input.package.format,
            dimensions: {
              depthInMms: input.package.lengthMm,
              widthInMms: input.package.widthMm,
              heightInMms: input.package.heightMm,
            },
          }],
          specialInstructions: input.package.contents.slice(0, 500),
        }],
      }),
    });

    if (result.createdOrders?.length === 1 && !result.failedOrders?.length) {
      return result.createdOrders[0];
    }

    const messages = (result.failedOrders ?? [])
      .flatMap((failed) => failed.errors ?? [])
      .map((error) => error.errorMessage ?? `Royal Mail error ${error.errorCode ?? "unknown"}`)
      .join("; ");
    throw new Error(`Royal Mail draft creation failed${messages ? `: ${messages}` : ""}`);
  }

  async deleteBotDraft(orderIdentifier: number): Promise<void> {
    await this.request(`/orders/${orderIdentifier}`, { method: "DELETE" });
  }
}
