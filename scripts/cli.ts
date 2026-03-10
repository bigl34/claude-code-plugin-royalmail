#!/usr/bin/env npx tsx
/**
 * Royal Mail Label Manager CLI
 *
 * Zod-validated CLI for creating Royal Mail shipping labels via Click & Drop.
 */

import { z, createCommand, runCli, cliTypes } from "@local/cli-utils";
import { RoyalMailClient, CreateLabelOptions } from "./royalmail-client.js";

// Define commands with Zod schemas
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
      return client.createLabel(labelOptions);
    },
    "Fill label creation form (does NOT submit)"
  ),

  "submit": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => client.submit(),
    "Submit the filled form after user confirmation"
  ),

  "download-label": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => client.downloadLabel(),
    "Download the generated PDF label"
  ),

  "download-invoices": createCommand(
    z.object({
      outputDir: z.string().min(1).describe("Absolute output directory for downloaded invoice PDFs"),
      legacyDir: z.string().optional().describe("Optional legacy directory to migrate existing invoices from"),
      headed: z.boolean().optional().describe("Run browser in headed mode for debugging"),
    }),
    async (args, client: RoyalMailClient) => {
      const typedArgs = args as {
        outputDir: string;
        legacyDir?: string;
        headed?: boolean;
      };
      return client.downloadInvoices({
        outputDir: typedArgs.outputDir,
        legacyDir: typedArgs.legacyDir,
        headed: typedArgs.headed,
      });
    },
    "Download new Royal Mail invoices with dedupe and optional legacy migration"
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
    "Show available Royal Mail services"
  ),

  "screenshot": createCommand(
    z.object({
      filename: z.string().optional().describe("Screenshot filename"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page"),
    }),
    async (args, client: RoyalMailClient) => {
      const { filename, fullPage } = args as { filename?: string; fullPage?: boolean };
      return client.takeScreenshot({ filename, fullPage });
    },
    "Take screenshot of current page"
  ),

  "reset": createCommand(
    z.object({}),
    async (_args, client: RoyalMailClient) => client.reset(),
    "Close browser and clear session"
  ),
};

// Run CLI
runCli(commands, RoyalMailClient, {
  programName: "royalmail-cli",
  description: "Royal Mail label creation via Click & Drop",
});
