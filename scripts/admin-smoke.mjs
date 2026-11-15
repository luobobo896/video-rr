import { spawn } from 'node:child_process'

const url = process.env.MH_ADMIN_URL || 'http://127.0.0.1:5174/'
const user = process.env.MH_ADMIN_USER || ''
const password = process.env.MH_ADMIN_PASSWORD || ''

if (!user || !password) {
  console.error('需要 MH_ADMIN_USER 和 MH_ADMIN_PASSWORD；只对本地或测试后台运行。')
  process.exit(2)
}

const script = `
let task
try {
  task = await taskSpace("mh-admin-browser-smoke")
  const page = task.page("p1")
  await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" })
  let shellReady = false
  try {
    await page.waitForSelector("#shell:not(.hidden)", { state: "visible", timeout: 2000 })
    shellReady = true
  } catch {}
  if (!shellReady) {
    await page.waitForSelector("#login-form:not(.hidden)", { state: "visible", timeout: 10000 })
    await page.fill("#login-user", ${JSON.stringify(user)})
    await page.fill("#login-pass", ${JSON.stringify(password)})
    await page.click("#login-form button.login-submit")
    await page.waitForSelector("#shell:not(.hidden)", { state: "visible", timeout: 15000 })
  }
  if (await page.evaluate(() => !document.querySelector("#pass-form")?.classList.contains("hidden"))) {
    throw new Error("账号被要求修改密码，请先完成首次改密")
  }

  await page.goto(${JSON.stringify(url.replace(/\/$/, ''))} + "/#/users", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".admin-data-table .table-pagination", { state: "visible", timeout: 15000 })
  const userRows = await page.evaluate(() => document.querySelectorAll(".admin-table tbody tr").length)
  if (userRows < 1) throw new Error("用户表格没有渲染数据")
  console.log("PASS 用户列表渲染")

  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
  await page.reload()
  await page.waitForSelector(".data-cards .data-card", { state: "visible", timeout: 15000 })
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    table: getComputedStyle(document.querySelector(".admin-data-table .table-scroll")).display,
  }))
  if (mobile.scrollWidth > mobile.width || mobile.table !== "none") throw new Error("移动端用户表格未切换为卡片或出现横向溢出")
  console.log("PASS 移动端表格无横向溢出")

  await page.keyboard.press("Meta+k")
  await page.waitForSelector("dialog.admin-command-dialog[open]", { state: "visible", timeout: 5000 })
  await page.fill(".admin-command-search input", "个人设置")
  await page.waitForSelector("dialog.admin-command-dialog button", { state: "visible", timeout: 5000 })
  const commandLabels = await page.evaluate(() => [...document.querySelectorAll("dialog.admin-command-dialog button")]
    .map((button) => button.textContent.trim()))
  if (!commandLabels.length || commandLabels.some((label) => !label.includes("个人设置"))) {
    throw new Error("命令面板没有按关键词筛选：" + commandLabels.join("、"))
  }
  console.log("PASS 命令面板可打开并筛选")
  await page.keyboard.press("Escape")

  await page.goto(${JSON.stringify(url.replace(/\/$/, ''))} + "/#/__smoke-missing", { waitUntil: "domcontentloaded" })
  await page.waitForSelector(".error-page", { state: "visible", timeout: 10000 })
  const code = await page.evaluate(() => document.querySelector(".error-code")?.textContent)
  if (code !== "404") throw new Error("未知路由没有渲染 404 页面")
  console.log("PASS 未知路由显示 404")
} finally {
  if (task) {
    await task.finish({ keep: [] })
  }
}
`

const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] })
const watchdog = setTimeout(() => {
  console.error('后台浏览器冒烟测试超时（120 秒）')
  child.kill('SIGTERM')
  process.exit(1)
}, 120_000)
child.on('error', (error) => {
  clearTimeout(watchdog)
  console.error(`无法启动 ego-browser：${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  clearTimeout(watchdog)
  process.exit(code ?? 1)
})
child.stdin.on('error', (error) => {
  clearTimeout(watchdog)
  console.error(`写入 ego-browser 失败：${error.message}`)
  process.exit(1)
})
child.stdin.end(script)
