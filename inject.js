// inject.js — runs in the MAIN world via manifest.json
// NOTE: The Chrome DevTools warning "preload not used because credentials mode
// does not match" is a GitBook/site-level issue — the page has a <link rel="preload">
// without a matching crossorigin attribute. Our wrapper correctly passes all
// original args through unchanged and does not alter credentials mode.

// Any host counts, not just signed S3 URLs — see the detection note in
// background.js. The path (not the query string) must end in .pdf.
const VIEWER_NOISE = /pdf\.worker|pdfjs|\/viewer\.html/i;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const BUFFER_KEYS = ['data', 'source', 'buffer', 'pdfData', 'decryptedFile', 'file', 'pdf'];

const seenValues = new WeakSet();
const seenBuffers = new WeakSet();
const seenFingerprints = new Map();
const seenOrder = [];

const TAG = '[PDFDownloader]';

function log(...args) {
  try {
    console.log(TAG, `frame:${location.host}`, ...args);
  } catch (_) {}
}

function warn(...args) {
  try {
    console.warn(TAG, `frame:${location.host}`, ...args);
  } catch (_) {}
}

function isPdfUrl(url) {
  try {
    if (VIEWER_NOISE.test(url)) return false;
    return new URL(url, location.href).pathname.toLowerCase().endsWith('.pdf');
  } catch (_) {
    return false;
  }
}

function extractPdfUrl(data) {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (!str) return null;
    // Excludes whitespace, quotes, backslashes, and common brackets
    const m = str.match(/https?:\/\/[^\s"'`<>\\()[\]{}|]+\.pdf(?:\?[^\s"'`<>\\()[\]{}|]*)?/);
    if (m) {
      // Remove any trailing punctuation/delimiters that might have been captured
      const url = m[0].replace(/[\\.,;!\]\)}>]+$/, '');
      if (isPdfUrl(url)) return url;
    }
  } catch (_) {}
  return null;
}

function sendUrl(url) {
  let absolute = url;
  try {
    absolute = new URL(url, location.href).href;
  } catch (_) {}
  window.postMessage({ type: 'PDF_DL_URL', url: absolute }, '*');
}

let lastFetchUrl = '';
let lastFetchAt = 0;

function rememberFetch(url) {
  try {
    const absolute = new URL(url, location.href).href;
    if (!/^https?:/i.test(absolute)) return;
    lastFetchUrl = absolute;
    lastFetchAt = Date.now();
  } catch (_) {}
}

function sourceUrlFor() {
  if (lastFetchUrl && Date.now() - lastFetchAt < 30000) return lastFetchUrl;
  try {
    const params = new URL(location.href).searchParams;
    const file = params.get('file') || params.get('url') || '';
    if (file) {
      const absolute = new URL(file, location.href).href;
      if (/^https?:/i.test(absolute)) return absolute;
    }
  } catch (_) {}
  return '';
}

function resolveTargetOrigin(target) {
  // Reading location.origin throws for a cross-origin parent/opener. That must
  // NOT abort the post: the top frame's content script accepts any source, so
  // '*' is both safe and required for the classx/appx viewer iframe case.
  try {
    const origin = target.location.origin;
    if (origin && origin !== 'null') return origin;
  } catch (_) {}
  return '*';
}

function postToTop(payload, transfer) {
  const target = window.top || window;
  if (!target) return false;

  if (target === window) {
    try {
      target.postMessage(payload, '*', transfer || []);
      return true;
    } catch (err) {
      warn('postToSelf failed', err && err.message);
      return false;
    }
  }

  const origin = resolveTargetOrigin(target);
  try {
    target.postMessage(payload, origin, transfer || []);
    return true;
  } catch (err) {
    // A '*' target cannot reject, so this is a real failure (e.g. a detached
    // window). Retrying with '*' after a specific-origin throw is harmless.
    warn('postToTop failed', origin, err && err.message);
    try {
      target.postMessage(payload, '*', transfer || []);
      return true;
    } catch (err2) {
      warn('postToTop retry failed', err2 && err2.message);
      return false;
    }
  }
}

function pdfStart(bytes) {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return i;
    }
  }
  return -1;
}

function toBytes(value) {
  if (!value) return null;
  try {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  } catch (_) {}
  return null;
}

function fingerprint(bytes) {
  let hash = 2166136261 >>> 0;
  const length = bytes.length;
  const head = Math.min(length, 4096);
  for (let i = 0; i < head; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  for (let i = Math.max(0, length - 4096); i < length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function labelFor() {
  try {
    const params = new URL(location.href).searchParams;
    const title = params.get('title') || params.get('file') || '';
    if (title) {
      const base = decodeURIComponent(title.split('?')[0].split('/').pop() || '');
      if (base) return base.replace(/\.pdf$/i, '').slice(0, 120);
    }
  } catch (_) {}
  const title = (document.title || '').trim();
  return (title || 'In-memory PDF').slice(0, 120);
}

function captureBytes(value, source, originUrl) {
  const bytes = toBytes(value);
  if (!bytes) return null;
  if (bytes.length < 16 || bytes.length > MAX_BUFFER_BYTES) {
    log('skip bytes', source, `${bytes.length}b (below floor or over cap)`);
    return null;
  }

  const start = pdfStart(bytes);
  if (start < 0) {
    log('skip bytes', source, `${bytes.length}b (no %PDF- in first 1KB)`);
    return null;
  }

  const view = start === 0 ? bytes : bytes.subarray(start);
  const backing = view.buffer;
  if (seenBuffers.has(backing)) {
    log('skip bytes', source, 'already captured this ArrayBuffer');
    return null;
  }

  const id = fingerprint(view);
  seenBuffers.add(backing);

  const now = Date.now();
  const seenAt = seenFingerprints.get(id);
  if (seenAt && now - seenAt < 10000) {
    log('dup bytes', source, id);
    return id;
  }

  seenFingerprints.set(id, now);
  seenOrder.push(id);
  if (seenOrder.length > 32) seenFingerprints.delete(seenOrder.shift());

  const copy = view.slice();
  const copyLength = copy.byteLength; // read BEFORE transfer detaches it
  const posted = postToTop(
    {
      type: 'PDF_DL_BUFFER',
      id,
      buffer: copy.buffer,
      size: copyLength,
      label: labelFor(),
      source,
      sourceUrl: source === 'worker' ? '' : (originUrl || sourceUrlFor()),
    },
    [copy.buffer]
  );
  log(
    'captured',
    source,
    id,
    `${copyLength}b`,
    'offset=' + start,
    posted ? 'posted->top' : 'POST FAILED'
  );

  if (source !== 'worker') {
    try {
      if (window.top) {
        window.top.__pdfdlDecryptedAt = Date.now();
        window.top.__pdfdlLastId = id;
      }
    } catch (_) {}
  }

  return id;
}

function recentDecryptedCapture() {
  try {
    if (!window.top || window.top === window) return false;
    const at = window.top.__pdfdlDecryptedAt;
    return typeof at === 'number' && Date.now() - at < 10000;
  } catch (_) {
    return false;
  }
}

function captureValue(value, source) {
  if (!value) return null;
  if (typeof value === 'object') {
    if (seenValues.has(value)) return null;
    seenValues.add(value);
  }
  if (value instanceof Blob) {
    value.arrayBuffer().then((buffer) => captureBytes(buffer, source)).catch(() => {});
    return null;
  }
  return captureBytes(value, source);
}

function captureAny(value, source, depth) {
  if (!value || depth > 3) return false;
  if (source === 'worker' && recentDecryptedCapture()) {
    try {
      const lastId = window.top && window.top.__pdfdlLastId;
      if (lastId) {
        postToTop({ type: 'PDF_DL_META', id: String(lastId), label: labelFor() });
      }
    } catch (_) {}
    return false;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return captureBytes(value, source) !== null;
  }
  if (typeof value !== 'object') return false;

  for (const key of BUFFER_KEYS) {
    let child;
    try {
      child = value[key];
    } catch (_) {
      continue;
    }
    if (!child) continue;
    if (captureAny(child, source, depth + 1)) return true;
  }
  return false;
}

const decryptedStore = new WeakMap(); // receiver -> last value seen by our setter
const decryptedOriginal = new WeakMap(); // receiver -> original own descriptor

function readDecrypted(receiver) {
  const orig = decryptedOriginal.get(receiver);
  if (orig) {
    if (orig.get) {
      try {
        return orig.get.call(receiver);
      } catch (_) {}
    }
    if ('value' in orig) return orig.value;
  }
  return decryptedStore.get(receiver);
}

function defineDecryptedAccessor(holder) {
  const setter = function (value) {
    decryptedStore.set(this, value);
    try {
      captureValue(value, 'decryptedFile');
    } catch (_) {}
    const orig = decryptedOriginal.get(this);
    if (orig && orig.set) {
      try {
        orig.set.call(this, value);
      } catch (_) {}
    }
  };
  setter.__pdfdlHook = true;

  const getter = function () {
    const orig = decryptedOriginal.get(this);
    if (orig && orig.get) {
      try {
        return orig.get.call(this);
      } catch (_) {}
    }
    return decryptedStore.get(this);
  };
  getter.__pdfdlHook = true;

  Object.defineProperty(holder, 'decryptedFile', {
    configurable: true,
    enumerable: false,
    get: getter,
    set: setter,
  });
}

function hookHolder(holder, receiver) {
  if (!holder) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(holder, 'decryptedFile');
    if (descriptor && descriptor.set && descriptor.set.__pdfdlHook) {
      const current = readDecrypted(receiver);
      if (current) {
        try {
          captureValue(current, 'decryptedFile');
        } catch (_) {}
      }
      return true;
    }
    if (descriptor && receiver && !decryptedOriginal.has(receiver)) {
      decryptedOriginal.set(receiver, descriptor);
    }
    defineDecryptedAccessor(holder);
    const current = readDecrypted(receiver);
    if (current) {
      try {
        captureValue(current, 'decryptedFile');
      } catch (_) {}
    }
    return true;
  } catch (err) {
    warn('decryptedFile hook failed', err && err.message);
    return false;
  }
}

function installDecryptedHook(target) {
  if (!target) return;

  // 1. Window.prototype. The site does `delete window.parent.decryptedFile`,
  //    which only removes the *own* property. An accessor living on the
  //    prototype survives that delete, so every later plain assignment still
  //    runs through our setter. This is what makes the second, third, ... PDF
  //    in the same page load work — the old own-property-only hook only ever
  //    caught the first one.
  try {
    const proto = Object.getPrototypeOf(target);
    if (proto) hookHolder(proto, target);
  } catch (_) {}

  // 2. Own accessor as well, so we shadow anything the page already defined
  //    and keep the first-write path intact.
  hookHolder(target, target);
}

function installDecryptedHooks() {
  installDecryptedHook(window);
  // Cross-origin parent: every property read throws, and the capture relay
  // already reaches the top frame via postToTop('*'). Skip it quietly instead
  // of logging a scary SecurityError on every interval tick.
  try {
    if (window.top && window.top !== window) {
      void window.top.location.origin; // throws when cross-origin
      installDecryptedHook(window.top);
    }
  } catch (_) {}
}

installDecryptedHooks();
if (window.top === window) {
  setInterval(installDecryptedHooks, 3000);
}
document.addEventListener('pointerdown', installDecryptedHooks, true);
document.addEventListener('click', installDecryptedHooks, true);
document.addEventListener('keydown', installDecryptedHooks, true);

const _origWindowPostMessage = Window.prototype.postMessage;
if (_origWindowPostMessage && !_origWindowPostMessage.__pdfdlHook) {
  const wrappedPostMessage = function (message) {
    if (
      message &&
      typeof message === 'object' &&
      typeof message.type === 'string' &&
      message.type.startsWith('PDF_DL_')
    ) {
      return _origWindowPostMessage.apply(this, arguments);
    }
    try {
      captureAny(message, 'postMessage', 0);
    } catch (_) {}
    return _origWindowPostMessage.apply(this, arguments);
  };
  wrappedPostMessage.__pdfdlHook = true;
  Window.prototype.postMessage = wrappedPostMessage;
}

const _OrigWorker = window.Worker;
if (_OrigWorker && !_OrigWorker.__pdfdlHook) {
  function PdfWorker(scriptURL, options) {
    const worker = new _OrigWorker(scriptURL, options);

    const _origPM = worker.postMessage.bind(worker);
    worker.postMessage = function (data) {
      try {
        captureAny(data, 'worker', 0);
      } catch (_) {}
      return _origPM.apply(worker, arguments);
    };

    worker.addEventListener('message', (event) => {
      try {
        captureAny(event.data, 'worker', 0);
      } catch (_) {}
      try {
        const url = extractPdfUrl(event.data);
        if (url) sendUrl(url);
      } catch (_) {}
    });

    return worker;
  }

  PdfWorker.prototype = _OrigWorker.prototype;
  PdfWorker.__pdfdlHook = true;
  try {
    Object.setPrototypeOf(PdfWorker, _OrigWorker);
  } catch (_) {}
  window.Worker = PdfWorker;
}

// ── Intercept fetch ───────────────────────────────────────────────────────────
// IMPORTANT: Do NOT use `async function` here — we must return the exact same
// Promise that the original fetch returns, preserving all internal browser
// optimizations (preload cache, credentials mode, priority hints, etc.).
// Using async would wrap it in an extra microtask Promise that can cause
// preload credential-mode mismatches in some browsers / frameworks.
const _origFetch = window.fetch;
window.fetch = function (...args) {
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input
      : (input instanceof Request ? input.url : '');
    if (url) {
      rememberFetch(url);
      if (isPdfUrl(url)) sendUrl(url);
    }
  } catch (_) {}
  // Pass through EXACTLY — no async wrapper, no Request reconstruction
  return _origFetch.apply(this, args);
};

// ── Intercept XHR ─────────────────────────────────────────────────────────────
const _origXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  try {
    if (typeof url === 'string') {
      rememberFetch(url);
      if (isPdfUrl(url)) sendUrl(url);
    }
  } catch (_) {}
  return _origXHROpen.call(this, method, url, ...rest);
};
