import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "@local/cli-utils";

import type { RoyalMailPurchaseInput } from "./purchase-flow.js";

export const RoyalMailPurchaseInputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string()
    .min(8)
    .max(100)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "runId must be a path-safe token containing only letters, numbers, underscores, or hyphens",
    ),
  orderNumber: z.string().min(1).max(40),
  orderReference: z.string().min(1).max(40),
  recipient: z.object({
    fullName: z.string().min(1).max(210),
    companyName: z.string().max(100).optional(),
    addressLine1: z.string().min(1).max(100),
    addressLine2: z.string().max(100).optional(),
    addressLine3: z.string().max(100).optional(),
    city: z.string().min(1).max(100),
    county: z.string().max(100).optional(),
    postcode: z.string().min(2).max(20),
    countryCode: z.literal("GB"),
    emailAddress: z.string().email().max(254).optional(),
    phoneNumber: z.string().max(25).optional(),
  }),
  package: z.object({
    format: z.enum(["letter", "largeLetter", "smallParcel", "mediumParcel"]),
    weightGrams: z.number().int().min(1).max(30_000),
    lengthMm: z.number().int().positive(),
    widthMm: z.number().int().positive(),
    heightMm: z.number().int().positive(),
    contents: z.string().min(1).max(500),
  }),
  noProhibitedOrRestrictedGoods: z.literal(true),
  serviceKey: z.enum([
    "tracked24",
    "second_class",
    "tracked48",
    "first_class",
    "signed_second",
    "tracked24_signature",
    "special_delivery_1pm",
    "signed_first",
  ]),
  headed: z.boolean().optional(),
});

export function loadRoyalMailPurchaseInput(requestPath: string): RoyalMailPurchaseInput {
  const absolutePath = resolve(requestPath);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Royal Mail purchase request path must identify a regular file");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("Royal Mail purchase request file must have mode 0600");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error: unknown) {
    throw new Error(
      `Invalid Royal Mail purchase request JSON: ${error instanceof Error ? error.message : "parse error"}`,
    );
  }

  const parsed = RoyalMailPurchaseInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid Royal Mail purchase request: ${parsed.error.message}`);
  }
  return parsed.data as RoyalMailPurchaseInput;
}
