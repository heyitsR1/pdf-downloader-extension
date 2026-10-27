import {
  checkLicense,
  activateLicense,
  deactivateLicense,
  getFreeDownloadCount,
  getCheckoutUrl,
  FREE_LIMIT,
} from './licensing.js';

const SUPPORT_EMAIL = 'aarohan@tailsgate.com';

// ── Element refs ──────────────────────────────────────────────────────────────
const el = {
  // Header
  proBadge:           document.getElementById('proBadge'),

  // Views
  defaultView:        document.getElementById('defaultView'),
  activationView:     document.getElementById('activationView'),

  // Credits / pro
  creditsSection:     document.getElementById('creditsSection'),
  creditsDisplay:     document.getElementById('creditsDisplay'),
  progressBar:        document.getElementById('progressBar'),
  creditsWarning:     document.getElementById('creditsWarning'),
  creditsWarningText: document.getElementById('creditsWarningText'),
  proSection:         document.getElementById('proSection'),
  deactivateSection:  document.getElementById('deactivateSection'),

  // Status + PDF list
  statusDot:          document.getElementById('statusDot'),
  statusText:         document.getElementById('statusText'),
  pdfList:            document.getElementById('pdfList'),
  btnBulkDownload:    document.getElementById('btnBulkDownload'),

  // Action buttons
  btnRefresh:         document.getElementById('btnRefresh'),
  upgradeSection:     document.getElementById('upgradeSection'),
  btnUpgrade:         document.getElementById('btnUpgrade'),
  btnShowActivate:    document.getElementById('btnShowActivate'),
  btnDeactivate:      document.getElementById('btnDeactivate'),

  // Activation panel
  btnBackFromActivate: document.getElementById('btnBackFromActivate'),
  licenseKeyInput:    document.getElementById('licenseKeyInput'),
  activationError:    document.getElementById('activationError'),
  btnActivate:        document.getElementById('btnActivate'),
  btnBuyLicense:      document.getElementById('btnBuyLicense'),

  // Footer
  supportLink:        document.getElementById('supportLink'),
  btnDiagnostics:     document.getElementById('btnDiagnostics'),
};

// ── Global States ─────────────────────────────────────────────────────────────
let currentIsPro = false;
let detectedEntries = [];

// ── View switching ────────────────────────────────────────────────────────────
function showDefaultView() {
  el.defaultView.classList.remove('hidden');
  el.activationView.classList.add('hidden');
  el.activationError.classList.add('hidden');
  el.activationError.textContent = '';
  el.licenseKeyInput.value = '';
}

function showActivationView() {
  el.defaultView.classList.add('hidden');
  el.activationView.classList.remove('hidden');
  setTimeout(() => el.licenseKeyInput.focus(), 50);
}

// ── Bulk Download Helpers ──────────────────────────────────────────────────────
function updateBulkDownloadButton(isPro, filesCount) {
  if (!el.btnBulkDownload) return;
  if (!isPro) {
    el.btnBulkDownload.disabled = true;
    el.btnBulkDownload.classList.remove('pro-active');
    el.btnBulkDownload.querySelector('span').textContent = 'Bulk Download All (Requires Pro)';
  } else {
    el.btnBulkDownload.classList.add('pro-active');
    if (filesCount === 0) {
      el.btnBulkDownload.disabled = true;
      el.btnBulkDownload.querySelector('span').textContent = 'Bulk Download All';
    } else {
      el.btnBulkDownload.disabled = false;
      el.btnBulkDownload.querySelector('span').textContent = `Bulk Download All (${filesCount})`;
    }
  }
}

// ── Credits / Pro UI ──────────────────────────────────────────────────────────
function updateCreditsUI(isPro, used) {
  currentIsPro = isPro;
  updateBulkDownloadButton(isPro, detectedEntries.length);

  if (isPro) {
    el.creditsSection.classList.add('hidden');
    el.proSection.classList.remove('hidden');
    el.proBadge.classList.remove('hidden');
    el.upgradeSection.classList.add('hidden');
    el.deactivateSection.classList.remove('hidden');
  } else {
    el.creditsSection.classList.remove('hidden');
    el.proSection.classList.add('hidden');
    el.proBadge.classList.add('hidden');
    el.upgradeSection.classList.remove('hidden');
    el.deactivateSection.classList.add('hidden');

    const remaining = Math.max(0, FREE_LIMIT - used);
    el.creditsDisplay.textContent = `${used} / ${FREE_LIMIT}`;

    const pct = Math.min(100, (used / FREE_LIMIT) * 100);
    el.progressBar.style.width = `${pct}%`;

    if (remaining === 0) {
      el.creditsWarning.classList.remove('hidden');
      el.creditsWarningText.textContent = "You've used all your free credits";
    } else if (remaining <= 2) {
      el.creditsWarning.classList.remove('hidden');
      el.creditsWarningText.textContent = `⚠ ${remaining} credit${remaining === 1 ? '' : 's'} remaining`;
    } else {
      el.creditsWarning.classList.add('hidden');
    }
  }
}

// ── PDF list helpers ──────────────────────────────────────────────────────────
function emptyState(icon, text) {
  return `<div class="empty-state">
    <span class="empty-icon">${icon}</span>
    <p class="empty-text">${text}</p>
  </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function filenameFromUrl(url) {
  try {
    const seg = decodeURIComponent(
      new URL(url).pathname.split('/').filter(Boolean).pop() || ''
    );
    if (seg) return seg.toLowerCase().endsWith('.pdf') ? seg : `${seg}.pdf`;
  } catch (_) {}
  return 'document.pdf';
}

function filenameForMemory(entry) {
  let label = String(entry.label || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) label = 'document';
  if (!/\.pdf$/i.test(label)) label += '.pdf';
  return label.slice(0, 120);
}

function filenameForEntry(entry) {
  return entry.kind === 'memory' ? filenameForMemory(entry) : filenameFromUrl(entry.url);
}

// A captured buffer is the only source that can produce a real file on an
// encrypted (appx/classx) viewer. If the tab has memory entries, drop URL
// entries that cannot be decrypted, and never show the same file twice.
function isEncryptedRemoteUrl(url) {
  try {
    return /(^|\.)(appx\.co\.in|classx\.co\.in|static-db[\w-]*\.|pdfweb\.)/i.test(
      new URL(url).hostname
    );
  } catch (_) {
    return false;
  }
}

function preferMemoryEntries(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const memory = list.filter((e) => e.kind === 'memory');
  if (!memory.length) return list;

  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (entry.kind === 'url' && isEncryptedRemoteUrl(entry.url)) continue;
    const key = entry.kind === 'memory' ? `m:${entry.id}` : `u:${entry.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  // Stable order: captured bytes first.
  out.sort((a, b) => (a.kind === 'memory' ? 0 : 1) - (b.kind === 'memory' ? 0 : 1));
  return out;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function loadPdfs(isPro, used) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    el.statusText.textContent = 'No active tab found';
    el.statusDot.className = 'dot';
    el.pdfList.innerHTML = emptyState('🌐', 'Open a webpage with a PDF<br>and click Scan.');
    return;
  }

  el.statusText.textContent = 'Scanning for PDFs…';
  el.statusDot.className = 'dot scanning';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PDFS', tabId: tab.id });
    if (!res) throw new Error('No response');

    const entries = preferMemoryEntries(
      res.entries || (res.urls || []).map((url) => ({
        kind: 'url',
        id: `url:${url}`,
        url,
      }))
    );
    detectedEntries = entries;
    updateBulkDownloadButton(isPro, entries.length);

    if (entries.length === 0) {
      el.statusText.textContent = 'No PDFs found yet';
      el.statusDot.className = 'dot';
      el.pdfList.innerHTML = emptyState('🔍', 'No PDFs detected.<br>Try reloading or navigating to the PDF.');
      return;
    }

    el.statusText.textContent = `${entries.length} PDF${entries.length > 1 ? 's' : ''} found`;
    el.statusDot.className = 'dot active';
    renderPdfList(entries, isPro, used, tab);
  } catch (err) {
    el.statusText.textContent = 'Service unavailable';
    el.statusDot.className = 'dot';
  }
}

function renderPdfList(entries, isPro, used, tab) {
  el.pdfList.innerHTML = '';
  entries.forEach((entry, i) => {
    const isMemory = entry.kind === 'memory';
    const filename = filenameForEntry(entry);
    const meta = isMemory
      ? `In-memory · ${formatBytes(entry.size)}`
      : `${String(entry.url || '').substring(0, 48)}…`;

    const item = document.createElement('div');
    item.className = 'pdf-item';
    item.innerHTML = `
      <div class="pdf-info">
        <span class="pdf-name" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
        <span class="pdf-meta">${escapeHtml(meta)}</span>
      </div>
      <div class="btn-group">
        <button class="btn btn-dl" id="dl-${i}">↓ Download</button>
        ${isMemory ? '' : `<button class="btn btn-view" id="open-${i}">View</button>`}
      </div>`;
    el.pdfList.appendChild(item);

    document.getElementById(`dl-${i}`).addEventListener('click', async () => {
      const btn = document.getElementById(`dl-${i}`);
      const { isPro: currentPro } = await checkLicense();
      const currentUsed = await getFreeDownloadCount();

      if (!currentPro && currentUsed >= FREE_LIMIT) {
        chrome.runtime.sendMessage({ type: 'SHOW_UPGRADE_MODAL' });
        return;
      }

      btn.textContent = 'Starting…';
      btn.disabled = true;

      const message = isMemory
        ? { type: 'DOWNLOAD_BUFFER', tabId: tab.id, id: entry.id, filename }
        : { type: 'DOWNLOAD_PDF', tabId: tab.id, url: entry.url, filename };
      console.log('[PDFDownloader] popup download', entry.kind, filename, message);

      try {
        const res = await chrome.runtime.sendMessage(message);
        if (res?.ok) {
          btn.textContent = '✓ Done!';
          await chrome.runtime.sendMessage({
            type: 'DOWNLOAD_COMPLETE',
            filename,
            tabId: tab.id,
            isPro: currentPro,
          });
          setTimeout(async () => {
            btn.textContent = '↓ Download';
            btn.disabled = false;
            const updatedUsed = await getFreeDownloadCount();
            updateCreditsUI(currentPro, updatedUsed);
          }, 2500);
        } else if (res?.error === 'need_buffer' && res.bufferId) {
          btn.textContent = 'Saving captured file…';
          const retry = await chrome.runtime.sendMessage({
            type: 'DOWNLOAD_BUFFER',
            tabId: tab.id,
            id: res.bufferId,
            filename,
          });
          if (retry?.ok) {
            btn.textContent = '✓ Done!';
            await chrome.runtime.sendMessage({
              type: 'DOWNLOAD_COMPLETE',
              filename,
              tabId: tab.id,
              isPro: currentPro,
            });
          } else {
            btn.textContent = '✗ Error';
            console.warn('[PDFDownloader] buffer retry failed', retry);
          }
          btn.disabled = false;
          setTimeout(() => { btn.textContent = '↓ Download'; }, 2500);
        } else if (res?.error === 'encrypted_no_bytes') {
          btn.textContent = 'No bytes yet';
          btn.disabled = false;
          setTimeout(() => { btn.textContent = '↓ Download'; }, 2500);
        } else {
          btn.textContent = '✗ Error';
          btn.disabled = false;
          setTimeout(() => { btn.textContent = '↓ Download'; }, 2500);
        }
      } catch (err) {
        btn.textContent = '✗ Error';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = '↓ Download'; }, 2500);
      }
    });

    if (!isMemory) {
      document.getElementById(`open-${i}`).addEventListener('click', async () => {
        const { isPro: currentPro } = await checkLicense();
        const currentUsed = await getFreeDownloadCount();

        if (!currentPro) {
          if (currentUsed >= FREE_LIMIT) {
            chrome.runtime.sendMessage({ type: 'SHOW_UPGRADE_MODAL' });
            return;
          }
          const proceed = confirm("Viewing a PDF opens it in a new tab and uses 1 free credit. Would you like to proceed?");
          if (!proceed) return;

          try {
            // Record usage
            await chrome.runtime.sendMessage({ type: 'RECORD_DOWNLOAD' });
          } catch (_) {}
          const updatedUsed = await getFreeDownloadCount();
          updateCreditsUI(currentPro, updatedUsed);
        }

        chrome.tabs.create({ url: entry.url, active: false });
      });
    }
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────

el.supportLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `mailto:${SUPPORT_EMAIL}` });
});

// One-click diagnostics for support. Mohit can paste this instead of a
// screenshot, and it carries what the console logging is trying to tell us.
el.btnDiagnostics?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let diag = { ok: false, error: 'no_tab' };
  try {
    diag = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS', tabId: tab?.id });
  } catch (err) {
    diag = { ok: false, error: err.message || String(err) };
  }
  const report = [
    'PDF Downloader diagnostics',
    `extension: v${diag.version || '?'}`,
    `page: ${tab?.url || '?'}`,
    `pro: ${diag.isPro}  credits: ${diag.used}/${diag.freeLimit}  key: ${diag.licenseKeyTail || 'none'}`,
    `entries: ${Array.isArray(diag.entries) ? diag.entries.length : 0}`,
    ...(diag.entries || []).map(
      (e, i) =>
        `  ${i + 1}. ${e.kind} ${e.label || e.id} ${e.size ? `(${e.size}b)` : ''} ${e.url || ''}`
    ),
    `error: ${diag.error || 'none'}`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    el.btnDiagnostics.textContent = 'Copied ✓';
    setTimeout(() => { el.btnDiagnostics.textContent = 'Copy diagnostics'; }, 2000);
  } catch (_) {
    el.btnDiagnostics.textContent = 'Copy failed';
    setTimeout(() => { el.btnDiagnostics.textContent = 'Copy diagnostics'; }, 2000);
  }
  console.log('[PDFDownloader] diagnostics\n' + report);
});

el.btnBulkDownload.addEventListener('click', async () => {
  if (!currentIsPro || detectedEntries.length === 0) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  el.btnBulkDownload.disabled = true;
  const textSpan = el.btnBulkDownload.querySelector('span');

  textSpan.textContent = 'Zipping PDFs...';

  const zip = new window.JSZip();
  let downloadedCount = 0;
  let skippedCount = 0;

  // Deduplicate file names
  const usedNames = new Set();

  for (let i = 0; i < detectedEntries.length; i++) {
    const entry = detectedEntries[i];
    const filename = filenameForEntry(entry);

    // Ensure unique filename inside zip
    let uniqueName = filename;
    let counter = 1;
    while (usedNames.has(uniqueName)) {
      const extIndex = filename.lastIndexOf('.');
      if (extIndex !== -1) {
        uniqueName = `${filename.substring(0, extIndex)}_${counter}${filename.substring(extIndex)}`;
      } else {
        uniqueName = `${filename}_${counter}`;
      }
      counter++;
    }
    usedNames.add(uniqueName);

    textSpan.textContent = `Fetching ${i + 1}/${detectedEntries.length}...`;

    try {
      if (entry.kind === 'memory') {
        const res = await chrome.runtime.sendMessage({
          type: 'GET_BUFFER',
          tabId: tab.id,
          id: entry.id,
        });
        if (!res?.ok) throw new Error(res?.error || 'buffer_expired');
        zip.file(uniqueName, base64ToBytes(res.b64));
      } else {
        // Never put ciphertext in the zip: an appx/classx remote URL is
        // encrypted and rejects referrer-less requests.
        if (isEncryptedRemoteUrl(entry.url)) {
          throw new Error('encrypted remote url has no captured bytes');
        }
        const response = await fetch(entry.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        zip.file(uniqueName, data);
      }
      downloadedCount++;
    } catch (err) {
      skippedCount++;
      console.error(`Failed to fetch PDF: ${entry.url || entry.id}`, err);
    }
  }

  if (downloadedCount === 0) {
    textSpan.textContent = '✗ Error: Could not fetch files';
    setTimeout(() => {
      updateBulkDownloadButton(currentIsPro, detectedEntries.length);
    }, 3000);
    return;
  }

  textSpan.textContent = 'Generating ZIP...';
  try {
    const content = await zip.generateAsync({ type: 'blob' });
    const blobUrl = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = 'pdfs_archive.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);

    textSpan.textContent = skippedCount
      ? `✓ Zipped ${downloadedCount} files (${skippedCount} skipped)`
      : `✓ Zipped ${downloadedCount} files!`;
  } catch (err) {
    console.error(err);
    textSpan.textContent = '✗ ZIP generation failed';
  }

  setTimeout(() => {
    updateBulkDownloadButton(currentIsPro, detectedEntries.length);
  }, 3000);
});

el.btnRefresh.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id);
});

el.btnUpgrade.addEventListener('click', () => {
  chrome.tabs.create({ url: getCheckoutUrl() });
});

el.btnShowActivate.addEventListener('click', (e) => {
  e.preventDefault();
  showActivationView();
});

el.btnBackFromActivate.addEventListener('click', () => {
  showDefaultView();
});

el.btnBuyLicense.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: getCheckoutUrl() });
});

// Enter key submits activation
el.licenseKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnActivate.click();
});

el.btnActivate.addEventListener('click', async () => {
  const key = el.licenseKeyInput.value.trim();
  if (!key) {
    showActivationError('Please enter your license key.');
    return;
  }

  el.btnActivate.disabled = true;
  el.btnActivate.textContent = 'Activating…';
  el.activationError.classList.add('hidden');

  const result = await activateLicense(key);

  if (result.ok) {
    el.btnActivate.textContent = '✓ Activated!';
    setTimeout(async () => {
      showDefaultView();
      const { isPro } = await checkLicense();
      const used = await getFreeDownloadCount();
      updateCreditsUI(isPro, used);
      el.btnActivate.disabled = false;
      el.btnActivate.textContent = 'Activate License';
    }, 1200);
  } else {
    showActivationError(result.error || 'Activation failed. Please check your key.');
    el.btnActivate.disabled = false;
    el.btnActivate.textContent = 'Activate License';
  }
});

el.btnDeactivate.addEventListener('click', async () => {
  if (!confirm('Deactivate your Pro license on this device?')) return;
  await deactivateLicense();
  const { isPro } = await checkLicense();
  const used = await getFreeDownloadCount();
  updateCreditsUI(isPro, used);
});

function showActivationError(msg) {
  el.activationError.textContent = msg;
  el.activationError.classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const { isPro } = await checkLicense();
  const used = await getFreeDownloadCount();
  updateCreditsUI(isPro, used);
  await loadPdfs(isPro, used);
}

init();
setInterval(async () => {
  const { isPro } = await checkLicense();
  const used = await getFreeDownloadCount();
  updateCreditsUI(isPro, used);
}, 5000);
