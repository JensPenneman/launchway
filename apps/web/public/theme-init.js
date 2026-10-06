// Runs before first paint; mirrors src/lib/theme.ts (storage key and resolution rules).
(() => {
  try {
    const stored = localStorage.getItem('slipway-theme');
    const preference = stored === 'light' || stored === 'dark' ? stored : 'system';
    const dark =
      preference === 'dark' ||
      (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    // Storage may be unavailable (privacy mode); fall back to the light theme.
  }
})();
