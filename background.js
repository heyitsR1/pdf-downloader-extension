import { recordDownload, checkLicense, getFreeDownloadCount } from './licensing.js';

const FREE_LIMIT = 5;

// ── PDF detection ─────────────────────────────────────────────────────────────
// A request counts as a PDF if its *path* ends in .pdf, or if the response
// declares Content-Type: application/pdf. Host is irrelevant. Earlier builds
// only accepted signed S3 URLs (X-Amz-/amazonaws) — a leftover from the Whop
// build that missed every site serving PDFs from its own origin.
const VIEWER_NOISE = /pdf\.worker|pdfjs|\/viewer\.html/i;
const PDF_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'object', 'other'];
const ALL_HOSTS = ['https://*/*', 'http://*/*'];
const suppressedUrls = new Map();

function hasPdfPath(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch (_) {
    return false;
  }
}

// Path-based check. Deliberately stricter than the old url.includes('pdf'):
// without the S3 gate that matched /pdfjs-latest/web/viewer.html and
// /assets/pdf-icon.svg too.
function isPdfCandidate(url) {
  return hasPdfPath(url) && !VIEWER_NOISE.test(url);
}

function contentType(headers) {
  return (headers || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
}

// ── Capture via webRequest (fires for non-cached requests) ───────────────────
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode !== 200) return;
    if (!isPdfCandidate(details.url)) return;

    storePdf(details.tabId, details.url);
  },
  { urls: ALL_HOSTS, types: PDF_TYPES }
);

// Fires earlier than onCompleted, so the button shows up while a large PDF is
// still transferring.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isPdfCandidate(details.url)) return;

    storePdf(details.tabId, details.url);
  },
  { urls: ALL_HOSTS, types: PDF_TYPES }
);

// Content-Type catch-all: PDFs served from any host with no .pdf in the path
// (e.g. /api/lesson/4821/file). Observational only — we never block.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.statusCode !== 200) return;
    if (VIEWER_NOISE.test(details.url)) return;
    if (!/^application\/(pdf|x-pdf)\b/i.test(contentType(details.responseHeaders).trim())) return;

    storePdf(details.tabId, details.url);
  },
  { urls: ALL_HOSTS, types: PDF_TYPES },
  ['responseHeaders']
);

// ── Store helper ──────────────────────────────────────────────────────────────
function isSuppressedUrl(url) {
  if (!url) return false;
  const at = suppressedUrls.get(url);
  if (!at) return false;
  if (Date.now() - at > 60000) {
    suppressedUrls.delete(url);
    return false;
  }
  return true;
}

function normalizeEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { kind: 'url', id: `url:${entry}`, url: entry };
  }
  if (entry.kind === 'memory') {
    if (!entry.id) return null;
    return {
      kind: 'memory',
      id: String(entry.id),
      label: entry.label || '',
      size: Number(entry.size) || 0,
    };
  }
  if (entry.url) {
    return { kind: 'url', id: `url:${entry.url}`, url: entry.url };
  }
  return null;
}

async function storePdf(tabId, rawEntry) {
  if (!tabId || tabId < 0) return;
  const entry = normalizeEntry(rawEntry);
  if (!entry) return;
  if (entry.kind === 'url' && isSuppressedUrl(entry.url)) return;
  const sourceUrl =
    rawEntry && typeof rawEntry === 'object' ? String(rawEntry.sourceUrl || '') : '';
  const key = `pdfs_tab_${tabId}`;
  try {
    const result = await chrome.storage.local.get([key]);
    let existing = (result[key] || []).map(normalizeEntry).filter(Boolean);
    if (entry.kind === 'memory' && sourceUrl) {
      suppressedUrls.set(sourceUrl, Date.now());
      const filtered = existing.filter((e) => e.id !== `url:${sourceUrl}` && e.url !== sourceUrl);
      if (filtered.length !== existing.length) {
        existing = filtered;
        await chrome.storage.local.set({ [key]: existing });
      }
    }
    const duplicate = existing.find(
      (e) => e.id === entry.id || (e.url && entry.url && e.url === entry.url)
    );
    if (duplicate) {
      if (entry.kind === 'memory' && entry.label && duplicate.label !== entry.label) {
        duplicate.label = entry.label;
        await chrome.storage.local.set({ [key]: existing });
        chrome.tabs
          .sendMessage(tabId, { type: 'PDF_CAPTURED', entry: duplicate, url: undefined })
          .catch(() => {});
      }
      return;
    }
    const updated = [...existing, entry];
    await chrome.storage.local.set({ [key]: updated });
  } catch (err) {
    console.error('[PDFDownloader] Storage error:', err);
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: 'PDF_CAPTURED', entry, url: entry.url }).catch(() => {});
}

// ── Clean up on tab close ────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([`pdfs_tab_${tabId}`]);
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STORE_PDF') {
    const tabId = sender.tab?.id;
    if (tabId && (msg.entry || msg.url)) storePdf(tabId, msg.entry || msg.url);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'REMOVE_PDF') {
    const tabId = sender.tab?.id;
    if (!tabId || !msg.id) {
      sendResponse({ ok: false });
      return;
    }
    (async () => {
      const key = `pdfs_tab_${tabId}`;
      try {
        const result = await chrome.storage.local.get([key]);
        const existing = (result[key] || []).map(normalizeEntry).filter(Boolean);
        const updated = existing.filter((e) => e.id !== msg.id);
        if (updated.length) {
          await chrome.storage.local.set({ [key]: updated });
        } else {
          await chrome.storage.local.remove([key]);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_BUFFER') {
    (async () => {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { type: 'GET_BUFFER', id: msg.id },
          { frameId: 0 }
        );
        sendResponse(res || { ok: false, error: 'no_response' });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_PDF') {
    // Derive a clean filename from URL or use generic
    let filename = msg.filename || 'document.pdf';
    if (!filename.endsWith('.pdf')) filename += '.pdf';

    (async () => {
      const { isPro } = await checkLicense();
      const used = await getFreeDownloadCount();
      if (!isPro && used >= FREE_LIMIT) {
        sendResponse({ ok: false, error: 'credits_exhausted' });
        // Resolve tab ID to show upgrade modal
        let tabId = sender.tab?.id;
        if (!tabId) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = activeTab?.id;
        }
        if (tabId) {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['modal.js'] });
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {
                type: 'SHOW_DOWNLOAD_MODAL',
                filename: '',
                isPro: false,
                used,
                remaining: 0,
                freeLimit: FREE_LIMIT,
                isLimitReached: true,
              }).catch(() => {});
            }, 150);
          } catch (_) {}
        }
        return;
      }

      try {
        const downloadId = await chrome.downloads.download({ url: msg.url, filename, saveAs: false });
        if (!isPro) {
          await recordDownload();
        }
        sendResponse({ ok: true, downloadId });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_BUFFER') {
    let filename = msg.filename || 'document.pdf';
    if (!filename.endsWith('.pdf')) filename += '.pdf';

    (async () => {
      const tabId = msg.tabId || sender.tab?.id;
      const { isPro } = await checkLicense();
      const used = await getFreeDownloadCount();

      if (!isPro && used >= FREE_LIMIT) {
        sendResponse({ ok: false, error: 'credits_exhausted' });
        if (tabId) {
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['modal.js'] });
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {
                type: 'SHOW_DOWNLOAD_MODAL',
                filename: '',
                isPro: false,
                used,
                remaining: 0,
                freeLimit: FREE_LIMIT,
                isLimitReached: true,
              }).catch(() => {});
            }, 150);
          } catch (_) {}
        }
        return;
      }

      if (!tabId) {
        sendResponse({ ok: false, error: 'no_tab' });
        return;
      }

      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          { type: 'TRIGGER_BUFFER_DOWNLOAD', id: msg.id, filename },
          { frameId: 0 }
        );
        if (!res?.ok) {
          sendResponse({ ok: false, error: res?.error || 'download_failed' });
          return;
        }
        if (!isPro) {
          await recordDownload();
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'RECORD_DOWNLOAD') {
    (async () => {
      try {
        await recordDownload();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_PDFS') {
    (async () => {
      try {
        const key = `pdfs_tab_${msg.tabId}`;
        const result = await chrome.storage.local.get([key]);
        const entries = (result[key] || []).map(normalizeEntry).filter(Boolean);
        const urls = entries.filter((e) => e.kind === 'url').map((e) => e.url);
        sendResponse({ entries, urls });
      } catch (err) {
        sendResponse({ entries: [], urls: [] });
      }
    })();
    return true;
  }

  if (msg.type === 'CLEAR_PDFS') {
    (async () => {
      try {
        await chrome.storage.local.remove([`pdfs_tab_${msg.tabId}`]);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_COMPLETE') {
    // Inject the post-download modal into the active tab
    (async () => {
      const { isPro } = await checkLicense();
      if (isPro) {
        sendResponse({ ok: true });
        return;
      }
      const used = await getFreeDownloadCount();
      const remaining = Math.max(0, FREE_LIMIT - used);

      try {
        let tabId = msg.tabId || sender.tab?.id;
        if (!tabId) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = activeTab?.id;
        }
        if (tabId) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['modal.js'],
          });
          // Small delay to let modal.js initialise
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
              type: 'SHOW_DOWNLOAD_MODAL',
              filename: msg.filename,
              isPro: isPro,
              used,
              remaining,
              freeLimit: FREE_LIMIT,
            }).catch(() => {});
          }, 150);
        }
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'SHOW_UPGRADE_MODAL') {
    // Inject upgrade-only modal
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const used = await getFreeDownloadCount();
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['modal.js'] });
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'SHOW_DOWNLOAD_MODAL',
            filename: '',
            isPro: false,
            used,
            remaining: 0,
            freeLimit: FREE_LIMIT,
            isLimitReached: true,
          }).catch(() => {});
        }, 150);
      } catch (_) {}
    })();
    return;
  }
});

// ── On install, open welcome page ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

