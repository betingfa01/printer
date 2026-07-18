// js/smartCardFit.js
/**
 * Smart engine calculation module for precise card target resizing fitting.
 * Computes destination rect assets ensuring zero stretch, centered focal positioning,
 * matching raw pixels directly onto the calculated aspect parameters.
 */
export function calculateSmartFit(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
        throw new Error('calculateSmartFit received invalid (zero or undefined) dimensions.');
    }

    const sourceRatio = sourceWidth / sourceHeight;
    const targetRatio = targetWidth / targetHeight;

    let srcX = 0;
    let srcY = 0;
    let srcWidth = sourceWidth;
    let srcHeight = sourceHeight;

    // Use a small epsilon so near-equal ratios don't trigger a 1px crop from float drift.
    const EPSILON = 0.0005;

    if (sourceRatio - targetRatio > EPSILON) {
        // Source is wider than target ratio limit -> crop sides
        srcWidth = sourceHeight * targetRatio;
        srcX = (sourceWidth - srcWidth) / 2;
    } else if (targetRatio - sourceRatio > EPSILON) {
        // Source is taller than target ratio limit -> crop top/bottom
        srcHeight = sourceWidth / targetRatio;
        srcY = (sourceHeight - srcHeight) / 2;
    }

    return {
        srcX,
        srcY,
        srcWidth,
        srcHeight,
        destX: 0,
        destY: 0,
        destWidth: targetWidth,
        destHeight: targetHeight
    };
}
