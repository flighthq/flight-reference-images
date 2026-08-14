import { readFile } from 'node:fs/promises';

import { PNG } from 'pngjs';

import { hashBytes } from './json.js';
import type { ComparisonPolicy } from './types.js';

export interface BitmapMismatch {
  fraction: number;
  maxChannelDelta: number;
  mismatchedPixels: number;
  totalPixels: number;
}

export interface DecodedPng {
  artifactSha256: string;
  data: Buffer;
  height: number;
  pixelSha256: string;
  width: number;
}

export interface PngLimits {
  maximumBytes: number;
  maximumHeight: number;
  maximumPixels: number;
  maximumWidth: number;
}

export class DimensionMismatchError extends Error {
  readonly actualHeight: number;
  readonly actualWidth: number;
  readonly expectedHeight: number;
  readonly expectedWidth: number;

  constructor(expected: Readonly<DecodedPng>, actual: Readonly<DecodedPng>) {
    super(
      `image dimensions differ: expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`,
    );
    this.name = 'DimensionMismatchError';
    this.expectedWidth = expected.width;
    this.expectedHeight = expected.height;
    this.actualWidth = actual.width;
    this.actualHeight = actual.height;
  }
}

export function comparePngs(
  expected: Readonly<DecodedPng>,
  actual: Readonly<DecodedPng>,
  channelTolerance: number,
): BitmapMismatch {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new DimensionMismatchError(expected, actual);
  }
  if (!Number.isInteger(channelTolerance) || channelTolerance < 0 || channelTolerance > 255) {
    throw new Error(`channel tolerance must be an integer from 0 through 255, got ${channelTolerance}`);
  }

  let maxChannelDelta = 0;
  let mismatchedPixels = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      pixelDelta = Math.max(pixelDelta, Math.abs(expected.data[index + channel]! - actual.data[index + channel]!));
    }
    maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
    if (pixelDelta > channelTolerance) mismatchedPixels += 1;
  }

  const totalPixels = expected.width * expected.height;
  return { fraction: mismatchedPixels / totalPixels, maxChannelDelta, mismatchedPixels, totalPixels };
}

export function createDeltaPng(expected: Readonly<DecodedPng>, actual: Readonly<DecodedPng>): Buffer {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new DimensionMismatchError(expected, actual);
  }

  const delta = new PNG({ height: expected.height, width: expected.width });
  for (let index = 0; index < expected.data.length; index += 4) {
    delta.data[index] = Math.abs(expected.data[index]! - actual.data[index]!);
    delta.data[index + 1] = Math.abs(expected.data[index + 1]! - actual.data[index + 1]!);
    delta.data[index + 2] = Math.abs(expected.data[index + 2]! - actual.data[index + 2]!);
    delta.data[index + 3] = 255;
  }
  return PNG.sync.write(delta, { colorType: 6, inputColorType: 6 });
}

export function evaluateMismatch(mismatch: Readonly<BitmapMismatch>, policy: Readonly<ComparisonPolicy>): boolean {
  if (mismatch.fraction > policy.maximumMismatchFraction) return false;
  return policy.maximumChannelDelta.mode !== 'gate' || mismatch.maxChannelDelta <= policy.maximumChannelDelta.maximum;
}

export function parsePng(bytes: Buffer, limits: Readonly<PngLimits> = DEFAULT_PNG_LIMITS): DecodedPng {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('image is not a PNG');
  if (bytes.length < 33) throw new Error('PNG header is truncated');
  if (bytes.length > limits.maximumBytes)
    throw new Error(`PNG is ${bytes.length} bytes; maximum is ${limits.maximumBytes}`);
  const headerWidth = bytes.readUInt32BE(16);
  const headerHeight = bytes.readUInt32BE(20);
  if (headerWidth < 1 || headerWidth > limits.maximumWidth) {
    throw new Error(`PNG width is ${headerWidth}; maximum is ${limits.maximumWidth}`);
  }
  if (headerHeight < 1 || headerHeight > limits.maximumHeight) {
    throw new Error(`PNG height is ${headerHeight}; maximum is ${limits.maximumHeight}`);
  }
  if (headerWidth * headerHeight > limits.maximumPixels) {
    throw new Error(`PNG has ${headerWidth * headerHeight} pixels; maximum is ${limits.maximumPixels}`);
  }
  if (bytes[24] !== 8) throw new Error(`PNG must use 8-bit channels, got bit depth ${bytes[24] ?? 'unknown'}`);

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(bytes, { skipRescale: true });
  } catch (error) {
    throw new Error(`cannot decode PNG: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = Buffer.from(decoded.data);
  return {
    artifactSha256: hashBytes(bytes),
    data,
    height: decoded.height,
    pixelSha256: hashBytes(data),
    width: decoded.width,
  };
}

export async function readPng(path: string, limits?: Readonly<PngLimits>): Promise<DecodedPng> {
  return parsePng(await readFile(path), limits);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_PNG_LIMITS: PngLimits = {
  maximumBytes: 64 * 1024 * 1024,
  maximumHeight: 8192,
  maximumPixels: 32 * 1024 * 1024,
  maximumWidth: 8192,
};
