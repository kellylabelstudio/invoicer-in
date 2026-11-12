import { smartInterfacePercent } from './display.mjs';

export const appearanceModes = [
  ['auto', 'Match Windows', 'monitor'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon']
];
export const interfaceSizes = ['smart', '100', '90', '80', '75'];

const storageKey = 'invoicer-appearance';
const sizeKey = 'invoicer-interface-size';
const system = matchMedia('(prefers-color-scheme: dark)');
const isMode = value => appearanceModes.some(([mode]) => mode === value);
const saved = localStorage.getItem(storageKey);
const savedSize = localStorage.getItem(sizeKey);
let preference = isMode(saved) ? saved : 'light';
let size = interfaceSizes.includes(savedSize) ? savedSize : 'smart';
let windowUpdate = Promise.resolve();
let zoomUpdate = Promise.resolve();
let appliedPercent = 100;
let lastZoom = null;
let sizeRevision = 0;
let resizeTimer;
const desktopWindow = globalThis.__TAURI__?.window?.getCurrentWindow();

export const appearanceMode = () => preference;
export const interfaceSize = () => size;
export const interfaceSizeLabel = () => `${size === 'smart' ? 'Smart ✨ · ' : ''}${appliedPercent}%`;
export function paintDisplayControls() {
  for (const node of document.querySelectorAll('[data-display-size]')) node.textContent = interfaceSizeLabel();
  for (const node of document.querySelectorAll('[data-display-hint]')) node.textContent = size === 'smart'
    ? `Currently ${appliedPercent}%. Adjusts to the window and Windows display scaling as you resize or move between monitors.`
    : `Fixed at ${appliedPercent}%. Choose Smart to adjust automatically.`;
}
const visualKey='invoicer-visual-mode';
const densityKey='invoicer-density';
export const visualMode=()=>localStorage.getItem(visualKey)==='performance'?'performance':'beautiful';
export const density=()=>localStorage.getItem(densityKey)==='compact'?'compact':'comfortable';
export function setVisualMode(value) {
  if(!['performance','beautiful'].includes(value))return;
  localStorage.setItem(visualKey,value);document.documentElement.dataset.visualMode=value;
}
export function setDensity(value) {
  if(!['compact','comfortable'].includes(value))return;
  localStorage.setItem(densityKey,value);document.documentElement.dataset.density=value;
}

function paintAppearance() {
  document.documentElement.dataset.theme = preference === 'auto' ? (system.matches ? 'dark' : 'light') : preference;
  const icon = document.querySelector('[data-appearance-icon]');
  if (icon) icon.setAttribute('href', '#i-' + appearanceModes.find(([mode]) => mode === preference)[2]);
  for (const control of document.querySelectorAll('[data-appearance]')) {
    if (control.tagName === 'BUTTON') control.setAttribute('aria-pressed',String(control.dataset.appearance === preference));
    else if (control.type === 'radio') control.checked = control.value === preference;
    else control.value = preference;
  }
}

function syncWindow() {
  const theme = preference === 'auto' ? null : preference;
  windowUpdate = windowUpdate
    .then(() => desktopWindow?.setTheme(theme))
    .catch(() => {})
    .then(paintAppearance);
  return windowUpdate;
}

export function setAppearance(value) {
  if (!isMode(value)) return;
  preference = value;
  localStorage.setItem(storageKey, value);
  paintAppearance();
  syncWindow();
}

function syncZoom(percent) {
  zoomUpdate = zoomUpdate.catch(() => {}).then(async () => {
    if (lastZoom === percent) return;
    const webview = globalThis.__TAURI__?.webview?.getCurrentWebview();
    if (webview) await webview.setZoom(percent / 100);
    lastZoom = percent;
    appliedPercent = percent;
    paintDisplayControls();
  });
  return zoomUpdate;
}

async function smartPercent() {
  if (!desktopWindow?.innerSize || !desktopWindow?.scaleFactor) return 100;
  const [pixels, scaleFactor] = await Promise.all([desktopWindow.innerSize(), desktopWindow.scaleFactor()]);
  return smartInterfacePercent(pixels, scaleFactor);
}

export async function setInterfaceSize(value) {
  if (!interfaceSizes.includes(value)) return;
  const previous = size, revision = ++sizeRevision;
  size = value;
  try {
    const percent = value === 'smart' ? await smartPercent() : Number(value);
    if (revision !== sizeRevision) return;
    await syncZoom(percent);
    if (revision !== sizeRevision) return;
    localStorage.setItem(sizeKey, value);
    paintDisplayControls();
  } catch (error) {
    if (revision === sizeRevision) size = previous;
    throw error;
  }
}

async function refreshSmartSize() {
  if (size !== 'smart') return;
  const revision = ++sizeRevision;
  try {
    const percent = await smartPercent();
    if (revision === sizeRevision && size === 'smart') await syncZoom(percent);
  } catch {
    // Keep the last working scale if Windows temporarily cannot report the display.
  }
}

function queueSmartSize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refreshSmartSize, 180);
}

async function initialiseDisplay() {
  await syncWindow();
  if (size === 'smart') await refreshSmartSize();
  else await syncZoom(Number(size));
  for (const name of ['onResized', 'onMoved', 'onScaleChanged']) {
    try { await desktopWindow?.[name]?.(queueSmartSize); } catch { /* Scaling remains available in Settings. */ }
  }
}

system.addEventListener('change', paintAppearance);
paintAppearance();
document.documentElement.dataset.visualMode=visualMode();
document.documentElement.dataset.density=density();
export const displayReady = initialiseDisplay().catch(() => {});
