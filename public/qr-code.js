import qrcode from './vendor/qrcode.mjs?v=20261111fix8'
import { stringToBytes } from './vendor/qrcode_UTF8.mjs?v=20261111fix8'

qrcode.stringToBytes = stringToBytes

/**
 * Draw a UTF-8 QR code on a canvas. The vendored qrcode-generator keeps the
 * poster self-contained; no runtime network request or remote QR service.
 */
export function drawQrCode(ctx, text, x, y, size, { quiet = 4, dark = '#071018', light = '#ffffff' } = {}) {
  const qr = qrcode(0, 'M')
  qr.addData(String(text))
  qr.make()
  const count = qr.getModuleCount()
  const moduleSize = Math.max(1, Math.floor(size / (count + quiet * 2)))
  const total = moduleSize * (count + quiet * 2)
  const left = Math.round(x + (size - total) / 2)
  const top = Math.round(y + (size - total) / 2)

  ctx.save()
  ctx.fillStyle = light
  ctx.fillRect(left, top, total, total)
  ctx.fillStyle = dark
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue
      ctx.fillRect(
        left + (col + quiet) * moduleSize,
        top + (row + quiet) * moduleSize,
        moduleSize,
        moduleSize,
      )
    }
  }
  ctx.restore()
  return { left, top, total }
}
