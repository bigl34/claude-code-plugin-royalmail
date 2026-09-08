import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  findUniqueOpenRoyalMailOrder,
  type RoyalMailApiOrder,
  type RoyalMailDomesticDraft,
} from "./royalmail-api.js";
import {
  calculateRoyalMailCost,
  getRoyalMailService,
  type RoyalMailPackageFormat,
  type RoyalMailServiceKey,
  type RoyalMailTrackingKind,
} from "./royalmail-domain.js";
import type { RoyalMailLabelArtifact } from "./label-artifact.js";
import {
  type RoyalMailPurchaseEvent,
  type RoyalMailPurchaseJournal,
} from "./purchase-state.js";

export interface RoyalMailPurchaseInput {
  schemaVersion: "1.0";
  runId: string;
  orderNumber: string;
  orderReference: string;
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
  noProhibitedOrRestrictedGoods: true;
  serviceKey: RoyalMailServiceKey;
  headed?: boolean;
}

export interface RoyalMailPurchaseReceipt {
  schemaVersion: "1.0";
  carrier: "royalmail";
  runId: string;
  intentHash: string;
  providerOrderId: number;
  providerOrderReference: string;
  origin: "adopted" | "bot-created";
  serviceKey: RoyalMailServiceKey;
  serviceDisplayName: string;
  packageFormat: RoyalMailPackageFormat;
  expectedGrossMinor: number;
  confirmedGrossMinor: number;
  grossMinor: number;
  vatMinor: number;
  netMinor: number;
  cost: number;
  currency: "GBP";
  receiptId: string;
  trackingNumber?: string;
  trackingKind: RoyalMailTrackingKind;
  paymentReference?: string;
  paidAt: string;
  pdfPath: string;
  pdfSha256: string;
  pngPath: string;
  pngSha256: string;
}

export type RoyalMailPurchaseResult =
  | { success: true; receipt: RoyalMailPurchaseReceipt; message: string }
  | {
      success: false;
      runId: string;
      manualReviewCode: string;
      message: string;
      receipt?: undefined;
    };

interface RoyalMailPurchaseApi {
  listRecentOrders(options: {
    startDateTime: string;
    endDateTime: string;
    pageSize?: number;
    maxPages?: number;
  }): Promise<RoyalMailApiOrder[]>;
  createDomesticDraft(input: RoyalMailDomesticDraft): Promise<RoyalMailApiOrder>;
  deleteBotDraft(orderIdentifier: number): Promise<void>;
}

export interface RoyalMailPortalPayment {
  confirmedGrossMinor: number;
  paymentReference?: string;
  paidAt: string;
  trackingNumber?: string;
  pdfPath: string;
}

export interface RoyalMailPurchasePortal {
  verifyOrderRecipient(input: {
    providerOrderId: number;
    providerOrderReference: string;
    fullName: string;
    postcode: string;
  }): Promise<boolean>;
  prepareCheckout(input: {
    providerOrderId: number;
    providerOrderReference: string;
    serviceKey: RoyalMailServiceKey;
    serviceDisplayName: string;
    requestSignature: boolean;
    package: RoyalMailPurchaseInput["package"];
    outputDir: string;
    headed: boolean;
  }): Promise<{ expectedGrossMinor: number }>;
  completePaymentAndDownload(input: {
    providerOrderId: number;
    providerOrderReference: string;
    expectedGrossMinor: number;
    outputDir: string;
    noProhibitedOrRestrictedGoods: true;
  }): Promise<RoyalMailPortalPayment>;
}

interface RoyalMailPurchaseDependencies {
  stateDir: string;
  api: RoyalMailPurchaseApi;
  portal: RoyalMailPurchasePortal;
  journal: RoyalMailPurchaseJournal;
  mutex: { acquire(operationId: string): () => void };
  prepareArtifact(
    pdfPath: string,
    outputDir: string,
    outputStem: string,
  ): RoyalMailLabelArtifact;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function intentHash(input: RoyalMailPurchaseInput): string {
  const { headed: _runtimeBrowserMode, ...purchaseIntent } = input;
  return createHash("sha256").update(JSON.stringify(purchaseIntent)).digest("hex");
}

function legacyIntentHash(input: RoyalMailPurchaseInput): string {
  const {
    headed: _runtimeBrowserMode,
    noProhibitedOrRestrictedGoods: _goodsAttestation,
    ...legacyPurchaseIntent
  } = input;
  return createHash("sha256").update(JSON.stringify(legacyPurchaseIntent)).digest("hex");
}

function eventAt(now: () => number): string {
  return new Date(now()).toISOString();
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function failed(
  runId: string,
  manualReviewCode: string,
  message: string,
): RoyalMailPurchaseResult {
  return { success: false, runId, manualReviewCode, message };
}

function botReference(input: RoyalMailPurchaseInput): string {
  const order = input.orderNumber.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 20);
  const run = input.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `REF-${order}-${run}`.slice(0, 40);
}

function receiptFromCompletedEvent(event: RoyalMailPurchaseEvent): RoyalMailPurchaseReceipt | null {
  if (
    event.state !== "completed"
    || event.providerOrderId == null
    || !event.providerOrderReference
    || !event.origin
    || !event.serviceKey
    || event.expectedGrossMinor == null
    || event.confirmedGrossMinor == null
    || event.grossMinor == null
    || event.vatMinor == null
    || event.netMinor == null
    || !event.receiptId
    || !event.trackingKind
    || !event.pdfPath
    || !event.pdfSha256
    || !event.pngPath
    || !event.pngSha256
    || !event.paidAt
    || !event.packageFormat
  ) {
    return null;
  }
  const service = getRoyalMailService(event.serviceKey);
  return {
    schemaVersion: "1.0",
    carrier: "royalmail",
    runId: event.runId,
    intentHash: event.intentHash,
    providerOrderId: event.providerOrderId,
    providerOrderReference: event.providerOrderReference,
    origin: event.origin,
    serviceKey: service.key,
    serviceDisplayName: service.displayName,
    packageFormat: event.packageFormat,
    expectedGrossMinor: event.expectedGrossMinor,
    confirmedGrossMinor: event.confirmedGrossMinor,
    grossMinor: event.grossMinor,
    vatMinor: event.vatMinor,
    netMinor: event.netMinor,
    cost: event.netMinor / 100,
    currency: "GBP",
    receiptId: event.receiptId,
    trackingNumber: event.trackingNumber,
    trackingKind: event.trackingKind,
    paymentReference: event.paymentReference,
    paidAt: event.paidAt,
    pdfPath: event.pdfPath,
    pdfSha256: event.pdfSha256,
    pngPath: event.pngPath,
    pngSha256: event.pngSha256,
  };
}

export async function purchaseRoyalMailLabel(
  input: RoyalMailPurchaseInput,
  dependencies: RoyalMailPurchaseDependencies,
): Promise<RoyalMailPurchaseResult> {
  if (input.noProhibitedOrRestrictedGoods !== true) {
    return failed(
      input.runId,
      "goods_attestation_required",
      "Royal Mail purchase requires an explicit operator assertion that the parcel contains no prohibited, restricted, or dangerous goods.",
    );
  }
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep
    ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const hash = intentHash(input);
  const goodsAttestationEvidence = {
    noProhibitedOrRestrictedGoods: input.noProhibitedOrRestrictedGoods,
  } as const;
  const previous = dependencies.journal.latest(input.runId);
  if (previous) {
    const matchesLegacyPreAttestationIntent =
      previous.noProhibitedOrRestrictedGoods === undefined
      && previous.intentHash === legacyIntentHash(input);
    if (previous.intentHash !== hash && !matchesLegacyPreAttestationIntent) {
      return failed(
        input.runId,
        "run_intent_changed",
        "This Royal Mail run ID was already used for a different purchase intent.",
      );
    }
    const receipt = receiptFromCompletedEvent(previous);
    if (receipt) {
      return {
        success: true,
        receipt,
        message: "Royal Mail label already purchased for this run; returning the saved receipt.",
      };
    }
    return failed(
      input.runId,
      previous.state === "payment_uncertain"
        ? "payment_uncertain"
        : "incomplete_existing_run",
      `Royal Mail run ${input.runId} is already in ${previous.state}; reconcile it instead of paying again.`,
    );
  }

  const release = dependencies.mutex.acquire(`purchase:${input.runId}`);
  let order: RoyalMailApiOrder | undefined;
  let origin: "adopted" | "bot-created" | undefined;
  let checkoutStarted = false;
  const artifactDir = join(dependencies.stateDir, "artifacts", input.runId);

  try {
    const completedForOrder = dependencies.journal.completedPurchaseForOrder(
      input.orderNumber,
      input.runId,
    );
    if (completedForOrder) {
      return failed(
        completedForOrder.runId,
        "existing_order_purchase",
        `Royal Mail run ${completedForOrder.runId} already completed a label for order ${input.orderReference}. Reprint or reconcile that saved purchase; do not buy another label from a fresh form.`,
      );
    }

    const unresolved = dependencies.journal.unresolvedPurchaseForOrder(
      input.orderNumber,
      input.runId,
    );
    if (unresolved) {
      return failed(
        unresolved.runId,
        "unresolved_order_purchase",
        `Royal Mail run ${unresolved.runId} for order ${input.orderReference} is still ${unresolved.state}. Do not create another label; reconcile that run first.`,
      );
    }

    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: "planned",
      at: eventAt(now),
      intentHash: hash,
      shopifyOrderNumber: input.orderNumber,
      serviceKey: input.serviceKey,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const end = now();
      const orders = await dependencies.api.listRecentOrders({
        startDateTime: new Date(end - (48 * 60 * 60 * 1000)).toISOString(),
        endDateTime: new Date(end + (5 * 60 * 1000)).toISOString(),
        pageSize: 100,
        maxPages: 3,
      });
      const match = findUniqueOpenRoyalMailOrder(orders, input.orderReference);
      if (match.kind === "conflict") {
        dependencies.journal.append({
          ...goodsAttestationEvidence,
          runId: input.runId,
          state: "manual_review",
          at: eventAt(now),
          intentHash: hash,
          manualReviewCode: "multiple_open_orders",
          message: "Multiple open Click & Drop orders match the Shopify reference.",
        });
        return failed(
          input.runId,
          "multiple_open_orders",
          "Multiple open Click & Drop orders match this Shopify order; nothing was purchased.",
        );
      }
      if (match.kind === "unique") {
        order = match.order;
        origin = "adopted";
        break;
      }
      if (attempt < 2) {
        await sleep(5_000);
      }
    }

    if (!order) {
      order = await dependencies.api.createDomesticDraft({
        orderReference: botReference(input),
        orderDate: eventAt(now),
        recipient: input.recipient,
        package: input.package,
      });
      origin = "bot-created";
    }

    const orderState = origin === "adopted" ? "order_adopted" : "draft_created";
    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: orderState,
      at: eventAt(now),
      intentHash: hash,
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference,
      origin: origin!,
      serviceKey: input.serviceKey,
    });

    const recipientMatches = await dependencies.portal.verifyOrderRecipient({
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference ?? "",
      fullName: input.recipient.fullName,
      postcode: input.recipient.postcode,
    });
    if (!recipientMatches) {
      dependencies.journal.append({
        ...goodsAttestationEvidence,
        runId: input.runId,
        state: "manual_review",
        at: eventAt(now),
        intentHash: hash,
        providerOrderId: order.orderIdentifier,
        providerOrderReference: order.orderReference,
        origin,
        manualReviewCode: "recipient_mismatch",
      });
      return failed(
        input.runId,
        "recipient_mismatch",
        "The Click & Drop order recipient did not match the Shopify shipment; nothing was purchased.",
      );
    }

    const service = getRoyalMailService(input.serviceKey);
    const checkout = await dependencies.portal.prepareCheckout({
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference ?? "",
      serviceKey: service.key,
      serviceDisplayName: service.portalName,
      requestSignature: service.requestSignature,
      package: input.package,
      outputDir: artifactDir,
      headed: input.headed ?? false,
    });
    if (!Number.isSafeInteger(checkout.expectedGrossMinor) || checkout.expectedGrossMinor <= 0) {
      throw new Error("Click & Drop did not expose a valid GBP checkout total");
    }

    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: "checkout_ready",
      at: eventAt(now),
      intentHash: hash,
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference,
      origin,
      serviceKey: service.key,
      expectedGrossMinor: checkout.expectedGrossMinor,
      trackingKind: service.trackingKind,
      packageFormat: input.package.format,
    });
    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: "checkout_started",
      at: eventAt(now),
      intentHash: hash,
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference,
      origin,
      serviceKey: service.key,
      expectedGrossMinor: checkout.expectedGrossMinor,
      trackingKind: service.trackingKind,
      packageFormat: input.package.format,
    });
    checkoutStarted = true;

    let payment: RoyalMailPortalPayment;
    try {
      payment = await dependencies.portal.completePaymentAndDownload({
        providerOrderId: order.orderIdentifier,
        providerOrderReference: order.orderReference ?? "",
        expectedGrossMinor: checkout.expectedGrossMinor,
        outputDir: artifactDir,
        noProhibitedOrRestrictedGoods: input.noProhibitedOrRestrictedGoods,
      });
    } catch (error: unknown) {
      dependencies.journal.append({
        ...goodsAttestationEvidence,
        runId: input.runId,
        state: "payment_uncertain",
        at: eventAt(now),
        intentHash: hash,
        providerOrderId: order.orderIdentifier,
        providerOrderReference: order.orderReference,
        origin,
        serviceKey: service.key,
        expectedGrossMinor: checkout.expectedGrossMinor,
        trackingKind: service.trackingKind,
        packageFormat: input.package.format,
        manualReviewCode: "payment_confirmation_missing",
        message: errorMessage(error),
      });
      return failed(
        input.runId,
        "payment_confirmation_missing",
        "Royal Mail payment could not be proven. Do not retry; reconcile this run.",
      );
    }

    if (payment.confirmedGrossMinor !== checkout.expectedGrossMinor) {
      dependencies.journal.append({
        ...goodsAttestationEvidence,
        runId: input.runId,
        state: "payment_uncertain",
        at: eventAt(now),
        intentHash: hash,
        providerOrderId: order.orderIdentifier,
        providerOrderReference: order.orderReference,
        origin,
        serviceKey: service.key,
        expectedGrossMinor: checkout.expectedGrossMinor,
        confirmedGrossMinor: payment.confirmedGrossMinor,
        paymentReference: payment.paymentReference,
        paidAt: payment.paidAt,
        trackingNumber: payment.trackingNumber,
        trackingKind: service.trackingKind,
        packageFormat: input.package.format,
        manualReviewCode: "payment_amount_mismatch",
      });
      return failed(
        input.runId,
        "payment_amount_mismatch",
        "Royal Mail confirmed a different amount. Do not retry; reconcile this run.",
      );
    }

    const cost = calculateRoyalMailCost(payment.confirmedGrossMinor, service.vatTreatment);
    const receiptId = `rm:${order.orderIdentifier}`;
    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: "paid",
      at: eventAt(now),
      intentHash: hash,
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference,
      origin,
      serviceKey: service.key,
      expectedGrossMinor: checkout.expectedGrossMinor,
      confirmedGrossMinor: payment.confirmedGrossMinor,
      ...cost,
      paymentReference: payment.paymentReference,
      paidAt: payment.paidAt,
      receiptId,
      trackingNumber: payment.trackingNumber,
      trackingKind: service.trackingKind,
      packageFormat: input.package.format,
    });

    let artifact: RoyalMailLabelArtifact;
    try {
      artifact = dependencies.prepareArtifact(
        payment.pdfPath,
        artifactDir,
        `royalmail-${order.orderIdentifier}`,
      );
    } catch (error: unknown) {
      dependencies.journal.append({
        ...goodsAttestationEvidence,
        runId: input.runId,
        state: "manual_review",
        at: eventAt(now),
        intentHash: hash,
        providerOrderId: order.orderIdentifier,
        providerOrderReference: order.orderReference,
        origin,
        serviceKey: service.key,
        expectedGrossMinor: checkout.expectedGrossMinor,
        confirmedGrossMinor: payment.confirmedGrossMinor,
        ...cost,
        paymentReference: payment.paymentReference,
        paidAt: payment.paidAt,
        receiptId,
        trackingNumber: payment.trackingNumber,
        trackingKind: service.trackingKind,
        packageFormat: input.package.format,
        manualReviewCode: "label_artifact_invalid",
        message: errorMessage(error),
      });
      return failed(
        input.runId,
        "label_artifact_invalid",
        "Royal Mail payment succeeded but the label artifact needs manual recovery. Do not repurchase.",
      );
    }

    const receipt: RoyalMailPurchaseReceipt = {
      schemaVersion: "1.0",
      carrier: "royalmail",
      runId: input.runId,
      intentHash: hash,
      providerOrderId: order.orderIdentifier,
      providerOrderReference: order.orderReference ?? botReference(input),
      origin: origin!,
      serviceKey: service.key,
      serviceDisplayName: service.displayName,
      packageFormat: input.package.format,
      expectedGrossMinor: checkout.expectedGrossMinor,
      confirmedGrossMinor: payment.confirmedGrossMinor,
      ...cost,
      cost: cost.netMinor / 100,
      receiptId,
      trackingNumber: payment.trackingNumber,
      trackingKind: service.trackingKind,
      paymentReference: payment.paymentReference,
      paidAt: payment.paidAt,
      pdfPath: artifact.pdfPath,
      pdfSha256: artifact.pdfSha256,
      pngPath: artifact.pngPath,
      pngSha256: artifact.pngSha256,
    };

    dependencies.journal.append({
      ...receipt,
      ...goodsAttestationEvidence,
      state: "artifact_saved",
      at: eventAt(now),
    });
    dependencies.journal.append({
      ...receipt,
      ...goodsAttestationEvidence,
      state: "completed",
      at: eventAt(now),
    });

    return {
      success: true,
      receipt,
      message: `Royal Mail ${service.displayName} label purchased for £${(cost.grossMinor / 100).toFixed(2)}.`,
    };
  } catch (error: unknown) {
    if (checkoutStarted) {
      const latest = dependencies.journal.latest(input.runId);
      if (latest?.state === "checkout_started") {
        dependencies.journal.append({
          ...goodsAttestationEvidence,
          runId: input.runId,
          state: "payment_uncertain",
          at: eventAt(now),
          intentHash: hash,
          providerOrderId: order?.orderIdentifier,
          providerOrderReference: order?.orderReference,
          origin,
          serviceKey: input.serviceKey,
          trackingKind: getRoyalMailService(input.serviceKey).trackingKind,
          packageFormat: input.package.format,
          manualReviewCode: "checkout_interrupted",
          message: errorMessage(error),
        });
      }
      return failed(
        input.runId,
        "checkout_interrupted",
        "Royal Mail checkout was interrupted after payment began. Do not retry; reconcile this run.",
      );
    }

    if (origin === "bot-created" && order) {
      try {
        await dependencies.api.deleteBotDraft(order.orderIdentifier);
      } catch {
        dependencies.journal.append({
          ...goodsAttestationEvidence,
          runId: input.runId,
          state: "manual_review",
          at: eventAt(now),
          intentHash: hash,
          providerOrderId: order.orderIdentifier,
          providerOrderReference: order.orderReference,
          origin,
          manualReviewCode: "unpaid_draft_cleanup_failed",
        });
        return failed(
          input.runId,
          "unpaid_draft_cleanup_failed",
          "Royal Mail checkout failed before payment, but the bot draft could not be cleaned up.",
        );
      }
    }

    dependencies.journal.append({
      ...goodsAttestationEvidence,
      runId: input.runId,
      state: origin === "adopted" ? "manual_review" : "failed_no_charge",
      at: eventAt(now),
      intentHash: hash,
      providerOrderId: order?.orderIdentifier,
      providerOrderReference: order?.orderReference,
      origin,
      serviceKey: input.serviceKey,
      manualReviewCode: "precheckout_failed",
      message: errorMessage(error),
    });
    return failed(
      input.runId,
      "precheckout_failed",
      `Royal Mail checkout stopped before payment: ${errorMessage(error) ?? "unknown error"}`,
    );
  } finally {
    release();
  }
}
