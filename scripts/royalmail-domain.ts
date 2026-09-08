export type RoyalMailServiceKey =
  | "tracked24"
  | "second_class"
  | "tracked48"
  | "first_class"
  | "signed_second"
  | "tracked24_signature"
  | "special_delivery_1pm"
  | "signed_first";

export type RoyalMailVatTreatment = "exempt" | "standard20";

export type RoyalMailTrackingKind = "none" | "delivery_confirmation" | "full";

export type RoyalMailPackageFormat =
  | "letter"
  | "largeLetter"
  | "smallParcel"
  | "mediumParcel";

export interface RoyalMailService {
  key: RoyalMailServiceKey;
  displayName: string;
  portalName: string;
  vatTreatment: RoyalMailVatTreatment;
  trackingKind: RoyalMailTrackingKind;
  requestSignature: boolean;
}

export const ROYAL_MAIL_SERVICES: readonly RoyalMailService[] = [
  {
    key: "tracked24",
    displayName: "Tracked 24",
    portalName: "Royal Mail Tracked 24",
    vatTreatment: "standard20",
    trackingKind: "full",
    requestSignature: false,
  },
  {
    key: "second_class",
    displayName: "2nd Class",
    portalName: "Royal Mail 2nd Class",
    vatTreatment: "exempt",
    trackingKind: "none",
    requestSignature: false,
  },
  {
    key: "tracked48",
    displayName: "Tracked 48",
    portalName: "Royal Mail Tracked 48",
    vatTreatment: "standard20",
    trackingKind: "full",
    requestSignature: false,
  },
  {
    key: "first_class",
    displayName: "1st Class",
    portalName: "Royal Mail 1st Class",
    vatTreatment: "exempt",
    trackingKind: "none",
    requestSignature: false,
  },
  {
    key: "signed_second",
    displayName: "Signed For 2nd Class",
    portalName: "Royal Mail Signed For 2nd Class",
    vatTreatment: "exempt",
    trackingKind: "delivery_confirmation",
    requestSignature: true,
  },
  {
    key: "tracked24_signature",
    displayName: "Tracked 24 with Signature",
    portalName: "Royal Mail Tracked 24",
    vatTreatment: "standard20",
    trackingKind: "full",
    requestSignature: true,
  },
  {
    key: "special_delivery_1pm",
    displayName: "Special Delivery Guaranteed by 1pm",
    portalName: "Special Delivery Guaranteed by 1pm",
    vatTreatment: "exempt",
    trackingKind: "full",
    requestSignature: true,
  },
  {
    key: "signed_first",
    displayName: "Signed For 1st Class",
    portalName: "Royal Mail Signed For 1st Class",
    vatTreatment: "exempt",
    trackingKind: "delivery_confirmation",
    requestSignature: true,
  },
] as const;

const SERVICE_BY_KEY = new Map<string, RoyalMailService>(
  ROYAL_MAIL_SERVICES.map((service) => [service.key, service]),
);

export function getRoyalMailService(key: string): RoyalMailService {
  const service = SERVICE_BY_KEY.get(key);
  if (!service) {
    throw new Error(`Unsupported Royal Mail service: ${key}`);
  }
  return service;
}

export function calculateRoyalMailCost(
  grossMinor: number,
  treatment: RoyalMailVatTreatment,
): {
  grossMinor: number;
  vatMinor: number;
  netMinor: number;
  currency: "GBP";
} {
  if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0) {
    throw new Error("Royal Mail checkout total must be a positive integer in GBP minor units");
  }

  const vatMinor = treatment === "standard20"
    ? Math.round(grossMinor / 6)
    : 0;
  const netMinor = grossMinor - vatMinor;

  return {
    grossMinor,
    vatMinor,
    netMinor,
    currency: "GBP",
  };
}
