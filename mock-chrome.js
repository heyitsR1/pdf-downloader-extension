// mock-chrome.js — Mock Chrome Extension API for local HTML page previews
if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
  console.log('PDF Downloader: Local preview mode detected. Injecting Chrome API mocks.');
  window.chrome = {
    runtime: {
      getURL: (path) => path,
    },
    storage: {
      local: {
        get: async (keys) => {
          const res = {};
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach(k => {
            if (k === 'pdfdl_paid') res[k] = localStorage.getItem('pdfdl_paid') === 'true';
            if (k === 'pdfdl_usage') res[k] = parseInt(localStorage.getItem('pdfdl_usage') || '0', 10);
            if (k === 'pdfdl_license_key') res[k] = localStorage.getItem('pdfdl_license_key') || '';
          });
          return res;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            localStorage.setItem(k, v);
          }
          console.log('[Mock Storage Set]', obj);
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach(k => localStorage.removeItem(k));
          console.log('[Mock Storage Remove]', keys);
        }
      }
    }
  };
}
