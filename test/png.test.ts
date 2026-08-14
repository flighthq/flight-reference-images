import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { comparePngs, createDeltaPng, DimensionMismatchError, parsePng } from '../src/png.js';

describe('comparePngs', () => {
  it('counts pixels whose largest channel change exceeds the tolerance', () => {
    const expected = parsePng(makePng(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]));
    const actual = parsePng(makePng(2, 1, [12, 20, 30, 255, 40, 61, 60, 255]));

    expect(comparePngs(expected, actual, 5)).toEqual({
      fraction: 0.5,
      maxChannelDelta: 11,
      mismatchedPixels: 1,
      totalPixels: 2,
    });
  });

  it('reports a dimension verdict instead of reading across unequal buffers', () => {
    const expected = parsePng(makePng(1, 1, [0, 0, 0, 255]));
    const actual = parsePng(makePng(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]));

    expect(() => comparePngs(expected, actual, 0)).toThrow(DimensionMismatchError);
    expect(() => createDeltaPng(expected, actual)).toThrow('expected 1x1, got 2x1');
  });
});

describe('parsePng', () => {
  it('keeps encoded and decoded checksums distinct', () => {
    const pixels = Array.from({ length: 64 * 64 * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : (index * 31 + Math.floor(index / 17)) % 256,
    );
    const fast = parsePng(makePng(64, 64, pixels, 1, 0));
    const compact = parsePng(makePng(64, 64, pixels, 9, 4));

    expect(fast.artifactSha256).not.toBe(compact.artifactSha256);
    expect(fast.pixelSha256).toBe(compact.pixelSha256);
  });

  it('rejects arbitrary bytes before asking the decoder to interpret them', () => {
    expect(() => parsePng(Buffer.from('not a png'))).toThrow('image is not a PNG');
  });
});

function makePng(width: number, height: number, pixels: readonly number[], deflateLevel = 6, filterType = -1): Buffer {
  const png = new PNG({ height, width });
  png.data.set(pixels);
  return PNG.sync.write(png, { colorType: 6, deflateLevel, filterType, inputColorType: 6 });
}
