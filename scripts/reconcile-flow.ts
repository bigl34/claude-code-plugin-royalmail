import { join } from "node:path";

import { calculateRoyalMailCost, getRoyalMailService } from "./royalmail-domain.js";
import type { RoyalMailLabelArtifact } from "./label-artifact.js";
import type {
  RoyalMailPortalPayment,
  RoyalMailPurchaseReceipt,
  RoyalMailPurchaseResult,
} from "./purchase-flow.js";
import type {
  RoyalMailPurchaseEvent,
  RoyalMailPurchaseJournal,
} from "./purchase-state.js";

interface RoyalMailReconcilePortal {
  recoverPaidLabel(input: {
    providerOrderId: number;
    providerOrderReference: string;
    expectedGrossMinor: number;
    outputDir: string;
  }): Promise<RoyalMailPortalPayment | null>;
}

interface RoyalMailReconcileDependencies {
  stateDir: string;
  portal: RoyalMailReconcilePortal;
  journal: RoyalMailPurchaseJournal;
  mutex: { acquire(operationId: string): () => void };
  prepareArtifact(
    pdfPath: string,
    outputDir: string,
    outputStem: string,
  ): RoyalMailLabelArtifact;
  now?: () => number;
}

function failed(runId: string, manualReviewCode: string, message: string): RoyalMailPurchaseResult {
  return { success: false, runId, manualReviewCode, message };
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function crediblePaymentReference(value: string | undefined): string | undefined {
  return value && /\d/.test(value) ? value : undefined;
}

function requireRecoveryContext(event: RoyalMailPurchaseEvent): {
  providerOrderId: number;
  providerOrderReference: string;
  origin: "adopted" | "bot-created";
  serviceKey: NonNullable<RoyalMailPurchaseEvent["serviceKey"]>;
  expectedGrossMinor: number;
  packageFormat: NonNullable<RoyalMailPurchaseEvent["packageFormat"]>;
} | null {
  if (
    event.providerOrderId == null
    || !event.providerOrderReference
    || !event.origin
    || !event.serviceKey
    || event.expectedGrossMinor == null
    || !event.packageFormat
  ) {
    return null;
  }
  return {
    providerOrderId: event.providerOrderId,
    providerOrderReference: event.providerOrderReference,
    origin: event.origin,
    serviceKey: event.serviceKey,
    expectedGrossMinor: event.expectedGrossMinor,
    packageFormat: event.packageFormat,
  };
}

function completedReceipt(event: RoyalMailPurchaseEvent): RoyalMailPurchaseReceipt | null {
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
    || !event.packageFormat
    || !event.paidAt
    || !event.pdfPath
    || !event.pdfSha256
    || !event.pngPath
    || !event.pngSha256
  ) return null;
  const service = getRoyalMailService(event.serviceKey);
  const paymentReference = crediblePaymentReference(event.paymentReference);
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
    paymentReference,
    paidAt: event.paidAt,
    pdfPath: event.pdfPath,
    pdfSha256: event.pdfSha256,
    pngPath: event.pngPath,
    pngSha256: event.pngSha256,
  };
}

export async function reconcileRoyalMailPurchase(
  runId: string,
  dependencies: RoyalMailReconcileDependencies,
): Promise<RoyalMailPurchaseResult> {
  const latest = dependencies.journal.latest(runId);
  if (!latest) {
    return failed(runId, "run_not_found", `Royal Mail run ${runId} was not found.`);
  }
  const priorReceipt = completedReceipt(latest);
  if (priorReceipt) {
    return {
      success: true,
      receipt: priorReceipt,
      message: "Royal Mail run was already completed; returning its saved receipt.",
    };
  }
  if (latest.state === "failed_no_charge") {
    return failed(runId, "failed_no_charge", "Royal Mail recorded that this run did not charge.");
  }
  if (!["checkout_started", "payment_uncertain", "manual_review", "paid"].includes(latest.state)) {
    return failed(
      runId,
      "run_not_reconcilable",
      `Royal Mail run ${runId} is in ${latest.state}; it cannot be recovered automatically.`,
    );
  }
  const context = requireRecoveryContext(latest);
  if (!context) {
    return failed(
      runId,
      "recovery_context_incomplete",
      "Royal Mail recovery context is incomplete. No payment or purchase action was attempted.",
    );
  }

  const release = dependencies.mutex.acquire(`reconcile:${runId}`);
  const artifactDir = join(dependencies.stateDir, "artifacts", runId);
  const now = dependencies.now ?? Date.now;
  try {
    const recovered = await dependencies.portal.recoverPaidLabel({
      providerOrderId: context.providerOrderId,
      providerOrderReference: context.providerOrderReference,
      expectedGrossMinor: context.expectedGrossMinor,
      outputDir: artifactDir,
    });
    if (!recovered) {
      return failed(
        runId,
        "payment_not_proven",
        "Royal Mail payment is still not proven. No payment or purchase action was attempted.",
      );
    }
    const paymentReference = crediblePaymentReference(recovered.paymentReference);
    if (recovered.confirmedGrossMinor !== context.expectedGrossMinor) {
      if (latest.state !== "manual_review") {
        dependencies.journal.append({
          ...latest,
          state: "manual_review",
          at: new Date(now()).toISOString(),
          confirmedGrossMinor: recovered.confirmedGrossMinor,
          paymentReference,
          paidAt: recovered.paidAt,
          trackingNumber: recovered.trackingNumber,
          manualReviewCode: "recovered_amount_mismatch",
        });
      }
      return failed(
        runId,
        "recovered_amount_mismatch",
        "The recovered Royal Mail payment amount does not match the recorded checkout total.",
      );
    }

    const service = getRoyalMailService(context.serviceKey);
    const cost = calculateRoyalMailCost(recovered.confirmedGrossMinor, service.vatTreatment);
    const receiptId = `rm:${context.providerOrderId}`;
    if (latest.state !== "paid") {
      dependencies.journal.append({
        runId,
        state: "paid",
        at: new Date(now()).toISOString(),
        intentHash: latest.intentHash,
        ...context,
        confirmedGrossMinor: recovered.confirmedGrossMinor,
        ...cost,
        paymentReference,
        paidAt: recovered.paidAt,
        receiptId,
        trackingNumber: recovered.trackingNumber,
        trackingKind: service.trackingKind,
      });
    }

    let artifact: RoyalMailLabelArtifact;
    try {
      artifact = dependencies.prepareArtifact(
        recovered.pdfPath,
        artifactDir,
        `royalmail-${context.providerOrderId}`,
      );
    } catch (error: unknown) {
      dependencies.journal.append({
        runId,
        state: "manual_review",
        at: new Date(now()).toISOString(),
        intentHash: latest.intentHash,
        ...context,
        confirmedGrossMinor: recovered.confirmedGrossMinor,
        ...cost,
        paymentReference,
        paidAt: recovered.paidAt,
        receiptId,
        trackingNumber: recovered.trackingNumber,
        trackingKind: service.trackingKind,
        manualReviewCode: "label_artifact_invalid",
        message: errorMessage(error),
      });
      return failed(
        runId,
        "label_artifact_invalid",
        "Royal Mail payment was recovered but the saved label artifact is invalid.",
      );
    }

    const receipt: RoyalMailPurchaseReceipt = {
      schemaVersion: "1.0",
      carrier: "royalmail",
      runId,
      intentHash: latest.intentHash,
      providerOrderId: context.providerOrderId,
      providerOrderReference: context.providerOrderReference,
      origin: context.origin,
      serviceKey: service.key,
      serviceDisplayName: service.displayName,
      packageFormat: context.packageFormat,
      expectedGrossMinor: context.expectedGrossMinor,
      confirmedGrossMinor: recovered.confirmedGrossMinor,
      ...cost,
      cost: cost.netMinor / 100,
      receiptId,
      trackingNumber: recovered.trackingNumber,
      trackingKind: service.trackingKind,
      paymentReference,
      paidAt: recovered.paidAt,
      ...artifact,
    };
    dependencies.journal.append({ ...receipt, state: "artifact_saved", at: new Date(now()).toISOString() });
    dependencies.journal.append({ ...receipt, state: "completed", at: new Date(now()).toISOString() });
    return {
      success: true,
      receipt,
      message: `Recovered the existing Royal Mail ${service.displayName} label without making a payment.`,
    };
  } finally {
    release();
  }
}
