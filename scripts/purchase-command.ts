import { existsSync, unlinkSync } from "node:fs";

import { RoyalMailApiClient } from "./royalmail-api.js";
import {
  preflightRoyalMailRasterizer,
  prepareRoyalMailLabelArtifact,
} from "./label-artifact.js";
import { loadRoyalMailPurchaseInput } from "./purchase-input.js";
import { purchaseRoyalMailLabel } from "./purchase-flow.js";
import { reconcileRoyalMailPurchase } from "./reconcile-flow.js";
import {
  defaultRoyalMailStateDir,
  RoyalMailBrowserMutex,
  RoyalMailPurchaseJournal,
} from "./purchase-state.js";
import { RoyalMailClickDropPortal } from "./royalmail-portal.js";

export async function executeRoyalMailPurchaseCommand(options: {
  requestFile: string;
  stateDir?: string;
  headed?: boolean;
  enabled?: boolean;
}): Promise<unknown> {
  let portal: RoyalMailClickDropPortal | null = null;
  try {
    const enabled = options.enabled ?? process.env.ROYALMAIL_LABELS_ENABLED === "1";
    if (!enabled) {
      throw new Error("Royal Mail label purchase is disabled; set ROYALMAIL_LABELS_ENABLED=1");
    }

    const request = loadRoyalMailPurchaseInput(options.requestFile);
    const stateDir = options.stateDir ?? defaultRoyalMailStateDir();
    const headed = options.headed ?? request.headed ?? true;
    const api = new RoyalMailApiClient();
    await api.preflight();
    preflightRoyalMailRasterizer();

    portal = new RoyalMailClickDropPortal({
      stateDir,
      headed,
    });
    return await purchaseRoyalMailLabel(
      { ...request, headed },
      {
        stateDir,
        api,
        portal,
        journal: new RoyalMailPurchaseJournal(stateDir),
        mutex: new RoyalMailBrowserMutex(stateDir),
        prepareArtifact: prepareRoyalMailLabelArtifact,
      },
    );
  } finally {
    await portal?.close().catch(() => undefined);
    try {
      if (existsSync(options.requestFile)) {
        unlinkSync(options.requestFile);
      }
    } catch {
    }
  }
}

export async function executeRoyalMailReconcileCommand(options: {
  runId: string;
  stateDir?: string;
  headed?: boolean;
  enabled?: boolean;
}): Promise<unknown> {
  let portal: RoyalMailClickDropPortal | null = null;
  try {
    const enabled = options.enabled ?? process.env.ROYALMAIL_LABELS_ENABLED === "1";
    if (!enabled) {
      throw new Error("Royal Mail label recovery is disabled; set ROYALMAIL_LABELS_ENABLED=1");
    }
    const stateDir = options.stateDir ?? defaultRoyalMailStateDir();
    preflightRoyalMailRasterizer();
    portal = new RoyalMailClickDropPortal({
      stateDir,
      headed: options.headed ?? false,
    });
    return await reconcileRoyalMailPurchase(options.runId, {
      stateDir,
      portal,
      journal: new RoyalMailPurchaseJournal(stateDir),
      mutex: new RoyalMailBrowserMutex(stateDir),
      prepareArtifact: prepareRoyalMailLabelArtifact,
    });
  } finally {
    await portal?.close().catch(() => undefined);
  }
}
