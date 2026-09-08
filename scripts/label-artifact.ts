import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface PdfGeometry {
  pages: number;
  widthPoints: number;
  heightPoints: number;
}

export interface RoyalMailLabelArtifact {
  pdfPath: string;
  pdfSha256: string;
  pngPath: string;
  pngSha256: string;
  pngWidth: number;
  pngHeight: number;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parsePdfInfo(output: string): PdfGeometry {
  const pagesMatch = output.match(/^Pages:\s+(\d+)/mi);
  const sizeMatch = output.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/mi);
  if (!pagesMatch || !sizeMatch) {
    throw new Error("Royal Mail label PDF metadata is incomplete");
  }

  const pages = Number(pagesMatch[1]);
  const widthPoints = Number(sizeMatch[1]);
  const heightPoints = Number(sizeMatch[2]);
  if (pages !== 1) {
    throw new Error(`Royal Mail label PDF must contain exactly one page; received ${pages}`);
  }
  if (
    widthPoints < 280
    || widthPoints > 295
    || heightPoints < 420
    || heightPoints > 440
    || widthPoints >= heightPoints
  ) {
    throw new Error(
      `Royal Mail label PDF must be 6x4 portrait; received ${widthPoints} x ${heightPoints} points`,
    );
  }

  return { pages, widthPoints, heightPoints };
}

export function validateRoyalMailPng(path: string): { width: number; height: number } {
  const buffer = readFileSync(path);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("Royal Mail printable artifact is not a valid PNG");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1180 || width > 1220 || height < 1770 || height > 1820) {
    throw new Error(
      `Royal Mail printable PNG has unexpected dimensions ${width}x${height}; expected 300-DPI 6x4 portrait`,
    );
  }
  return { width, height };
}

export function preflightRoyalMailRasterizer(): void {
  execFileSync("pdfinfo", ["-v"], { stdio: "ignore" });
  execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
}

export function prepareRoyalMailLabelArtifact(
  pdfPath: string,
  outputDir: string,
  outputStem: string,
): RoyalMailLabelArtifact {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  chmodSync(outputDir, 0o700);

  const pdfBuffer = readFileSync(pdfPath);
  if (pdfBuffer.length < 5 || pdfBuffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Royal Mail label download is not a PDF");
  }
  if (statSync(pdfPath).size <= 0) {
    throw new Error("Royal Mail label PDF is empty");
  }

  const metadata = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  parsePdfInfo(metadata);

  const pngStem = join(outputDir, outputStem);
  execFileSync(
    "pdftoppm",
    ["-png", "-r", "300", "-f", "1", "-l", "1", "-singlefile", pdfPath, pngStem],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const pngPath = `${pngStem}.png`;
  chmodSync(pdfPath, 0o600);
  chmodSync(pngPath, 0o600);
  const { width, height } = validateRoyalMailPng(pngPath);

  return {
    pdfPath,
    pdfSha256: sha256(pdfPath),
    pngPath,
    pngSha256: sha256(pngPath),
    pngWidth: width,
    pngHeight: height,
  };
}
