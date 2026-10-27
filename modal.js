// modal.js — post-download overlay, injected into active tab by background.js
// Idempotent: only one instance runs per page load

(function () {
  'use strict';

  if (window.__pdfdl_modal_loaded) return;
  window.__pdfdl_modal_loaded = true;

  const UPGRADE_URL = 'https://checkout.freemius.com/product/31270/plan/51332/';
  const SUPPORT_EMAIL = 'aarohan@tailsgate.com';

  // ── Styles (injected once) ──────────────────────────────────────────────────
  const styleId = 'pdfdl-modal-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #pdfdl-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483640;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: pdfdl-fadeIn 300ms ease forwards;
      }

      @keyframes pdfdl-fadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      @keyframes pdfdl-slideUp {
        from { opacity: 0; transform: translateY(24px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)   scale(1); }
      }

      @keyframes pdfdl-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%       { opacity: 0.5; transform: scale(1.25); }
      }

      #pdfdl-modal {
        width: 380px;
        max-width: calc(100vw - 32px);
        background: #1A1A1A;
        border-radius: 16px;
        border: 1px solid rgba(229, 62, 62, 0.2);
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        padding: 28px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #F7F7F7;
        animation: pdfdl-slideUp 300ms ease forwards;
        position: relative;
        box-sizing: border-box;
      }

      #pdfdl-modal * { box-sizing: border-box; }

      #pdfdl-close-btn {
        position: absolute;
        top: 16px;
        right: 16px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(255,255,255,0.07);
        border: none;
        color: #A0A0A0;
        font-size: 14px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 150ms ease, color 150ms ease;
        line-height: 1;
        font-family: inherit;
      }

      #pdfdl-close-btn:hover {
        background: rgba(255,255,255,0.12);
        color: #F7F7F7;
      }

      .pdfdl-check-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 16px;
      }

      .pdfdl-check-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(72, 187, 120, 0.12);
        border: 1px solid rgba(72, 187, 120, 0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: #48BB78;
        font-size: 16px;
      }

      .pdfdl-heading {
        font-size: 16px;
        font-weight: 700;
        color: #F7F7F7;
        margin: 0 0 3px;
        line-height: 1.3;
      }

      .pdfdl-subtext {
        font-size: 12px;
        color: #666666;
        font-weight: 500;
        margin: 0;
      }

      .pdfdl-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 16px 0;
      }

      .pdfdl-credits-label {
        font-size: 11px;
        color: #A0A0A0;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 8px;
        display: block;
      }

      .pdfdl-progress-track {
        height: 4px;
        background: rgba(255, 255, 255, 0.07);
        border-radius: 99px;
        overflow: hidden;
        margin-bottom: 8px;
      }

      .pdfdl-progress-fill {
        height: 100%;
        background: #E53E3E;
        border-radius: 99px;
        box-shadow: 0 0 8px rgba(229, 62, 62, 0.5);
        transition: width 600ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .pdfdl-credits-warning {
        font-size: 12px;
        color: #E53E3E;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .pdfdl-credits-warning-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #E53E3E;
        flex-shrink: 0;
        animation: pdfdl-pulse 1.5s infinite;
      }

      .pdfdl-upgrade-card {
        background: #222222;
        border-radius: 12px;
        border: 1px solid rgba(229, 62, 62, 0.15);
        padding: 16px;
        margin: 16px 0 0;
      }

      .pdfdl-upgrade-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      .pdfdl-upgrade-crown {
        font-size: 16px;
        line-height: 1;
      }

      .pdfdl-upgrade-title {
        font-size: 13px;
        font-weight: 700;
        color: #F7F7F7;
      }

      .pdfdl-benefits {
        list-style: none;
        padding: 0;
        margin: 0 0 14px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .pdfdl-benefits li {
        font-size: 12px;
        color: #A0A0A0;
        display: flex;
        align-items: center;
        gap: 7px;
      }

      .pdfdl-benefit-check {
        color: #E53E3E;
        font-size: 11px;
        flex-shrink: 0;
      }

      .pdfdl-btn-cta {
        width: 100%;
        background: #E53E3E;
        color: #fff;
        border: none;
        border-radius: 12px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 700;
        padding: 12px 16px;
        cursor: pointer;
        transition: background 150ms ease, transform 150ms ease, box-shadow 150ms ease;
        letter-spacing: 0.01em;
        box-shadow: 0 4px 16px rgba(229, 62, 62, 0.3);
      }

      .pdfdl-btn-cta:hover {
        background: #C53030;
        transform: scale(1.02);
        box-shadow: 0 6px 20px rgba(229, 62, 62, 0.4);
      }

      .pdfdl-no-sub-note {
        font-size: 10px;
        color: #666666;
        text-align: center;
        margin-top: 6px;
        display: block;
      }

      .pdfdl-footer-row {
        margin-top: 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .pdfdl-maybe-later {
        font-size: 11px;
        color: #666666;
        background: none;
        border: none;
        cursor: pointer;
        font-family: inherit;
        padding: 0;
        transition: color 150ms ease;
      }

      .pdfdl-maybe-later:hover { color: #A0A0A0; }

      .pdfdl-support-link {
        font-size: 11px;
        color: #666666;
        text-decoration: none;
        transition: color 150ms ease;
      }

      .pdfdl-support-link:hover { color: #A0A0A0; }

      .pdfdl-pro-note {
        font-size: 12px;
        color: #A0A0A0;
        font-weight: 500;
        margin-top: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .pdfdl-pro-star { color: #E53E3E; }

      .pdfdl-dismiss-btn {
        width: 100%;
        background: rgba(255,255,255,0.06);
        color: #A0A0A0;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        padding: 10px 16px;
        cursor: pointer;
        margin-top: 16px;
        transition: background 150ms ease, color 150ms ease;
      }

      .pdfdl-dismiss-btn:hover {
        background: rgba(255,255,255,0.1);
        color: #F7F7F7;
      }

      .pdfdl-license-box {
        margin: 14px 0 0;
        padding: 14px;
        background: #1F1F1F;
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 12px;
      }

      .pdfdl-license-title {
        font-size: 12px;
        font-weight: 700;
        color: #F7F7F7;
        margin: 0 0 8px;
      }

      .pdfdl-license-row {
        display: flex;
        gap: 8px;
      }

      .pdfdl-license-input {
        flex: 1;
        min-width: 0;
        background: #121212;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 9px;
        color: #F7F7F7;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        padding: 9px 10px;
        outline: none;
      }

      .pdfdl-license-input:focus {
        border-color: rgba(229, 62, 62, 0.65);
        box-shadow: 0 0 0 2px rgba(229, 62, 62, 0.15);
      }

      .pdfdl-license-input::placeholder { color: #5A5A5A; }

      .pdfdl-license-btn {
        background: #E53E3E;
        color: #fff;
        border: none;
        border-radius: 9px;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        padding: 9px 14px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 150ms ease;
      }

      .pdfdl-license-btn:hover:not(:disabled) { background: #C53030; }
      .pdfdl-license-btn:disabled { opacity: 0.65; cursor: default; }

      .pdfdl-license-msg {
        font-size: 11px;
        margin: 8px 0 0;
        font-weight: 600;
        line-height: 1.4;
      }

      .pdfdl-license-msg.is-error { color: #F56565; }
      .pdfdl-license-msg.is-ok { color: #48BB78; }
      .pdfdl-license-msg.hidden { display: none; }
    `;
    document.head.appendChild(style);
  }

  // ── Build modal DOM ─────────────────────────────────────────────────────────
  function buildModal(data) {
    const { filename, isPro, used, remaining, freeLimit, isLimitReached } = data;
    const pct = Math.min(100, (used / freeLimit) * 100);
    const displayName = filename || 'document.pdf';

    const backdrop = document.createElement('div');
    backdrop.id = 'pdfdl-backdrop';

    const modal = document.createElement('div');
    modal.id = 'pdfdl-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'PDF Download Status');

    let innerHTML = `
      <button id="pdfdl-close-btn" aria-label="Close">✕</button>`;

    if (isLimitReached) {
      innerHTML += `
        <div class="pdfdl-check-row">
          <div class="pdfdl-check-icon" style="background: rgba(229, 62, 62, 0.12); border-color: rgba(229, 62, 62, 0.25); color: #E53E3E;">✕</div>
          <div>
            <p class="pdfdl-heading">Download Blocked</p>
            <p class="pdfdl-subtext">You've reached your free limit</p>
          </div>
        </div>`;
    } else {
      innerHTML += `
        <div class="pdfdl-check-row">
          <div class="pdfdl-check-icon">✓</div>
          <div>
            <p class="pdfdl-heading">Your PDF is downloading</p>
            <p class="pdfdl-subtext">${displayName} · Saved to Downloads</p>
          </div>
        </div>`;
    }

    if (isPro) {
      innerHTML += `
        <div class="pdfdl-pro-note">
          <span class="pdfdl-pro-star">✦</span>
          Pro · Unlimited downloads
        </div>
        <button class="pdfdl-dismiss-btn" id="pdfdl-dismiss-btn">Dismiss</button>`;
    } else {
      innerHTML += `
        <div class="pdfdl-divider"></div>
        <span class="pdfdl-credits-label">${used} of ${freeLimit} free credits used</span>
        <div class="pdfdl-progress-track">
          <div class="pdfdl-progress-fill" style="width: ${pct}%"></div>
        </div>
        ${remaining <= 1 ? `
          <div class="pdfdl-credits-warning">
            <span class="pdfdl-credits-warning-dot"></span>
            ${remaining === 0
              ? "You've used all your free credits"
              : `⚠ ${remaining} credit remaining`}
          </div>` : ''}

        <div class="pdfdl-upgrade-card">
          <div class="pdfdl-upgrade-header">
            <span class="pdfdl-upgrade-crown">🔓</span>
            <span class="pdfdl-upgrade-title">Unlock Restricted & Embedded PDFs</span>
          </div>
          <ul class="pdfdl-benefits">
            <li><span class="pdfdl-benefit-check">✦</span>Bypass disabled/locked download buttons</li>
            <li><span class="pdfdl-benefit-check">✦</span>Extract restricted view-only or print-blocked PDFs</li>
            <li><span class="pdfdl-benefit-check">✦</span>Batch download all PDFs on a page</li>
            <li><span class="pdfdl-benefit-check">✦</span>One-time payment · Own it forever</li>
          </ul>
          <button class="pdfdl-btn-cta" id="pdfdl-upgrade-btn">
            Unlock All PDFs Now · $4.99
          </button>
          <span class="pdfdl-no-sub-note">No subscriptions. No recurring fees. Ever.</span>
        </div>

        <div class="pdfdl-license-box">
          <p class="pdfdl-license-title">Already purchased? Enter your license key</p>
          <div class="pdfdl-license-row">
            <input
              id="pdfdl-license-input"
              class="pdfdl-license-input"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="Paste your license key"
              aria-label="License key"
            />
            <button class="pdfdl-license-btn" id="pdfdl-license-btn">Activate</button>
          </div>
          <p class="pdfdl-license-msg hidden" id="pdfdl-license-msg"></p>
        </div>

        <div class="pdfdl-footer-row">
          <button class="pdfdl-maybe-later" id="pdfdl-maybe-later">Maybe later</button>
          <a href="mailto:${SUPPORT_EMAIL}" class="pdfdl-support-link">Need help? Contact us →</a>
        </div>`;
    }

    modal.innerHTML = innerHTML;
    backdrop.appendChild(modal);

    if (isPro) {
      setTimeout(close, 3000);
    }

    return backdrop;
  }

  // ── Show modal ──────────────────────────────────────────────────────────────
  let activeBackdrop = null;

  function close() {
    if (activeBackdrop) {
      activeBackdrop.style.opacity = '0';
      activeBackdrop.style.transition = 'opacity 200ms ease';
      setTimeout(() => {
        activeBackdrop?.remove();
        activeBackdrop = null;
      }, 200);
    }
  }

  function showModal(data) {
    // Remove any existing modal
    document.getElementById('pdfdl-backdrop')?.remove();

    activeBackdrop = buildModal(data);
    document.body.appendChild(activeBackdrop);

    // Event listeners
    activeBackdrop.addEventListener('click', (e) => {
      if (e.target === activeBackdrop) close();
    });

    const closeBtn = activeBackdrop.querySelector('#pdfdl-close-btn');
    closeBtn?.addEventListener('click', close);

    const dismissBtn = activeBackdrop.querySelector('#pdfdl-dismiss-btn');
    dismissBtn?.addEventListener('click', close);

    const upgradeBtn = activeBackdrop.querySelector('#pdfdl-upgrade-btn');
    upgradeBtn?.addEventListener('click', () => {
      window.open(UPGRADE_URL, '_blank');
      close();
    });

    const maybeLater = activeBackdrop.querySelector('#pdfdl-maybe-later');
    maybeLater?.addEventListener('click', close);

    // ── License activation from inside the paywall ───────────────────────────
    // Mohit paid and then had no way in: activation only existed in the popup
    // behind a small text link. This is the same activation path, reachable
    // from the modal he actually sees when credits run out.
    const licenseInput = activeBackdrop.querySelector('#pdfdl-license-input');
    const licenseBtn = activeBackdrop.querySelector('#pdfdl-license-btn');
    const licenseMsg = activeBackdrop.querySelector('#pdfdl-license-msg');

    function setLicenseMsg(text, kind) {
      if (!licenseMsg) return;
      licenseMsg.textContent = text;
      licenseMsg.classList.remove('hidden', 'is-error', 'is-ok');
      licenseMsg.classList.add(kind === 'ok' ? 'is-ok' : 'is-error');
    }

    async function activate() {
      const key = String(licenseInput?.value || '').trim();
      if (!key) {
        setLicenseMsg('Please enter your license key.', 'error');
        licenseInput?.focus();
        return;
      }
      if (licenseBtn) {
        licenseBtn.disabled = true;
        licenseBtn.textContent = 'Activating…';
      }
      setLicenseMsg('Contacting the license server…', 'ok');
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'ACTIVATE_LICENSE',
          key,
          origin: 'paywall-modal',
        });
        if (res?.ok) {
          setLicenseMsg('✓ Activated. Pro is unlocked — you can download now.', 'ok');
          if (licenseBtn) licenseBtn.textContent = '✓ Activated';
          setTimeout(close, 1800);
        } else {
          setLicenseMsg(res?.error || 'Activation failed. Please check your key.', 'error');
          if (licenseBtn) {
            licenseBtn.disabled = false;
            licenseBtn.textContent = 'Activate';
          }
        }
      } catch (err) {
        setLicenseMsg('Could not reach the extension. Reload the page and try again.', 'error');
        if (licenseBtn) {
          licenseBtn.disabled = false;
          licenseBtn.textContent = 'Activate';
        }
      }
    }

    licenseBtn?.addEventListener('click', activate);
    licenseInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        activate();
      }
    });
  }

  // ── Listen for trigger from background ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SHOW_DOWNLOAD_MODAL') {
      showModal(msg);
    }
  });

})();
