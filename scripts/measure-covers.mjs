import { readdirSync, statSync } from 'node:fs'

const dir = 'storage/images'
const files = readdirSync(dir).filter((f) => /^cover-.*\.jpe?g$/i.test(f))
let o = 0
let v = 0
let n = 0
let miss = 0
for (const f of files) {
  const variant = `${dir}/variants/${f.replace(/\.jpe?g$/i, '-w320.webp')}`
  try {
    statSync(variant)
  } catch {
    miss += 1
    continue
  }
  o += statSync(`${dir}/${f}`).size
  v += statSync(variant).size
  n += 1
}
console.log(`封面样本 ${n} 张（缺变体 ${miss} 张）：原图平均 ${(o / n / 1024).toFixed(0)}KB → w320 平均 ${(v / n / 1024).toFixed(1)}KB，缩小 ${(o / v).toFixed(1)} 倍`)
console.log(`片库一页 24 张卡：${((o / n) * 24 / 1048576).toFixed(2)}MB → ${(((v / n) * 24) / 1024).toFixed(0)}KB`)
