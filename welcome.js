// welcome.js — Onboarding Page Logic
import { 
  checkLicense, 
  activateLicense, 
  getCheckoutUrl, 
  getFreeDownloadCount, 
  FREE_LIMIT 
} from './licensing.js';

document.addEventListener('DOMContentLoaded', async () => {
  // ── 1. Initialize Upgrade Links ──
  const checkoutUrl = getCheckoutUrl();
  const navUpgradeBtn = document.getElementById('navUpgradeBtn');
  const btnBuyLicensePage = document.getElementById('btnBuyLicensePage');
  
  if (navUpgradeBtn) navUpgradeBtn.href = checkoutUrl;
  if (btnBuyLicensePage) btnBuyLicensePage.href = checkoutUrl;

  // ── 2. Handle Pro / Free Status UI ──
  const freeStatusBox = document.getElementById('freeStatusBox');
  const proStatusBox = document.getElementById('proStatusBox');
  const freeCreditsDisplay = document.getElementById('freeCreditsDisplay');
  const freeProgressBar = document.getElementById('freeProgressBar');
  const activationFormWrapper = document.querySelector('.activation-form-wrapper');

  async function updateStatusUI() {
    const { isPro } = await checkLicense();
    
    if (isPro) {
      if (freeStatusBox) freeStatusBox.classList.add('hidden');
      if (proStatusBox) proStatusBox.classList.remove('hidden');
      if (activationFormWrapper) activationFormWrapper.classList.add('hidden');
      if (navUpgradeBtn) navUpgradeBtn.classList.add('hidden');
    } else {
      if (freeStatusBox) freeStatusBox.classList.remove('hidden');
      if (proStatusBox) proStatusBox.classList.add('hidden');
      if (activationFormWrapper) activationFormWrapper.classList.remove('hidden');
      if (navUpgradeBtn) navUpgradeBtn.classList.remove('hidden');

      const usedCount = await getFreeDownloadCount();
      const percent = Math.min(100, (usedCount / FREE_LIMIT) * 100);
      
      if (freeCreditsDisplay) {
        freeCreditsDisplay.textContent = `${usedCount} / ${FREE_LIMIT} free downloads used`;
      }
      if (freeProgressBar) {
        freeProgressBar.style.width = `${percent}%`;
      }
    }
  }

  await updateStatusUI();

  // ── 3. License Key Activation ──
  const licenseInputPage = document.getElementById('licenseInputPage');
  const btnActivatePage = document.getElementById('btnActivatePage');
  const activationErrorPage = document.getElementById('activationErrorPage');
  const activationSuccessPage = document.getElementById('activationSuccessPage');

  if (btnActivatePage && licenseInputPage) {
    btnActivatePage.addEventListener('click', async () => {
      const key = licenseInputPage.value.trim();
      
      // Reset status messages
      activationErrorPage.classList.add('hidden');
      activationSuccessPage.classList.add('hidden');
      btnActivatePage.disabled = true;
      btnActivatePage.textContent = 'Activating...';

      const result = await activateLicense(key);

      if (result.ok) {
        activationSuccessPage.classList.remove('hidden');
        licenseInputPage.value = '';
        btnActivatePage.textContent = 'Activated';
        
        // Wait 1.5s, then update UI to Pro view
        setTimeout(async () => {
          await updateStatusUI();
        }, 1500);
      } else {
        activationErrorPage.textContent = result.error || 'Activation failed.';
        activationErrorPage.classList.remove('hidden');
        btnActivatePage.disabled = false;
        btnActivatePage.textContent = 'Activate Pro';
      }
    });

    // Also support triggering on Enter key
    licenseInputPage.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnActivatePage.click();
      }
    });
  }

  // ── 4. Interactive Browser Simulator ──
  const simScanning = document.getElementById('simulatorScanning');
  const simDetected = document.getElementById('simulatorDetected');
  const simDownloading = document.getElementById('simulatorDownloading');
  const simSuccess = document.getElementById('simulatorSuccess');
  const simStatusDot = document.getElementById('simulatorStatusDot');
  const btnSimulateDownload = document.getElementById('btnSimulateDownload');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressBarPercent = document.getElementById('progressBarPercent');

  function startScanning() {
    // Show scanning state
    simScanning.classList.remove('hidden');
    simDetected.classList.add('hidden');
    simDownloading.classList.add('hidden');
    simSuccess.classList.add('hidden');
    
    simStatusDot.className = 'status-indicator-dot scanning';
    
    // After 2.5s, show detected
    setTimeout(() => {
      simScanning.classList.add('hidden');
      simDetected.classList.remove('hidden');
      simStatusDot.className = 'status-indicator-dot active';
    }, 2500);
  }

  // Initial simulator start
  startScanning();

  if (btnSimulateDownload) {
    btnSimulateDownload.addEventListener('click', () => {
      // Transition to downloading
      simDetected.classList.add('hidden');
      simDownloading.classList.remove('hidden');
      
      // Animate progress bar
      let progress = 0;
      progressBarFill.style.width = '0%';
      progressBarPercent.textContent = '0%';
      
      const interval = setInterval(() => {
        progress += 5;
        progressBarFill.style.width = `${progress}%`;
        progressBarPercent.textContent = `${progress}%`;
        
        if (progress >= 100) {
          clearInterval(interval);
          
          // Complete download
          setTimeout(() => {
            simDownloading.classList.add('hidden');
            simSuccess.classList.remove('hidden');
            
            // Restart simulator loop back to Detected state after 4 seconds
            setTimeout(() => {
              startScanning();
            }, 4000);
          }, 400);
        }
      }, 80);
    });
  }

  // ── 5. Interactive Pin Guide ──
  const mockPinBtn = document.querySelector('.mock-pin-btn');
  if (mockPinBtn) {
    mockPinBtn.addEventListener('click', () => {
      mockPinBtn.classList.toggle('pinned');
      if (mockPinBtn.classList.contains('pinned')) {
        mockPinBtn.textContent = '📌';
        mockPinBtn.style.color = '#FFF';
        mockPinBtn.title = 'Pinned!';
      } else {
        mockPinBtn.textContent = '📌';
        mockPinBtn.style.color = '';
        mockPinBtn.title = 'Click to Pin';
      }
    });
  }
});
