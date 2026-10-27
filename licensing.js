// licensing.js — Freemius-backed license validation
// Storage keys: pdfdl_usage (number), pdfdl_paid (boolean),
//               pdfdl_license_key (string), pdfdl_install_uid (string),
//               pdfdl_install_id (string), pdfdl_install_token (string)

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  ACTION REQUIRED: Set your Freemius public key below.
//    Find it in: freemius.com/members → Dashboard → Select product →
//    Developer → Keys → "Public Key" (starts with "pk_")
// ─────────────────────────────────────────────────────────────────────────────
const FREEMIUS = {
  productId: '31270',
  publicKey: 'pk_1b4335bca1c7f241107c840f5b8aa',
  planId: '51332',
  appTitle: 'PDF Downloader Pro (Chrome)',
};

export const FREE_LIMIT = 5;

// ── UID helper ────────────────────────────────────────────────────────────────
async function getOrCreateUID() {
  const data = await chrome.storage.local.get(['pdfdl_install_uid']);
  if (data.pdfdl_install_uid && data.pdfdl_install_uid.length === 32) {
    return data.pdfdl_install_uid;
  }
  let uid = '';
  const array = new Uint32Array(4);
  crypto.getRandomValues(array);
  for (let i = 0; i < array.length; i++) {
    uid += array[i].toString(16).padStart(8, '0');
  }
  await chrome.storage.local.set({ pdfdl_install_uid: uid });
  return uid;
}

// ── Check license status ──────────────────────────────────────────────────────
export async function checkLicense() {
  const data = await chrome.storage.local.get(['pdfdl_paid', 'pdfdl_license_key']);
  return {
    isPro: !!data.pdfdl_paid,
    licenseKey: data.pdfdl_license_key || null,
  };
}

// ── Activate a Freemius license key ──────────────────────────────────────────
export async function activateLicense(key) {
  const cleanKey = key.trim();
  if (!cleanKey) return { ok: false, error: 'Please enter a license key.' };

  try {
    const uid = await getOrCreateUID();
    const endpoint = `https://api.freemius.com/v1/products/${FREEMIUS.productId}/licenses/activate.json`;

    // Freemius requires a valid-looking email — derive one from the key
    const safeKey = cleanKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const dynamicEmail = `key-${safeKey.substring(0, 20)}@pdfdownloaderext.com`;

    const payload = new URLSearchParams({
      public_key: FREEMIUS.publicKey,
      license_key: cleanKey,
      uid,
      title: FREEMIUS.appTitle,
      is_pro_site: 'true',
      first_name: 'PDF',
      last_name: 'Downloader',
      user_email: dynamicEmail,
    });

    const response = await fetch(`${endpoint}?${payload.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });

    const json = await response.json();

    if (response.ok && !json.error) {
      await chrome.storage.local.set({
        pdfdl_license_key: cleanKey,
        pdfdl_paid: true,
        pdfdl_install_id: json.id ?? json.install_id ?? null,
        pdfdl_install_token: json.install_api_token ?? null,
      });
      return { ok: true };
    }

    const msg = json.error?.message || json.message || 'Activation failed. Check your key and try again.';
    return { ok: false, error: msg };

  } catch (e) {
    console.error('[PDFDownloader] License activation error:', e);
    return { ok: false, error: 'Network error — please check your connection and retry.' };
  }
}

// ── Deactivate license ────────────────────────────────────────────────────────
export async function deactivateLicense() {
  await chrome.storage.local.remove([
    'pdfdl_paid',
    'pdfdl_license_key',
    'pdfdl_install_id',
    'pdfdl_install_token',
  ]);
}

// ── Free download tracking ────────────────────────────────────────────────────
export async function getFreeDownloadCount() {
  const data = await chrome.storage.local.get(['pdfdl_usage']);
  return data.pdfdl_usage || 0;
}

export async function recordDownload() {
  const { isPro } = await checkLicense();
  if (isPro) return;
  const count = await getFreeDownloadCount();
  await chrome.storage.local.set({ pdfdl_usage: count + 1 });
}

export async function hasCreditsRemaining() {
  const { isPro } = await checkLicense();
  if (isPro) return true;
  const count = await getFreeDownloadCount();
  return count < FREE_LIMIT;
}

// ── Checkout / upgrade URL ────────────────────────────────────────────────────
export function getCheckoutUrl() {
  return `https://checkout.freemius.com/product/${FREEMIUS.productId}/plan/${FREEMIUS.planId}/`;
}
