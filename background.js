import { recordDownload, checkLicense, getFreeDownloadCount, activateLicense } from './licensing.js';

const FREE_LIMIT = 5;

const TAG = '[PDFDownloader]';

function log(...args) {
  console.log(TAG, ...args);
}

function warn(...args) {
  console.warn(TAG, ...args);
}

// classx/appx serve the *ciphertext* at these hosts and reject requests that
// lack the page's referrer, so chrome.downloads on them can never produce a
// usable file ("File wasn't available on site", saved as .txt). The only
// correct source of bytes is the viewer's decrypted buffer.
const ENCRYPTED_REMOTE = /(^|\.)(appx\.co\.in|classx\.co\.in|static-db[\w-]*\.|pdfweb\.)/i;

function isEncryptedRemote(url) {
  try {
    return ENCRYPTED_REMOTE.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

// A download id is not proof of a file. chrome.downloads returns an id even
// when the transfer later fails, which is exactly how all 5 free credits got
// burned with nothing on disk. Credits are only recorded from onChanged.
const pendingCredits = new Map(); // downloadId -> { filename }
const recordedCreditIds = new Set();

// Blob downloads are started by an <a download> click in the content script,
// so we never see an id up front. Chrome still creates a normal download
// entry. onCreated fires *before* our sendMessage promise resolves, so recent
// creations are buffered and matched instead of being missed.
const recentCreations = []; // { id, filename, at }
let expectingBlobDownload = null; // { filename, at }

function normalizeName(p) {
  return String(p || '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\s*\(\d+\)(\.[^.]+)$/, '$1')
    .replace(/\.(pdf|txt)$/i, '');
}

function looselyMatchesDownload(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function isBlobUrl(url) {
  return typeof url === 'string' && url.startsWith('blob:');
}

// Blob downloads carry no useful filename (Chrome reports the resolved save
// path, which is often a temp/UUID name), but they DO carry the blob: URL.
// Match on that first and fall back to the (sanitised) name.
function linkPendingCredit(item, expected) {
  if (!item || !expected) return false;
  if (Date.now() - expected.at > 20000) return false;
  const byBlob = isBlobUrl(item.url);
  const byName = looselyMatchesDownload(item.filename, expected.filename);
  if (!byBlob && !byName) return false;
  pendingCredits.set(item.id, { filename: expected.filename });
  log(
    'blob download linked',
    item.id,
    expected.filename,
    byBlob ? '(blob url)' : '(filename)',
    'state=' + item.state
  );
  return true;
}

function recordCreditForDownload(downloadId, filename) {
  pendingCredits.delete(downloadId);
  if (recordedCreditIds.has(downloadId)) {
    log('credit already recorded for download', downloadId);
    return;
  }
  recordedCreditIds.add(downloadId);
  if (recordedCreditIds.size > 200) {
    recordedCreditIds.delete(recordedCreditIds.values().next().value);
  }
  recordDownload()
    .then(() => log('credit recorded after successful download', downloadId, filename))
    .catch((err) => warn('credit record failed', err));
}

chrome.downloads.onCreated.addListener((item) => {
  const created = { id: item.id, filename: item.filename, url: item.url, at: Date.now() };
  recentCreations.push(created);
  while (recentCreations.length > 12) recentCreations.shift();
  log('download created', item.id, item.state, item.url ? item.url.slice(0, 40) : '', item.filename);

  // Small blobs can be reported as already complete at creation time, so the
  // "wait for onChanged" path would never fire. Link first, then settle.
  if (expectingBlobDownload && linkPendingCredit(created, expectingBlobDownload)) {
    expectingBlobDownload = null;
    if (item.state === 'complete') {
      recordCreditForDownload(item.id, created.filename);
    }
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  const id = delta.id;
  const state = delta.state?.current;

  // A buffer download may have been created before we armed the expectation.
  if (expectingBlobDownload && !pendingCredits.has(id)) {
    const recent = recentCreations.find((c) => c.id === id);
    if (recent && linkPendingCredit(recent, expectingBlobDownload)) expectingBlobDownload = null;
  }

  if (!pendingCredits.has(id)) return;
  if (!state) return;
  const { filename } = pendingCredits.get(id) || {};
  if (state === 'complete') {
    log('download complete', id, filename);
    recordCreditForDownload(id, filename);
  } else if (state === 'interrupted') {
    warn('download FAILED (no credit used)', id, filename, delta.error?.current || '');
    pendingCredits.delete(id);
  }
});

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
      sourceUrl: String(entry.sourceUrl || ''),
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
    if (entry.kind === 'memory') {
      // A captured buffer supersedes any URL entry for the same file, so the
      // popup offers one row that actually works. We match on the explicit
      // sourceUrl as well as on the loose appx/classx hosts, because the
      // customer's popup showed the remote pdf_link under a different name.
      const supersedes = (e) => {
        if (e.kind !== 'url' || !e.url) return false;
        if (sourceUrl && e.url === sourceUrl) return true;
        return isEncryptedRemote(e.url);
      };
      const filtered = existing.filter((e) => !supersedes(e));
      if (filtered.length !== existing.length) {
        log('memory capture replaced', existing.length - filtered.length, 'remote url entr(ies)');
        existing = filtered;
        await chrome.storage.local.set({ [key]: existing });
      }
      if (sourceUrl) suppressedUrls.set(sourceUrl, Date.now());
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

async function findMemoryForUrl(tabId, url) {
  if (!tabId || !url) return null;
  try {
    const key = `pdfs_tab_${tabId}`;
    const result = await chrome.storage.local.get([key]);
    const entries = (result[key] || []).map(normalizeEntry).filter(Boolean);
    const memory = entries.filter((e) => e.kind === 'memory');
    if (!memory.length) return null;
    const matching = memory.find((e) => e.sourceUrl && e.sourceUrl === url);
    return (matching || memory[memory.length - 1]).id;
  } catch (_) {
    return null;
  }
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

      const tabId = msg.tabId || sender.tab?.id;

      // Last line of defence: an appx/classx URL is ciphertext and rejects
      // referrer-less requests. Point the caller at the captured buffer
      // instead of shipping a broken .txt.
      if (isEncryptedRemote(msg.url)) {
        const bufferId = await findMemoryForUrl(tabId, msg.url);
        warn('refusing encrypted remote download', msg.url, 'buffer=' + (bufferId || 'none'));
        sendResponse({
          ok: false,
          error: bufferId ? 'need_buffer' : 'encrypted_no_bytes',
          bufferId: bufferId || null,
        });
        return;
      }

      try {
        log('downloading url', filename, msg.url);
        const downloadId = await chrome.downloads.download({ url: msg.url, filename, saveAs: false });
        if (!isPro) pendingCredits.set(downloadId, { filename });
        sendResponse({ ok: true, downloadId, deferred: !isPro });
      } catch (err) {
        warn('url download failed to start', filename, err && err.message);
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

      // Arm the expectation BEFORE the click: the content script starts the
      // blob download synchronously inside the message handler, so
      // downloads.onCreated can fire before this sendMessage's promise
      // resolves. Arming afterwards misses the event entirely.
      if (!isPro) {
        expectingBlobDownload = { filename, at: Date.now() };
      }

      try {
        log('buffer download', filename, msg.id);
        const res = await chrome.tabs.sendMessage(
          tabId,
          { type: 'TRIGGER_BUFFER_DOWNLOAD', id: msg.id, filename },
          { frameId: 0 }
        );
        if (!res?.ok) {
          expectingBlobDownload = null;
          warn('buffer download failed', msg.id, res?.error || 'download_failed');
          sendResponse({ ok: false, error: res?.error || 'download_failed' });
          return;
        }
        sendResponse({ ok: true, deferred: !isPro });
      } catch (err) {
        expectingBlobDownload = null;
        warn('buffer download threw', msg.id, err && err.message);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ACTIVATE_LICENSE') {
    (async () => {
      try {
        const key = String(msg.key || '').trim();
        log('activating license from', msg.origin || 'unknown', key ? `key:${key.slice(0, 6)}…` : 'no key');
        const result = await activateLicense(key);
        if (result.ok) {
          const used = await getFreeDownloadCount();
          log('license activated, credits reset for Pro', used);
          sendResponse({ ok: true, isPro: true });
        } else {
          warn('license activation failed', result.error);
          sendResponse({ ok: false, error: result.error || 'Activation failed.' });
        }
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

  if (msg.type === 'GET_DIAGNOSTICS') {
    (async () => {
      try {
        const key = `pdfs_tab_${msg.tabId}`;
        const result = await chrome.storage.local.get([
          key,
          'pdfdl_paid',
          'pdfdl_usage',
          'pdfdl_license_key',
        ]);
        const entries = (result[key] || []).map(normalizeEntry).filter(Boolean);
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version,
          isPro: !!result.pdfdl_paid,
          used: Number(result.pdfdl_usage) || 0,
          freeLimit: FREE_LIMIT,
          licenseKeyTail: result.pdfdl_license_key
            ? `…${String(result.pdfdl_license_key).slice(-4)}`
            : null,
          entries: entries.map((e) => ({
            kind: e.kind,
            id: e.id,
            label: e.label || '',
            size: e.size || 0,
            url: e.url ? e.url.slice(0, 120) : '',
            sourceUrl: (e.sourceUrl || '').slice(0, 120),
          })),
          pendingDownloads: pendingCredits.size,
        });
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

