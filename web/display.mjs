// Physical window pixels and Windows DPI stay independent of webview zoom.
export function smartInterfacePercent({width, height}, scaleFactor = 1) {
  if (![width, height, scaleFactor].every(value => Number.isFinite(value) && value > 0)) return 100;
  const w = width / scaleFactor, h = height / scaleFactor;
  if (w < 780 || h < 550) return 75;
  if (w < 960 || h < 630) return 80;
  if (w < 1120 || h < 740) return 90;
  return 100;
}
