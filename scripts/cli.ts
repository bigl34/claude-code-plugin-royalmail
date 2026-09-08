#!/usr/bin/env npx tsx

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { RoyalMailClient, CreateLabelOptions } from "./royalmail-client.js";
import {
  executeRoyalMailPurchaseCommand,
  executeRoyalMailReconcileCommand,
} from "./purchase-command.js";
import {
  defaultRoyalMailStateDir,
  RoyalMailBrowserMutex,
} from "./purchase-state.js";

async function withRoyalMailBrowserLock<T>(
  operationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = new RoyalMailBrowserMutex(defaultRoyalMailStateDir()).acquire(operationId);
  try {
    return await operation();
  } finally {
    release();
  }
}

const commands = {
  "create-label": createCommand(
    z.object({
      name: z.string().min(1).describe("Recipient full name"),
      address1: z.string().min(1).describe("Address line 1"),
      city: z.string().min(1).describe("City/town"),
      postcode: z.string().min(1).describe("UK postcode"),
      weight: cliTypes.float(0.01).describe("Weight in kg"),
      service: z.string().min(1).describe("Service code: TRACKED24, TRACKED48, SPECIALDELIVERY1, SPECIALDELIVERY9, SIGNED, SIGNED2"),
      company: z.string().optional().describe("Company name"),
      address2: z.string().optional().describe("Address line 2"),
      email: z.string().email().optional().describe("Recipient email"),
      phone: z.string().optional().describe("Recipient phone"),
      length: cliTypes.float(0.1).optional().describe("Length in cm"),
      width: cliTypes.float(0.1).optional().describe("Width in cm"),
      height: cliTypes.float(0.1).optional().describe("Height in cm"),
      reference: z.string().optional().describe("Customer reference e.g. order number"),
      contents: z.string().optional().describe("Package contents description"),
    }),
    async (args, client: RoyalMailClient) => {
      const typedArgs = args as {
        name: string;
        address1: string;
        city: string;
        postcode: string;
        weight: number;
        service: string;
        company?: string;
        address2?: string;
        email?: string;
        phone?: string;
        length?: number;
        width?: number;
        height?: number;
        reference?: string;
        contents?: string;
      };
      const labelOptions: CreateLabelOptions = {
        name: typedArgs.name,
        address1: typedArgs.address1,
        city: typedArgs.city,
        postcode: typedArgs.postcode,
        weight: typedArgs.weight,
        service: typedArgs.service,
        company: typedArgs.company,
        address2: typedArgs.address2,
        email: typedArgs.email,
        phone: typedArgs.phone,
        length: typedArgs.length,
        width: typedArgs.width,
        height: typedArgs.height,
        reference: typedArgs.reference,
        contents: typedArgs.contents,
      };
      return withRoyalMailBrowserLock(
        `legacy-create-label:${process.pid}`,
        () => client.createLabel(labelOptions),
      );
    },
    "Fill label creation form (does NOT submit)",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "purchase-label": createCommand(
    z.object({
      requestFile: z.string().min(1).describe("Mode-0600 JSON purchase request file"),
      stateDir: z.string().min(1).optional().describe("Private Royal Mail runtime state directory"),
      headed: z.boolean().optional().describe("Run Click & Drop browser visibly for supervised rollout"),
    }),
    async (args) => {
      const typedArgs = args as {
        requestFile: string;
        stateDir?: string;
        headed?: boolean;
      };
      return executeRoyalMailPurchaseCommand(typedArgs);
    },
    "Purchase, download, and prepare one Royal Mail label in a single idempotent transaction",
    {
      sideEffect: "external_send",
      requiresConfirmation: true,
      operationResultExit: true,
    }
  ),

  "reconcile-purchase": createCommand(
    z.object({
      runId: z.string().min(1).describe("Existing Royal Mail purchase run ID"),
      stateDir: z.string().min(1).optional().describe("Private Royal Mail runtime state directory"),
      headed: z.boolean().optional().describe("Run Click & Drop browser visibly for supervised recovery"),
    }),
    async (args) => {
      const typedArgs = args as {
        runId: string;
        stateDir?: string;
        headed?: boolean;
      };
      return executeRoyalMailReconcileCommand(typedArgs);
    },
    "Recover an already-paid Royal Mail run without entering checkout or making a payment",
    { sideEffect: "write", operationResultExit: true }
  ),

  "submit": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => client.submit(),
    "Compatibility command that refuses automated submission and requires manual portal completion",
    { sideEffect: "external_send", requiresConfirmation: true }
  ),

  "download-label": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => withRoyalMailBrowserLock(
      `legacy-download-label:${process.pid}`,
      () => client.downloadLabel(),
    ),
    "Download the generated PDF label",
    { sideEffect: "read" }
  ),

  "download-invoices": createCommand(
    z.object({
      outputDir: z.string().min(1).describe("Absolute output directory for downloaded invoice PDFs"),
      headed: z.boolean().optional().describe("Run browser in headed mode for debugging"),
    }),
    async (args, client: RoyalMailClient) => {
      const typedArgs = args as {
        outputDir: string;
        headed?: boolean;
      };
      return withRoyalMailBrowserLock(
        `download-invoices:${process.pid}`,
        () => client.downloadInvoices({
          outputDir: typedArgs.outputDir,
          headed: typedArgs.headed,
        }),
      );
    },
    "Download new Royal Mail invoices with dedupe into staging; legacy files use exact-digest promotion",
    { sideEffect: "write", requiresConfirmation: true }
  ),

  "list-services": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => {
      const services = await client.listServices();
      return {
        success: true,
        services,
        message: "Use the 'code' value with --service option in create-label",
      };
    },
    "Show available Royal Mail services",
    { sideEffect: "read" }
  ),

  "screenshot": createCommand(
    z.object({
      filename: z.string().optional().describe("Screenshot filename"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page"),
    }),
    async (args, client: RoyalMailClient) => {
      const { filename, fullPage } = args as { filename?: string; fullPage?: boolean };
      return withRoyalMailBrowserLock(
        `screenshot:${process.pid}`,
        () => client.takeScreenshot({ filename, fullPage }),
      );
    },
    "Take screenshot of current page",
    { sideEffect: "read" }
  ),

  "reset": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => withRoyalMailBrowserLock(
      `reset:${process.pid}`,
      () => client.reset(),
    ),
    "Close browser and clear session",
    { sideEffect: "destructive" }
  ),
};

runCli(commands, RoyalMailClient, {
  programName: "royalmail-cli",
  description: "Royal Mail label creation and purchase via Click & Drop",
});
