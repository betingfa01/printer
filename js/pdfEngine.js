// js/pdfEngine.js
import { calculateSmartFit } from './smartCardFit.js';

// PDF.js renders at a baseline of 72 CSS points per inch when scale = 1.
// To get a true 300 DPI raster, we must scale by (targetDPI / 72).
const PDF_BASE_DPI = 72;
const TARGET_RENDER_DPI = 300;
const PDF_SCALE_FOR_300_DPI = TARGET_RENDER_DPI / PDF_BASE_DPI; // ≈ 4.1667

// Guard against pathological PDFs (huge page sizes) blowing up canvas memory,
// which is a common iOS Safari crash (canvas area limit ~16,777,216 px on
// some WebKit versions, and total memory limits regardless of that cap).
const MAX_RENDER_CANVAS_AREA = 16_000_000; // ~16 megapixels, safely under iOS limits

// The classic pdf.js build (pdf.min.js, loaded in index.html) auto-detects
// its own worker script via document.currentScript when
// GlobalWorkerOptions.workerSrc isn't set explicitly, but that fallback path
// is deprecated and logs a console warning on every single PDF processed.
// Configuring it explicitly here points at the exact same CDN file
// (already precached by sw.js) so behavior is unchanged, just warning-free.
const PDF_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
function ensurePdfWorkerConfigured() {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    }
}

export async function processPdfFile(file, canvas, targetWidth, targetHeight) {
    if (!file || file.type !== 'application/pdf') {
        throw new Error('Dosya bir PDF belgesi değil.');
    }
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF motoru yüklenemedi. Bağlantınızı kontrol edip uygulamayı yeniden yükleyin.');
    }
    ensurePdfWorkerConfigured();

    const arrayBuffer = await file.arrayBuffer();

    let pdf;
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        pdf = await loadingTask.promise;
    } catch (err) {
        throw new Error('Bu PDF okunamadı. Dosya bozuk, şifrelenmiş veya parola korumalı olabilir.');
    }

    let renderCanvas;
    try {
        if (pdf.numPages < 1) {
            throw new Error('Bu PDF\'de görüntülenecek sayfa yok.');
        }

        const page = await pdf.getPage(1);

        // Compute the true 300 DPI viewport first.
        let viewport = page.getViewport({ scale: PDF_SCALE_FOR_300_DPI });

        // If that would exceed a safe canvas memory budget (huge page sizes,
        // e.g. an A0 poster mistakenly uploaded), scale down proportionally
        // rather than crashing the tab — this keeps mobile Safari stable.
        const requestedArea = viewport.width * viewport.height;
        if (requestedArea > MAX_RENDER_CANVAS_AREA) {
            const shrink = Math.sqrt(MAX_RENDER_CANVAS_AREA / requestedArea);
            viewport = page.getViewport({ scale: PDF_SCALE_FOR_300_DPI * shrink });
        }

        renderCanvas = document.createElement('canvas');
        renderCanvas.width = Math.max(1, Math.round(viewport.width));
        renderCanvas.height = Math.max(1, Math.round(viewport.height));
        const renderCtx = renderCanvas.getContext('2d', { alpha: false });

        renderCtx.fillStyle = '#FFFFFF';
        renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({
            canvasContext: renderCtx,
            viewport: viewport
        }).promise;

        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetWidth, targetHeight);

        const fit = calculateSmartFit(renderCanvas.width, renderCanvas.height, targetWidth, targetHeight);

        ctx.drawImage(
            renderCanvas,
            fit.srcX, fit.srcY, fit.srcWidth, fit.srcHeight,
            fit.destX, fit.destY, fit.destWidth, fit.destHeight
        );

        // Release the page's internal resources explicitly — pdf.js keeps
        // decoded font/image data around otherwise, which adds up across
        // repeated uploads to the same slot.
        page.cleanup();
    } finally {
        // Detach the intermediate canvas's backing store as early as possible.
        // Setting width/height to 0 forces browsers to release the pixel buffer
        // immediately rather than waiting for GC — meaningful on memory-constrained
        // mobile devices when rendering at 300 DPI (large pixel buffers).
        if (renderCanvas) {
            renderCanvas.width = 0;
            renderCanvas.height = 0;
        }
        if (pdf) {
            try {
                await pdf.destroy();
            } catch (_) {
                // destroy() failures are non-fatal; the document is being discarded anyway.
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Print-quality path (added — does not alter processPdfFile or its preview
// behavior above in any way). Used only by printEngine.js at the moment the
// user actually prints, so the on-screen preview canvas stays exactly as
// small/cheap as before while the print output gets a genuinely higher-
// resolution render straight from the original PDF.
// ---------------------------------------------------------------------------

// True 600 DPI target for the ID-1 card: 84.60mm/52.98mm (85.60/53.98 reduced
// 1mm per dimension) converted at 600 DPI. Exported so printEngine.js uses
// the exact same numbers for both the PDF and image print paths (single
// source of truth).
export const PRINT_TARGET_WIDTH_PX = 1998;
export const PRINT_TARGET_HEIGHT_PX = 1252;

const PRINT_CARD_RATIO_W = 84.60;
const PRINT_CARD_RATIO_H = 52.98;

// A one-time, user-initiated print action can afford a much larger safety
// ceiling than the always-possible preview render above — this is only ever
// reached by unusually large source pages (e.g. a full poster PDF), not by
// normal ID/letter/A4-sized documents at 600 DPI.
const PRINT_MAX_RENDER_AREA = 40_000_000; // ~40 megapixels

/**
 * Renders page 1 of a PDF directly at true print resolution (600 DPI by
 * default) for the exact ID-1 card region, and returns a standalone canvas
 * (not tied to any on-screen element) ready to be encoded for printing.
 *
 * Unlike the preview path, this does not render the whole page at a blind
 * scale factor and then crop away the unused portion — it first determines
 * which page dimension the ID-1 crop leaves untouched, and renders at
 * exactly the scale needed for that untouched dimension to land at the
 * requested pixel target. This means a full A4/Letter page never gets
 * rendered at multiples of its actually-needed resolution, keeping memory
 * use tightly bounded to what will actually be printed while still hitting
 * true 600 DPI in the card region itself.
 */
export async function renderPdfForPrint(file, targetWidthPx = PRINT_TARGET_WIDTH_PX, targetHeightPx = PRINT_TARGET_HEIGHT_PX) {
    if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || ''))) {
        throw new Error('Dosya bir PDF belgesi değil.');
    }
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF motoru yüklenemedi. Bağlantınızı kontrol edip uygulamayı yeniden yükleyin.');
    }
    ensurePdfWorkerConfigured();

    const arrayBuffer = await file.arrayBuffer();

    let pdf;
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        pdf = await loadingTask.promise;
    } catch (err) {
        throw new Error('Bu PDF okunamadı. Dosya bozuk, şifrelenmiş veya parola korumalı olabilir.');
    }

    let renderCanvas;
    try {
        if (pdf.numPages < 1) {
            throw new Error('Bu PDF\'de görüntülenecek sayfa yok.');
        }

        const page = await pdf.getPage(1);

        // Page size in points (1 unit = 1/72in) — the same baseline used by
        // the preview renderer above, via getViewport({ scale: 1 }).
        const baseViewport = page.getViewport({ scale: 1 });
        const pageWidthPts = baseViewport.width;
        const pageHeightPts = baseViewport.height;

        // Reuse the app's single centered-crop implementation to find out
        // which dimension the ID-1 aspect ratio leaves fully intact — only
        // the ratio between the two "target" numbers matters here, so the
        // physical mm constants double as a stand-in for pixels.
        const cropAtScale1 = calculateSmartFit(pageWidthPts, pageHeightPts, PRINT_CARD_RATIO_W, PRINT_CARD_RATIO_H);
        const heightIsUnclipped = cropAtScale1.srcHeight >= pageHeightPts - 0.001;

        let scale = heightIsUnclipped
            ? targetHeightPx / pageHeightPts
            : targetWidthPx / pageWidthPts;

        let finalWidthPx = targetWidthPx;
        let finalHeightPx = targetHeightPx;

        // Safety cap for pathological page sizes — shrink proportionally so
        // memory-limited devices never crash; ordinary document sizes never
        // come close to triggering this.
        const requestedArea = (pageWidthPts * scale) * (pageHeightPts * scale);
        if (requestedArea > PRINT_MAX_RENDER_AREA) {
            const shrink = Math.sqrt(PRINT_MAX_RENDER_AREA / requestedArea);
            scale *= shrink;
            finalWidthPx = Math.max(1, Math.round(targetWidthPx * shrink));
            finalHeightPx = Math.max(1, Math.round(targetHeightPx * shrink));
        }

        const viewport = page.getViewport({ scale });

        renderCanvas = document.createElement('canvas');
        renderCanvas.width = Math.max(1, Math.round(viewport.width));
        renderCanvas.height = Math.max(1, Math.round(viewport.height));
        const renderCtx = renderCanvas.getContext('2d', { alpha: false });
        renderCtx.imageSmoothingEnabled = true;
        renderCtx.imageSmoothingQuality = 'high';
        renderCtx.fillStyle = '#FFFFFF';
        renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({
            canvasContext: renderCtx,
            viewport: viewport
        }).promise;

        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = finalWidthPx;
        finalCanvas.height = finalHeightPx;
        const finalCtx = finalCanvas.getContext('2d', { alpha: false });
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.fillStyle = '#FFFFFF';
        finalCtx.fillRect(0, 0, finalWidthPx, finalHeightPx);

        // Because `scale` above was chosen so the untouched dimension already
        // lands exactly on the target, this crop is a near-exact 1:1 copy in
        // the common case — not a second lossy downsample on top of the render.
        const fit = calculateSmartFit(renderCanvas.width, renderCanvas.height, finalWidthPx, finalHeightPx);
        finalCtx.drawImage(
            renderCanvas,
            fit.srcX, fit.srcY, fit.srcWidth, fit.srcHeight,
            fit.destX, fit.destY, fit.destWidth, fit.destHeight
        );

        page.cleanup();
        return finalCanvas;
    } finally {
        if (renderCanvas) {
            renderCanvas.width = 0;
            renderCanvas.height = 0;
        }
        if (pdf) {
            try {
                await pdf.destroy();
            } catch (_) {
                // Non-fatal — the document is being discarded anyway.
            }
        }
    }
}
