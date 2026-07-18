// js/app.js
import { processImageFile } from './imageEngine.js';
import { processPdfFile } from './pdfEngine.js';
import { executePrintWorkflow } from './printEngine.js';

// Global execution metrics constraints mapping to high performance 300 DPI limits.
// 84.60mm / 25.4mm per inch * 300 DPI = 999.2126... -> 999 pixels width
// 52.98mm / 25.4mm per inch * 300 DPI = 625.7480... -> 626 pixels height
const TARGET_DPI_WIDTH = 999;
const TARGET_DPI_HEIGHT = 626;

const ACCEPTED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
const ACCEPTED_EXTENSIONS = /\.(pdf|jpe?g|png)$/i;

const state = {
    // sourceFile retains the original, untouched upload (never downscaled or
    // recompressed) purely so the print engine can render it at full/print
    // resolution later. It does not change the preview, UI, or workflow in
    // any way — the preview canvas below is still what's ever shown on screen.
    slot1: { hasImage: false, canvas: null, isProcessing: false, sourceFile: null },
    slot2: { hasImage: false, canvas: null, isProcessing: false, sourceFile: null }
};

let isPrinting = false;
let toastTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    state.slot1.canvas = document.getElementById('canvas-1');
    state.slot2.canvas = document.getElementById('canvas-2');

    setupSlotEventListeners(1);
    setupSlotEventListeners(2);
    setupControlPanelListeners();
    setupNetworkStatusTracker();
    registerServiceWorker();
});

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Resolve relative to the document so this keeps working when the app is
    // deployed under a GitHub Pages subpath (e.g. https://user.github.io/repo/).
    const swUrl = new URL('sw.js', document.baseURI).href;

    window.addEventListener('load', () => {
        navigator.serviceWorker.register(swUrl).then((registration) => {
            // Automatic update strategy: whenever a new SW finishes installing,
            // activate it immediately (it calls skipWaiting/clients.claim itself)
            // and reload once so the user always runs the latest cached assets.
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                if (!newWorker) return;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'activated') {
                        showToast('Uygulama güncellendi. En son sürüm için sayfayı yenileyin.', 'info');
                    }
                });
            });
        }).catch(() => {
            // Offline-first apps must not break if SW registration fails
            // (e.g. private browsing mode) — the app still works, just without
            // the offline cache.
        });
    });

    let refreshingFromSw = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshingFromSw) return;
        refreshingFromSw = true;
        window.location.reload();
    });
}

function setupSlotEventListeners(slotId) {
    const cardSlot = document.getElementById(`slot-${slotId}`);
    const dropzone = document.getElementById(`dropzone-${slotId}`);
    const fileInput = document.getElementById(`file-${slotId}`);
    const clearBtn = document.getElementById(`clear-${slotId}`);

    const openFileBrowser = () => {
        if (state[`slot${slotId}`].isProcessing) return;
        fileInput.click();
    };

    dropzone.addEventListener('click', (e) => {
        if (e.target.closest('.clear-btn')) return;
        openFileBrowser();
    });

    // Keyboard accessibility: Enter/Space activates the drop zone like a click,
    // since it's exposed as role="button" with tabindex="0".
    dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            openFileBrowser();
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleIncomingFile(e.target.files[0], slotId);
        }
    });

    // Drag and Drop capture handlers.
    // dragenter/dragover must both preventDefault or the browser will refuse
    // the drop and open the file directly in the tab instead (a very common
    // "drag & drop doesn't work" bug).
    let dragDepth = 0;

    cardSlot.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragDepth++;
        dropzone.classList.add('dragover');
    });

    cardSlot.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    cardSlot.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            dropzone.classList.remove('dragover');
        }
    });

    cardSlot.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleIncomingFile(e.dataTransfer.files[0], slotId);
        }
    });

    // Clipboard paste support, scoped correctly: only acts when this specific
    // slot (or an element inside it) currently has focus, so pasting doesn't
    // ambiguously target the wrong slot when nothing is focused.
    cardSlot.addEventListener('paste', (e) => {
        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData) return;
        const items = clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.kind === 'file') {
                const pastedFile = item.getAsFile();
                if (pastedFile) {
                    e.preventDefault();
                    handleIncomingFile(pastedFile, slotId);
                }
                break;
            }
        }
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetSlotState(slotId);
    });
}

function isAcceptedFile(file) {
    if (ACCEPTED_MIME_TYPES.has(file.type)) return true;
    // Some mobile browsers (notably iOS Safari for camera-captured or
    // iCloud-synced files) report an empty or generic MIME type; fall back
    // to checking the file extension so valid uploads aren't silently rejected.
    if (!file.type && file.name && ACCEPTED_EXTENSIONS.test(file.name)) return true;
    return false;
}

async function handleIncomingFile(file, slotId) {
    const slotState = state[`slot${slotId}`];
    if (slotState.isProcessing) return;

    const dropzone = document.getElementById(`dropzone-${slotId}`);
    const canvas = document.getElementById(`canvas-${slotId}`);
    const clearBtn = document.getElementById(`clear-${slotId}`);
    const spinner = document.getElementById(`spinner-${slotId}`);
    const errorEl = document.getElementById(`error-${slotId}`);

    clearSlotError(slotId);

    if (!file || !isAcceptedFile(file)) {
        setSlotError(slotId, 'Desteklenmeyen dosya türü. Lütfen bir PDF, JPG veya PNG dosyası kullanın.');
        return;
    }

    const MAX_FILE_SIZE = 60 * 1024 * 1024; // 60MB safety ceiling for mobile memory
    if (file.size > MAX_FILE_SIZE) {
        setSlotError(slotId, 'Dosya çok büyük. Lütfen 60MB\'tan küçük bir dosya kullanın.');
        return;
    }

    slotState.isProcessing = true;
    spinner.hidden = false;
    clearBtn.disabled = true;

    try {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        if (isPdf) {
            await processPdfFile(file, canvas, TARGET_DPI_WIDTH, TARGET_DPI_HEIGHT);
        } else {
            await processImageFile(file, canvas, TARGET_DPI_WIDTH, TARGET_DPI_HEIGHT);
        }

        slotState.hasImage = true;
        slotState.sourceFile = file;
        dropzone.classList.add('has-image');
        canvas.hidden = false;
        clearBtn.disabled = false;
    } catch (err) {
        resetSlotState(slotId, { silent: true });
        setSlotError(slotId, err && err.message ? err.message : 'Bu dosya işlenemedi. Lütfen başka bir dosya deneyin.');
    } finally {
        slotState.isProcessing = false;
        spinner.hidden = true;
        evaluatePrintActionState();
    }
}

function setSlotError(slotId, message) {
    const errorEl = document.getElementById(`error-${slotId}`);
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
}

function clearSlotError(slotId) {
    const errorEl = document.getElementById(`error-${slotId}`);
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
}

function resetSlotState(slotId, options = {}) {
    const dropzone = document.getElementById(`dropzone-${slotId}`);
    const canvas = document.getElementById(`canvas-${slotId}`);
    const clearBtn = document.getElementById(`clear-${slotId}`);
    const fileInput = document.getElementById(`file-${slotId}`);
    const spinner = document.getElementById(`spinner-${slotId}`);

    fileInput.value = '';
    state[`slot${slotId}`].hasImage = false;
    state[`slot${slotId}`].sourceFile = null;
    dropzone.classList.remove('has-image');
    canvas.hidden = true;
    clearBtn.disabled = true;
    if (spinner) spinner.hidden = true;

    const ctx = canvas.getContext('2d');
    if (canvas.width && canvas.height) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    // Release the backing pixel buffer rather than leaving a full-resolution
    // 300 DPI canvas allocated in memory while idle.
    canvas.width = 0;
    canvas.height = 0;

    if (!options.silent) {
        clearSlotError(slotId);
    }

    evaluatePrintActionState();
}

function evaluatePrintActionState() {
    const printActionBtn = document.getElementById('printActionBtn');
    const anyCardReady = state.slot1.hasImage || state.slot2.hasImage;
    const anyProcessing = state.slot1.isProcessing || state.slot2.isProcessing;
    printActionBtn.disabled = !anyCardReady || anyProcessing || isPrinting;
}

function setupControlPanelListeners() {
    const printActionBtn = document.getElementById('printActionBtn');
    const printModal = document.getElementById('printModal');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const modalConfirmPrintBtn = document.getElementById('modalConfirmPrintBtn');
    const paperSizeSelect = document.getElementById('paperSizeSelect');
    const iframePrintFrame = document.getElementById('printContainerIframe');

    const closeModal = () => {
        printModal.setAttribute('hidden', 'true');
    };

    printActionBtn.addEventListener('click', () => {
        printModal.removeAttribute('hidden');
    });

    modalCancelBtn.addEventListener('click', closeModal);

    // Hide on overlay (backdrop) click, but not on clicks inside the card itself.
    printModal.addEventListener('click', (e) => {
        if (e.target === printModal) {
            closeModal();
        }
    });

    // Escape key closes the modal.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !printModal.hidden) {
            closeModal();
        }
    });

    modalConfirmPrintBtn.addEventListener('click', async () => {
        if (isPrinting) return;
        isPrinting = true;
        modalConfirmPrintBtn.disabled = true;
        evaluatePrintActionState();

        try {
            await executePrintWorkflow(
                state.slot1.canvas,
                state.slot2.canvas,
                state.slot1.hasImage,
                state.slot2.hasImage,
                paperSizeSelect.value,
                iframePrintFrame,
                state.slot1.sourceFile,
                state.slot2.sourceFile
            );
            closeModal();
        } catch (err) {
            showToast(err && err.message ? err.message : 'Yazdırma başarısız oldu. Lütfen tekrar deneyin.', 'error');
        } finally {
            isPrinting = false;
            modalConfirmPrintBtn.disabled = false;
            evaluatePrintActionState();
        }
    });
}

function setupNetworkStatusTracker() {
    const offlineBadge = document.getElementById('offlineBadge');
    const updateStatus = () => {
        offlineBadge.hidden = navigator.onLine;
    };
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('appToast');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.toggle('error', type === 'error');
    toast.hidden = false;

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.hidden = true;
    }, 4000);
}
