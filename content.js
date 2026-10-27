// content.js — runs in ISOLATED world

const TAG = '[PDFDownloader]';

function log(...args) {
  console.log(TAG, ...args);
}

function warn(...args) {
  console.warn(TAG, ...args);
}

// Helper for safe messaging
async function safeSendMessage(msg) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      return await chrome.runtime.sendMessage(msg);
    }
  } catch (err) {
    console.warn('[PDFDownloader] Extension context invalidated.');
    document.getElementById('pdfdl-floating-btn')?.remove();
  }
  return null;
}

const memoryPdfs = new Map();
const memoryOrder = [];
let memoryBytes = 0;
const MAX_MEMORY_ENTRIES = 8;
const MAX_MEMORY_BYTES = 320 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 24 * 1024 * 1024;
const storedUrls = new Set();
let latest = null;
let floatingButton = null;
let floatingAttached = false;

function cleanLabel(label) {
  return String(label || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function isUsefulLabel(label) {
  const value = cleanLabel(label);
  return Boolean(value) && value !== 'In-memory PDF' && !/^pdf\.js viewer$/i.test(value);
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

function filenameFromEntry(entry) {
  if (entry && entry.kind === 'memory') {
    const label = cleanLabel(entry.label);
    if (label) return /\.pdf$/i.test(label) ? label : `${label}.pdf`;
    return 'document.pdf';
  }
  return filenameFromUrl(entry && entry.url);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function isPdfBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) return false;
  const bytes = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength));
  for (let i = 0; i <= bytes.length - 5; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function latestMemoryEntry() {
  for (let i = memoryOrder.length - 1; i >= 0; i--) {
    const entry = memoryPdfs.get(memoryOrder[i]);
    if (entry) return entry;
  }
  return null;
}

function triggerBlobDownload(entry, filename) {
  const name = /\.pdf$/i.test(filename || '') ? filename : `${filename || 'document'}.pdf`;
  const blob = new Blob([entry.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  log('blob download triggered', name, `${entry.size}b`, `mime=application/pdf`);
}

function trimMemory() {
  while (
    (memoryOrder.length > MAX_MEMORY_ENTRIES || memoryBytes > MAX_MEMORY_BYTES) &&
    memoryOrder.length > 1
  ) {
    const id = memoryOrder.shift();
    const entry = memoryPdfs.get(id);
    if (!entry) continue;
    memoryBytes -= entry.size;
    memoryPdfs.delete(id);
    safeSendMessage({ type: 'REMOVE_PDF', id });
    if (latest && latest.kind === 'memory' && latest.id === id) {
      latest = null;
      document.getElementById('pdfdl-floating-btn')?.remove();
    }
  }
}

function captureUrl(url, alreadyStored) {
  if (!url) return;
  if (!alreadyStored && !storedUrls.has(url)) {
    storedUrls.add(url);
    safeSendMessage({ type: 'STORE_PDF', url });
  }
  showUrlButton(url);
}

function captureBuffer(data) {
  const id = String(data.id || '').slice(0, 80);
  const buffer = data.buffer;
  if (!id || !isPdfBuffer(buffer)) {
    warn('received buffer but it is not a PDF', id, buffer?.byteLength);
    return;
  }

  const size = Number(data.size) || buffer.byteLength;
  const now = Date.now();
  let entry = memoryPdfs.get(id);
  log('buffer received', id, `${size}b`, 'source=' + (data.source || '?'));

  if (!entry) {
    // Only merge captures with an identical byte length. The old "within 20%
    // or 64KB" heuristic merged two *different* PDFs opened seconds apart into
    // a single entry, so the download served whichever arrived first. The id
    // is already a content fingerprint, so identical bytes share an id and
    // never need a fuzzy match.
    entry = [...memoryPdfs.values()].find(
      (candidate) =>
        candidate.size === size &&
        candidate.id !== id &&
        now - candidate.capturedAt < 10000
    );
  }

  if (!entry) {
    entry = {
      id,
      kind: 'memory',
      size,
      label: cleanLabel(data.label),
      sourceUrl: data.sourceUrl || '',
      buffer,
      source: data.source || '',
      capturedAt: now,
    };
    memoryPdfs.set(id, entry);
    memoryOrder.push(id);
    memoryBytes += size;
    trimMemory();

    safeSendMessage({
      type: 'STORE_PDF',
      entry: {
        kind: 'memory',
        id,
        label: entry.label,
        size: entry.size,
        sourceUrl: entry.sourceUrl,
      },
    });
  } else {
    let changed = false;
    if (data.source === 'worker' && isUsefulLabel(data.label)) {
      entry.label = cleanLabel(data.label);
      changed = true;
    }
    if (!entry.sourceUrl && data.sourceUrl) {
      entry.sourceUrl = data.sourceUrl;
      changed = true;
    }
    if (changed) {
      safeSendMessage({
        type: 'STORE_PDF',
        entry: {
          kind: 'memory',
          id: entry.id,
          label: entry.label,
          size: entry.size,
          sourceUrl: entry.sourceUrl,
        },
      });
    }
  }

  showMemoryButton(entry);
}

function updateMemoryLabel(id, label) {
  const entry = memoryPdfs.get(String(id || ''));
  if (!entry || !isUsefulLabel(label)) return;
  const next = cleanLabel(label);
  if (next === entry.label) return;
  entry.label = next;
  safeSendMessage({
    type: 'STORE_PDF',
    entry: {
      kind: 'memory',
      id: entry.id,
      label: entry.label,
      size: entry.size,
      sourceUrl: entry.sourceUrl,
    },
  });
  showMemoryButton(entry);
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'PDF_DL_URL' && data.url) {
    captureUrl(data.url, false);
  } else if (data.type === 'PDF_DL_BUFFER') {
    log('buffer message from', event.origin || 'unknown origin');
    captureBuffer(data);
  } else if (data.type === 'PDF_DL_META') {
    updateMemoryLabel(data.id, data.label);
  }
});

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'PDF_CAPTURED') {
      if (msg.entry && msg.entry.kind === 'memory') {
        showMemoryButton(msg.entry);
      } else if (msg.url || msg.entry?.url) {
        captureUrl(msg.url || msg.entry.url, true);
      }
      return;
    }

    if (msg.type === 'TRIGGER_BUFFER_DOWNLOAD') {
      const entry = memoryPdfs.get(msg.id);
      if (!entry) {
        sendResponse({ ok: false, error: 'buffer_expired' });
        return;
      }
      try {
        triggerBlobDownload(entry, msg.filename);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return;
    }

    if (msg.type === 'GET_BUFFER') {
      const entry = memoryPdfs.get(msg.id);
      if (!entry) {
        sendResponse({ ok: false, error: 'buffer_expired' });
        return;
      }
      if (entry.size > MAX_TRANSFER_BYTES) {
        sendResponse({ ok: false, error: 'too_large' });
        return;
      }
      try {
        sendResponse({ ok: true, b64: arrayBufferToBase64(entry.buffer) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return;
    }
  });
}

function showUrlButton(url) {
  // A URL entry must never displace captured bytes: the bytes are the only
  // thing that can actually be saved on an encrypted viewer.
  if (latest && latest.kind === 'memory') {
    log('ignoring url entry, memory capture already active', url);
    return;
  }
  latest = { kind: 'url', url, filename: filenameFromUrl(url) };
  renderFloatingButton();
}

function showMemoryButton(entry) {
  if (!entry || !entry.id) return;
  latest = {
    kind: 'memory',
    id: entry.id,
    filename: filenameFromEntry(entry),
  };
  renderFloatingButton();
}

function renderFloatingButton() {
  if (!latest) return;

  let btn =
    floatingButton && (!floatingAttached || floatingButton.isConnected)
      ? floatingButton
      : document.getElementById('pdfdl-floating-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'pdfdl-floating-btn';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '28px',
      right: '28px',
      zIndex: '2147483647',
      padding: '11px 22px',
      background: 'linear-gradient(135deg, #E53E3E 0%, #C53030 100%)',
      color: '#fff',
      border: 'none',
      borderRadius: '12px',
      fontSize: '13px',
      fontWeight: '700',
      cursor: 'pointer',
      boxShadow: '0 8px 24px rgba(229, 62, 62, 0.4), 0 2px 8px rgba(0,0,0,0.3)',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      letterSpacing: '0.01em',
    });

    const icon = document.createElement('span');
    icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    btn.prepend(icon);

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px) scale(1.02)';
      btn.style.boxShadow = '0 12px 32px rgba(229, 62, 62, 0.5), 0 4px 12px rgba(0,0,0,0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateY(0) scale(1)';
      btn.style.boxShadow = '0 8px 24px rgba(229, 62, 62, 0.4), 0 2px 8px rgba(0,0,0,0.3)';
    });

    floatingButton = btn;
    floatingAttached = false;
    const attach = () => {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', attach, { once: true });
        return;
      }
      if (!btn.isConnected) document.body.appendChild(btn);
      floatingAttached = true;
    };
    attach();
  }

  const textSpan = btn.querySelector('.pdfdl-btn-text') || document.createElement('span');
  if (!textSpan.className) {
    textSpan.className = 'pdfdl-btn-text';
    btn.appendChild(textSpan);
  }
  textSpan.textContent = 'Download PDF';

  btn.onclick = async () => {
    if (!latest) return;

    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.7';

    const active = latest;
    const filename = active.filename || 'document.pdf';
    const message = active.kind === 'memory'
      ? { type: 'DOWNLOAD_BUFFER', id: active.id, filename }
      : { type: 'DOWNLOAD_PDF', url: active.url, filename };

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      btn.remove();
      return;
    }

    try {
      const res = await safeSendMessage(message);
      if (res?.ok) {
        textSpan.textContent = '✓ Downloading!';
        log('download started', filename, active.kind);
        await safeSendMessage({
          type: 'DOWNLOAD_COMPLETE',
          filename,
          tabId: null,
          isPro: false,
        });
      } else if (res?.error === 'credits_exhausted') {
        textSpan.textContent = 'Upgrade required';
      } else if (res?.error === 'need_buffer' && res.bufferId) {
        log('background refused remote url, retrying with captured bytes', res.bufferId);
        const retry = await safeSendMessage({
          type: 'DOWNLOAD_BUFFER',
          id: res.bufferId,
          filename,
        });
        if (retry?.ok) {
          textSpan.textContent = '✓ Downloading!';
        } else {
          warn('buffer retry failed', retry && retry.error);
          textSpan.textContent = '✗ Error';
        }
      } else {
        warn('download failed', filename, res && res.error);
        textSpan.textContent = '✗ Error';
      }
    } catch (err) {
      btn.remove();
      return;
    }

    setTimeout(() => {
      textSpan.textContent = 'Download PDF';
      btn.disabled = false;
      btn.style.pointerEvents = 'auto';
      btn.style.opacity = '1';
    }, 3000);
  };
}

let _lastPath = location.pathname;
new MutationObserver(() => {
  if (location.pathname !== _lastPath) {
    _lastPath = location.pathname;
    latest = null;
    storedUrls.clear();
    document.getElementById('pdfdl-floating-btn')?.remove();
  }
}).observe(document.documentElement, { childList: true, subtree: true });
