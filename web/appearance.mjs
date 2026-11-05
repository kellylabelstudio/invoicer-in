export const appearanceModes = [
  ['auto', 'Auto', 'monitor'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon']
];

const storageKey = 'invoicer-appearance';
const system = matchMedia('(prefers-color-scheme: dark)');
const isMode = value => appearanceModes.some(([mode]) => mode === value);
const saved = localStorage.getItem(storageKey);
let preference = isMode(saved) ? saved : 'auto';
let windowUpdate = Promise.resolve();

export const appearanceMode = () => preference;

function paintAppearance() {
  document.documentElement.dataset.theme = preference === 'auto' ? (system.matches ? 'dark' : 'light') : preference;
  const icon = document.querySelector('[data-appearance-icon]');
  if (icon) icon.setAttribute('href', '#i-' + appearanceModes.find(([mode]) => mode === preference)[2]);
  for (const control of document.querySelectorAll('[data-appearance]')) {
    if (control.type === 'radio') control.checked = control.value === preference;
    else control.value = preference;
  }
}

function syncWindow() {
  const theme = preference === 'auto' ? null : preference;
  windowUpdate = windowUpdate
    .then(() => globalThis.__TAURI__?.window?.getCurrentWindow()?.setTheme(theme))
    .catch(() => {})
    .then(paintAppearance);
}

export function setAppearance(value) {
  if (!isMode(value)) return;
  preference = value;
  localStorage.setItem(storageKey, value);
  paintAppearance();
  syncWindow();
}

system.addEventListener('change', paintAppearance);
paintAppearance();
syncWindow();
