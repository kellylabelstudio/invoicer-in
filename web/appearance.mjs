export const appearanceModes = [
  ['auto', 'Auto', 'monitor'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon']
];
export const interfaceSizes = ['100', '90', '80', '75'];

const storageKey = 'invoicer-appearance';
const sizeKey = 'invoicer-interface-size';
const system = matchMedia('(prefers-color-scheme: dark)');
const isMode = value => appearanceModes.some(([mode]) => mode === value);
const saved = localStorage.getItem(storageKey);
const savedSize = localStorage.getItem(sizeKey);
let preference = isMode(saved) ? saved : 'auto';
let size = interfaceSizes.includes(savedSize) ? savedSize : '100';
let windowUpdate = Promise.resolve();
let zoomUpdate = Promise.resolve();

export const appearanceMode = () => preference;
export const interfaceSize = () => size;

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

function syncZoom(value) {
  zoomUpdate = zoomUpdate.catch(() => {}).then(() => {
    const webview = globalThis.__TAURI__?.webview?.getCurrentWebview();
    return webview?.setZoom(Number(value) / 100);
  });
  return zoomUpdate;
}

export async function setInterfaceSize(value) {
  if (!interfaceSizes.includes(value)) return;
  await syncZoom(value);
  localStorage.setItem(sizeKey, value);
  size = value;
}

system.addEventListener('change', paintAppearance);
paintAppearance();
syncWindow();
if (size !== '100') syncZoom(size).catch(() => {});
