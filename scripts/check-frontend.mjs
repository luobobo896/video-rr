/**
 * 零依赖前端静态检查：node --check 只能发现语法错误，
 * 这里补一层轻量的 no-undef 启发式检查，专门抓 openOverlay 这类漏声明调用。
 *
 * 不是完整 AST 检查器：忽略字符串/注释/模板文本，覆盖函数声明、变量、
 * import 与常见参数形态；动态构造函数调用若无法静态确认，会给出显式告警。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const FILES = [
  'public/base.js',
  'public/main.js',
  'public/app.js',
  'public/i18n.js',
  'public/track-match.js',
  'public/poster-wall-view.js',
  'public/qr-code.js',
  'admin/base.js',
  'admin/main.js',
  'admin/app.js',
]
const VERSION_FILES = [...FILES, 'public/index.html', 'admin/index.html']
const STYLE_FILES = ['public/styles.css', 'public/poster-wall.css', 'admin/styles.css']
const VUE_FILES = []
function collectVueFiles(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
    const relative = join(dir, entry.name)
    if (entry.isDirectory()) collectVueFiles(relative)
    else if (entry.name.endsWith('.vue')) VUE_FILES.push(relative)
  }
}
collectVueFiles('.')
/** Element Plus 受控输入组件：没有 v-model/:model-value 时，用户输入会被组件重置。 */
const MODEL_REQUIRED = new Set([
  'el-input',
  'el-input-number',
  'el-autocomplete',
  'el-select',
  'el-cascader',
  'el-date-picker',
  'el-time-picker',
  'el-time-select',
  'el-color-picker',
  'el-slider',
  'el-rate',
  'el-switch',
  'el-checkbox-group',
  'el-radio-group',
  'el-segmented',
  'el-upload',
  'el-transfer',
])

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'void',
  'new', 'delete', 'in', 'of', 'instanceof', 'await', 'yield', 'throw', 'case', 'else',
  'do', 'try', 'finally', 'class', 'const', 'let', 'var', 'async', 'import', 'export', 'from',
  'as', 'super', 'this', 'true', 'false', 'null', 'undefined',
])

const GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'Reflect', 'Proxy', 'Symbol',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'Blob', 'File', 'FileReader',
  'FormData', 'Headers', 'Request', 'Response', 'Image', 'Audio', 'CustomEvent', 'Event',
  'EventTarget', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLImageElement',
  'HTMLInputElement', 'HTMLVideoElement', 'HTMLMediaElement', 'HTMLCanvasElement',
  'CanvasRenderingContext2D', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'crypto', 'performance', 'navigator', 'localStorage', 'sessionStorage', 'document', 'window',
  'console', 'location', 'history', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'TextEncoder', 'TextDecoder', 'MediaSource', 'WebSocket', 'Worker', 'getComputedStyle',
  'matchMedia', 'scrollTo', 'scrollBy', 'open', 'close', 'print', 'postMessage',
  // CSS value functions that can appear inside template strings we intentionally ignore.
  'min', 'max', 'clamp', 'calc', 'var', 'rgb', 'rgba', 'hsl', 'hsla', 'oklab', 'oklch',
  'color-mix', 'linear-gradient', 'radial-gradient',
])

function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  let mode = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (mode === 'line') {
      if (ch === '\n') { mode = null; out += '\n' }
      else out += ' '
      i += 1
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = null; out += '  '; i += 2 } else { out += ch === '\n' ? '\n' : ' '; i += 1 }
      continue
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (ch === '\\') { out += '  '; i += 2; continue }
      if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') || (mode === 'template' && ch === '`')) {
        mode = null
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue }
    if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      mode = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template'
      out += ' '
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function identifiersIn(text) {
  return [...String(text).matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0])
}

function openingElementTags(source) {
  const tags = []
  for (const match of source.matchAll(/<(el-[a-z0-9-]+)\b/g)) {
    let i = match.index + match[0].length
    let quote = ''
    while (i < source.length) {
      const ch = source[i]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      i += 1
    }
    tags.push({ tag: match[1], attrs: source.slice(match.index + match[0].length, i) })
  }
  return tags
}

function collectDeclared(source, code) {
  const declared = new Set()
  for (const match of source.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    for (const name of identifiersIn(match[1])) {
      if (!KEYWORDS.has(name)) declared.add(name)
    }
  }
  for (const regex of [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:const|let|var)\s*\{([^}]*)\}/g,
    /\b(?:const|let|var)\s*\[([^\]]*)\]/g,
  ]) {
    for (const match of source.matchAll(regex)) {
      for (const name of identifiersIn(match[1])) {
        if (!KEYWORDS.has(name)) declared.add(name)
      }
    }
  }
  for (const match of source.matchAll(/\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    for (const name of identifiersIn(match[1])) {
      if (!KEYWORDS.has(name)) declared.add(name)
    }
  }
  for (const match of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of identifiersIn(match[1])) {
      if (!KEYWORDS.has(name)) declared.add(name)
    }
  }
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) {
    declared.add(match[1])
  }
  return declared
}

let failed = false
const versions = new Set()
for (const file of FILES) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const code = stripCommentsAndStrings(source)
    .replace(/\/(?:\\.|[^\/\n])+\/[dgimsuvy]*/g, (match) => match[0] + ' '.repeat(match.length - 1))
  const declared = collectDeclared(source, code)
  const missing = new Map()
  for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
    const specifier = match[1]
    const target = resolve(dirname(join(ROOT, file)), specifier.split('?')[0])
    if (!existsSync(target)) {
      failed = true
      console.error(`${file}: 相对导入不存在: ${specifier}`)
    }
  }
  for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]
    if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue
    const line = code.slice(0, match.index).split('\n').length
    if (!missing.has(name)) missing.set(name, [])
    missing.get(name).push(line)
  }
  if (missing.size) {
    failed = true
    for (const [name, lines] of missing) {
      console.error(`${file}:${lines[0]}: ${name}() 未在静态作用域中找到声明`)
    }
  }
}

for (const file of VERSION_FILES) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  for (const match of source.matchAll(/\?v=([A-Za-z0-9._-]+)/g)) versions.add(match[1])
}
if (versions.size > 1) {
  failed = true
  console.error(`静态资源版本不一致: ${[...versions].sort().join(', ')}`)
}

for (const file of STYLE_FILES) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  if (/^\s*:root\s*\{/m.test(source)) {
    failed = true
    console.error(`${file}: 页面样式不得重复定义 :root，根令牌只能来自 tokens.css`)
  }
  if (file === 'admin/styles.css' && /#ff(?:3d6e|7a45|4d6d)/i.test(source)) {
    failed = true
    console.error(`${file}: 后台样式不得使用 C 端粉色品牌值`)
  }
}

for (const file of VUE_FILES) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const imported = new Set()
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]element-plus['"]/g)) {
    for (const name of identifiersIn(match[1])) imported.add(name)
  }
  for (const match of source.matchAll(/<(el-[a-z0-9-]+)\b/g)) {
    const tag = match[1]
    const component = tag.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase())
    if (imported.has(component)) continue
    failed = true
    console.error(`${file}: 模板使用 <${tag}> 但未从 element-plus 导入 ${component}`)
  }
  for (const { tag, attrs } of openingElementTags(source)) {
    if (!MODEL_REQUIRED.has(tag)) continue
    if (/(^|\s)(v-model(?::[\w-]+)?|:model-value|model-value)\s*=/.test(attrs)) continue
    failed = true
    console.error(`${file}: <${tag}> 缺少 v-model 或 :model-value 绑定，用户输入会被重置`)
  }
  if (file === 'public/components/AppSidebar.vue') {
    const groups = source.match(/const groups = computed\(\(\) => \{[\s\S]*?\n\}\)/)
    if (!groups?.[0].includes('chromeState.lang')) {
      failed = true
      console.error(`${file}: 侧栏分组必须依赖 chromeState.lang，否则切换语言不会即时重算`)
    }
  }
}

const nginxSnippet = readFileSync(join(ROOT, 'deploy/nginx-video.snippet.conf'), 'utf8')
for (const [label, path] of [
  ['C 端', '/opt/video-rr/dist/client/'],
  ['后台', '/opt/video-rr/dist/admin/'],
]) {
  if (!nginxSnippet.includes(`alias ${path}`)) {
    failed = true
    console.error(`deploy/nginx-video.snippet.conf: ${label}必须直接提供构建产物 ${path}`)
  }
}
for (const sourcePath of ['/opt/video-rr/public/', '/opt/video-rr/admin/']) {
  if (nginxSnippet.includes(`alias ${sourcePath}`)) {
    failed = true
    console.error(`deploy/nginx-video.snippet.conf: 不得直接提供源码目录 ${sourcePath}`)
  }
}

if (failed) process.exit(1)
console.log(`frontend checks: ${FILES.length} files clean; asset version ${[...versions].join(', ') || 'n/a'}`)
