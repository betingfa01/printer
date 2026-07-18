// js/printEngine.js
import { calculateSmartFit } from './smartCardFit.js';
import { renderPdfForPrint, PRINT_TARGET_WIDTH_PX, PRINT_TARGET_HEIGHT_PX } from './pdfEngine.js';

/**
 * Print Engine.
 *
 * Public API is unchanged in shape and fully backward compatible:
 * executePrintWorkflow(canvas1, canvas2, hasCard1, hasCard2, paperSize,
 * iframeElement, sourceFile1?, sourceFile2?). The two trailing sourceFile
 * arguments are new and optional — if omitted, this falls back to the exact
 * previous behavior (encoding the existing preview canvases). Upload,
 * preview, layout, dimensions, and every other UI/module are untouched.
 *
 * ROOT CAUSE of "everything works except printing" (kept from the previous
 * fix — still required, unrelated to print quality):
 * The print iframe in index.html is defined with inline style
 * `display:none; visibility:hidden; ...`. A number of browsers — notably
 * Firefox and Safari on macOS, and some Chromium builds on Windows — never
 * lay out or paint the contents of a `display:none` iframe, so
 * `iframe.contentWindow.print()` silently prints a blank page. This file
 * temporarily overrides the iframe to `display:block` (while remaining
 * fully invisible via visibility:hidden + off-screen position) only for the
 * duration of a print run, then restores the original inline style exactly
 * as authored in index.html.
 *
 * PRINT QUALITY IMPROVEMENTS in this revision:
 *
 *  1. PDFs are re-rendered directly from the original file at true 600 DPI
 *     (via pdfEngine.js's renderPdfForPrint), instead of reusing the ~300 DPI
 *     preview canvas. The preview canvas is left completely alone — this is
 *     an entirely separate, print-time-only render.
 *
 *  2. JPG/PNG images are re-read from the original uploaded file (never the
 *     small downscaled preview canvas) and cropped to the ID-1 aspect ratio
 *     at NATIVE resolution. In the overwhelmingly common case this is a
 *     literal 1:1 pixel copy of the crop region — no resampling at all — so
 *     every source pixel the printer can use is preserved. A resample only
 *     ever happens, and only ever downward, if the crop region exceeds a
 *     generous 24-megapixel safety ceiling (protects low-memory devices
 *     against pathologically large source photos); it never upscales.
 *
 *  3. Every canvas operation that DOES resample (the PDF render and the rare
 *     oversized-image case) explicitly sets `imageSmoothingEnabled = true`
 *     and `imageSmoothingQuality = 'high'` so any unavoidable resampling
 *     uses the best available interpolation instead of the browser default.
 *
 *  4. Output is still always encoded as PNG (lossless raster), never
 *     re-encoded as JPEG — so no generational compression artifacts are
 *     introduced on top of whatever the original file already had, no
 *     matter how many times a card is re-printed.
 *
 *  5. If no source file is available for a slot for any reason (defensive
 *     fallback only — should not happen in normal use), this transparently
 *     falls back to the previous behavior of printing the existing preview
 *     canvas, so printing never breaks.
 *
 * PRESERVED from the previous fix (unchanged):
 *  - Valid, cross-engine-safe @page rules (no length+orientation keyword
 *    combination).
 *  - `print-color-adjust: exact` so browsers don't auto-lighten print colors.
 *  - about:blank priming before document.write() to avoid InvalidStateError.
 *  - `afterprint` listened for on both the iframe window and the top window.
 *  - Full cleanup (Object URLs, iframe document, iframe inline style) in a
 *    `finally` block regardless of success, failure, or cancellation.
 */

// 84.60mm x 52.98mm — ISO/IEC 7810 ID-1 card size (85.60mm x 53.98mm) reduced
// by 1mm on each dimension for print tolerance. Single source of truth for
// physical output dimensions, used for both @page sizing and the printed
// <img> dimensions so the two can never drift apart.
const CARD_WIDTH_MM = 84.60;
const CARD_HEIGHT_MM = 52.98;

const IMAGE_LOAD_TIMEOUT_MS = 2500;
const AFTERPRINT_SAFETY_TIMEOUT_MS = 5000;

// Generous safety ceiling for the native-resolution image crop. An ID-1 card
// at true 600 DPI is only ~2.58 megapixels, so 24MP is nearly 10x that —
// virtually every consumer/phone photo's crop region stays under this, and
// is therefore never resampled at all. Only extreme outliers (50MP+ camera
// output) ever trigger the single high-quality downscale below.
const IMAGE_PRINT_MAX_AREA = 24_000_000;

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        if (!canvas || !canvas.width || !canvas.height) {
            reject(new Error('Card canvas is empty and cannot be printed.'));
            return;
        }
        if (typeof canvas.toBlob !== 'function') {
            // Extremely old browser fallback (no browser this app targets
            // should actually hit this path).
            try {
                resolve(dataURLToBlobSync(canvas.toDataURL('image/png')));
            } catch (err) {
                reject(err);
            }
            return;
        }
        // 'image/png' is a lossless raster encode — this never recompresses
        // or introduces new artifacts beyond what's already decoded into the
        // canvas, unlike re-encoding to JPEG would.
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error('Failed to encode card canvas for printing.'));
            }
        }, 'image/png');
    });
}

function dataURLToBlobSync(dataUrl) {
    const [meta, base64] = dataUrl.split(',');
    const mime = /data:(.*?);base64/.exec(meta)[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

function isPdfFile(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        let objectUrl;
        try {
            objectUrl = URL.createObjectURL(file);
        } catch (err) {
            reject(new Error('Unable to read this image file for printing.'));
            return;
        }
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to decode image file for printing.'));
        };
        img.decoding = 'async';
        img.src = objectUrl;
    });
}

/**
 * Crops the original image file to the ID-1 aspect ratio at native
 * resolution and returns a standalone canvas ready for print encoding.
 * Preserves every source pixel (no resampling) unless the crop region
 * exceeds IMAGE_PRINT_MAX_AREA, in which case a single high-quality
 * downscale is applied — never an upscale, and never more than needed to
 * fit the safety ceiling.
 */
async function renderImageForPrint(file) {
    const img = await loadImageElement(file);
    if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error('Image has no visible content to print.');
    }

    // Same centered-crop math used everywhere else in the app, applied here
    // directly against the image's full native resolution instead of the
    // small preview canvas — crops only as much as the ID-1 ratio requires.
    const crop = calculateSmartFit(img.naturalWidth, img.naturalHeight, CARD_WIDTH_MM, CARD_HEIGHT_MM);
    const cropArea = crop.srcWidth * crop.srcHeight;

    let outWidth = Math.max(1, Math.round(crop.srcWidth));
    let outHeight = Math.max(1, Math.round(crop.srcHeight));

    if (cropArea > IMAGE_PRINT_MAX_AREA) {
        const shrink = Math.sqrt(IMAGE_PRINT_MAX_AREA / cropArea);
        outWidth = Math.max(1, Math.round(crop.srcWidth * shrink));
        outHeight = Math.max(1, Math.round(crop.srcHeight * shrink));
    }

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.drawImage(
        img,
        crop.srcX, crop.srcY, crop.srcWidth, crop.srcHeight,
        0, 0, outWidth, outHeight
    );
    return canvas;
}

/** Frees a transient canvas's backing pixel buffer as soon as it's no longer needed. */
function releaseCanvas(canvas) {
    if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
    }
}

/**
 * Produces the highest-quality print Blob available for a slot: renders
 * from the original source file (600 DPI for PDFs, native resolution for
 * images) when present, otherwise falls back to encoding the existing
 * preview canvas so printing never breaks.
 */
async function getCardBlobForSlot(previewCanvas, sourceFile) {
    if (!sourceFile) {
        return canvasToBlob(previewCanvas);
    }

    let printCanvas;
    try {
        printCanvas = isPdfFile(sourceFile)
            ? await renderPdfForPrint(sourceFile, PRINT_TARGET_WIDTH_PX, PRINT_TARGET_HEIGHT_PX)
            : await renderImageForPrint(sourceFile);
        return await canvasToBlob(printCanvas);
    } catch (err) {
        // Never let a high-quality-path failure block printing entirely —
        // fall back to the already-known-good preview canvas.
        return canvasToBlob(previewCanvas);
    } finally {
        releaseCanvas(printCanvas);
    }
}

/**
 * Builds the @page + layout CSS for the chosen physical sheet. Card size
 * itself is always the fixed ISO ID-1 constants above — only the sheet
 * size and card arrangement (row vs. column) change between layouts.
 */
function buildLayoutCss(paperSize) {
    if (paperSize === 'photo10x15') {
        // 10 x 15 cm photo paper: cards stacked vertically, centered.
        // No orientation keyword combined with explicit lengths — 100mm
        // width / 150mm height already reads as portrait.
        return `
            @page { size: 100mm 150mm; margin: 0; }
            html, body { width: 100mm; height: 150mm; }
            body { display: flex; justify-content: center; align-items: center; margin: 0; background: #ffffff; }
            .print-container { display: flex; flex-direction: column; gap: 8mm; justify-content: center; align-items: center; width: 100%; }
        `;
    }
    // A4: cards side by side horizontally, centered. `size: A4;` alone is
    // portrait by default and is the most broadly honored form across
    // Chrome, Firefox, and Safari on both macOS and Windows print pipelines.
    return `
        @page { size: A4; margin: 0; }
        html, body { width: 210mm; height: 297mm; }
        body { display: flex; justify-content: center; align-items: center; margin: 0; background: #ffffff; }
        .print-container { display: flex; flex-direction: row; gap: 10mm; justify-content: center; align-items: center; width: 100%; }
    `;
}

/** Waits for the iframe to reach a stable about:blank document we can safely document.write() into. */
function primeIframe(iframeElement) {
    return new Promise((resolve, reject) => {
        const win = iframeElement.contentWindow;
        if (!win) {
            reject(new Error('Print frame is not available.'));
            return;
        }

        try {
            const readyState = win.document.readyState;
            const isBlank = win.document.location && win.document.location.href === 'about:blank';
            if (readyState === 'complete' && isBlank) {
                resolve();
                return;
            }
        } catch (_) {
            // Fall through to explicit navigation below.
        }

        const onLoad = () => {
            iframeElement.removeEventListener('load', onLoad);
            resolve();
        };
        iframeElement.addEventListener('load', onLoad);
        iframeElement.src = 'about:blank';

        setTimeout(resolve, 300);
    });
}

/**
 * Temporarily overrides the iframe's inline style so its document actually
 * renders (required for printing), while remaining fully invisible and
 * inert. Returns a restore function that puts the original inline style
 * back exactly as authored in index.html.
 */
function makeIframePrintable(iframeElement) {
    const originalStyleAttr = iframeElement.getAttribute('style') || '';

    iframeElement.style.display = 'block';
    iframeElement.style.visibility = 'hidden';
    iframeElement.style.position = 'fixed';
    iframeElement.style.top = '0';
    iframeElement.style.left = '-10000px';
    iframeElement.style.width = '0';
    iframeElement.style.height = '0';
    iframeElement.style.border = '0';
    iframeElement.style.pointerEvents = 'none';

    return () => {
        if (originalStyleAttr) {
            iframeElement.setAttribute('style', originalStyleAttr);
        } else {
            iframeElement.removeAttribute('style');
        }
    };
}

export async function executePrintWorkflow(canvas1, canvas2, hasCard1, hasCard2, paperSize, iframeElement, sourceFile1 = null, sourceFile2 = null) {
    if (!hasCard1 && !hasCard2) {
        throw new Error('No cards to print.');
    }
    if (!iframeElement) {
        throw new Error('Print frame is missing from the page.');
    }

    const objectUrls = [];
    const cleanupUrls = () => {
        while (objectUrls.length) {
            URL.revokeObjectURL(objectUrls.pop());
        }
    };

    const restoreIframeStyle = makeIframePrintable(iframeElement);

    try {
        await primeIframe(iframeElement);

        const src1 = hasCard1 ? URL.createObjectURL(await getCardBlobForSlot(canvas1, sourceFile1)) : null;
        const src2 = hasCard2 ? URL.createObjectURL(await getCardBlobForSlot(canvas2, sourceFile2)) : null;
        if (src1) objectUrls.push(src1);
        if (src2) objectUrls.push(src2);

        const pageCss = buildLayoutCss(paperSize === 'photo10x15' ? 'photo10x15' : 'a4');

        // object-fit: contain never crops and never distorts further — the
        // print-time renders above are already exactly the ID-1 aspect
        // ratio, so this is a straight, uniform scale to physical card size.
        const cardImgStyle = `width:${CARD_WIDTH_MM}mm;height:${CARD_HEIGHT_MM}mm;object-fit:contain;display:block;` +
            `-webkit-print-color-adjust:exact;print-color-adjust:exact;`;

        let layoutHtml = '<div class="print-container">';
        if (src1) {
            layoutHtml += `<img class="print-card" data-role="card" src="${src1}" style="${cardImgStyle}" alt="Card 1" />`;
        }
        if (src2) {
            layoutHtml += `<img class="print-card" data-role="card" src="${src2}" style="${cardImgStyle}" alt="Card 2" />`;
        }
        layoutHtml += '</div>';

        const doc = iframeElement.contentWindow.document;
        doc.open();
        doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
${pageCss}
</style>
</head>
<body>
${layoutHtml}
</body>
</html>`);
        doc.close();

        // Wait until every injected <img> has actually decoded before
        // calling print() — guards against blank/partial cards, especially
        // now that print-resolution images can be substantially larger and
        // take a little longer to decode than the old preview-sized ones.
        const iframeImages = Array.from(doc.querySelectorAll('img[data-role="card"]'));
        await Promise.race([
            Promise.all(iframeImages.map((imgEl) => {
                if (imgEl.complete && imgEl.naturalWidth > 0) return Promise.resolve();
                return new Promise((resolve) => {
                    imgEl.addEventListener('load', resolve, { once: true });
                    imgEl.addEventListener('error', resolve, { once: true });
                });
            })),
            new Promise((resolve) => setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS))
        ]);

        // One extra paint frame so the just-written layout is fully committed
        // before the print pipeline captures it.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const iframeWindow = iframeElement.contentWindow;

        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                try { iframeWindow.removeEventListener('afterprint', finish); } catch (_) {}
                try { window.removeEventListener('afterprint', finish); } catch (_) {}
                resolve();
            };

            // Chrome/Edge fire `afterprint` on the iframe's own window; Safari
            // on macOS fires it on the top-level window instead when print()
            // was invoked on a child frame. Listen on both.
            iframeWindow.addEventListener('afterprint', finish);
            window.addEventListener('afterprint', finish);

            // Safety net for browsers/OS combinations that don't reliably
            // fire afterprint for a child-frame print job at all.
            setTimeout(finish, AFTERPRINT_SAFETY_TIMEOUT_MS);

            // Focus both the frame element and its window — Safari on macOS
            // has been observed to print the wrong (top-level, empty) document
            // if the child frame doesn't explicitly hold focus first.
            iframeElement.focus();
            iframeWindow.focus();
            iframeWindow.print();
        });
    } finally {
        cleanupUrls();
        // Reset the iframe to a blank document so stale card content never
        // lingers for the next print run and its image memory can be reclaimed.
        try {
            const doc = iframeElement.contentWindow.document;
            doc.open();
            doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
            doc.close();
        } catch (_) {
            // Non-fatal — the iframe will simply be overwritten on next use.
        }
        // Always restore the iframe's original (hidden) inline style, even
        // if printing failed — the UI must end up exactly as it started.
        restoreIframeStyle();
    }
}
