// js/imageEngine.js
import { calculateSmartFit } from './smartCardFit.js';

/**
 * Loads an image file into an <img> via an Object URL (memory-safe: no giant
 * base64 string held in memory like FileReader.readAsDataURL would produce),
 * fits it into the target canvas with zero distortion, and always revokes
 * the Object URL afterwards — success or failure — to avoid leaking memory
 * across repeated uploads (important on iOS Safari where WebKit is stingy
 * with canvas/image memory).
 */
export function processImageFile(file, canvas, targetWidth, targetHeight) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('File is not a recognized image type.'));
            return;
        }

        let objectUrl;
        try {
            objectUrl = URL.createObjectURL(file);
        } catch (err) {
            reject(new Error('Unable to create a local preview URL for this image.'));
            return;
        }

        const img = new Image();

        const cleanup = () => {
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
            }
        };

        img.onload = function () {
            try {
                if (!img.naturalWidth || !img.naturalHeight) {
                    throw new Error('Image decoded to zero dimensions.');
                }

                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d', { alpha: false });

                // Clear out transparency artifacts safely (cards are always
                // printed on an opaque white background).
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, targetWidth, targetHeight);

                const fit = calculateSmartFit(img.naturalWidth, img.naturalHeight, targetWidth, targetHeight);

                ctx.drawImage(
                    img,
                    fit.srcX, fit.srcY, fit.srcWidth, fit.srcHeight,
                    fit.destX, fit.destY, fit.destWidth, fit.destHeight
                );

                cleanup();
                resolve();
            } catch (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error('Failed to draw image onto canvas.'));
            }
        };

        img.onerror = () => {
            cleanup();
            // Safari/iOS report HEIC/HEIF images as image/jpeg or image/* in some
            // pickers but fail to decode via <img>; give the user an actionable hint.
            if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) {
                reject(new Error('HEIC/HEIF photos are not supported by the browser decoder. Please use JPG or PNG.'));
            } else {
                reject(new Error('Failed to decode image file. The file may be corrupted or in an unsupported format.'));
            }
        };

        img.decoding = 'async';
        img.src = objectUrl;
    });
}
