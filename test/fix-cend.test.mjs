import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseServerTime, hasTimeZone, daysLeft, formatDay, formatDateTime, sortByTimeDesc, watchedPercent, formatElapsed } from '../public/src/time.js';
import { createCountdown } from '../public/src/countdown.js';
import { buildHashState, readHashQuery, readListState, parseHashState, writeHashQuery } from '../public/src/table-state.js';
import { appendUnique, clampPage, totalPagesOf, uniqueById } from '../public/src/list-utils.js';
import { parseRetryAfter, retryAfterOf } from '../public/src/retry-after.js';
import { apiOutcome } from '../public/src/api-outcome.js';
import { createLooseGuard, looseHeaders } from '../public/src/track-loose.js';
import { adultGateOf, needsAdultGate } from '../public/src/adult-gate.js';

const ROOT = new URL('../', import.meta.url);
const src = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

/* ── 时间工具（条目 6） ───────────────────────────── */

test('时间解析：validTo 已带 Z 不再拼成 ZZ，未来订阅能算出剩余天数', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(daysLeft('2026-11-18T00:00:00Z', now), 2);
  assert.equal(daysLeft('2026-11-17T08:00:00+08:00', now), 1);
  assert.ok(Number.isFinite(parseServerTime('2026-11-16T03:20:00Z').getTime()));
});

test('时间解析：不带时区的服务端时间按 UTC 解释，与带 Z 的 ISO 串等价', () => {
  const naive = parseServerTime('2026-11-16 03:20:00');
  const iso = parseServerTime('2026-11-16T03:20:00Z');
  assert.equal(naive.toISOString(), iso.toISOString());
  assert.equal(hasTimeZone('2026-11-16T03:20:00Z'), true);
  assert.equal(hasTimeZone('2026-11-16 03:20:00'), false);
});

test('日期展示：+08 用户看到的是本地日期，不是 UTC 的 slice(0,10)', () => {
  assert.equal(formatDay('2026-11-16T23:30:00Z'), '2026-11-17');
  assert.equal(formatDay('2026-11-16T03:20:00'), '2026-11-16');
  assert.equal(formatDay(''), '—');
});

test('时间排序：MessagesPage 用统一解析口径，UTC 与本地时间混排不会错序', () => {
  const rows = [
    { id: 1, createdAt: '2026-11-16 03:00:00' },
    { id: 2, createdAt: '2026-11-16T12:00:00+08:00' },
    { id: 3, createdAt: '2026-11-16T06:00:00Z' }
  ];
  assert.deepEqual(sortByTimeDesc(rows).map((row) => row.id), [3, 2, 1]);
});

test('续播进度：秒数与时长换算百分比，缺时长返回 null 不显示进度条', () => {
  assert.equal(watchedPercent(300, 1200), 25);
  assert.equal(watchedPercent(0, 1200), 0);
  assert.equal(watchedPercent(500, 0), null);
  assert.equal(watchedPercent('abc', 1200), null);
  assert.equal(watchedPercent(9999, 1200), 100);
});

test('时长展示：秒数格式化为 mm:ss / h:mm:ss', () => {
  assert.equal(formatElapsed(75), '1:15');
  assert.equal(formatElapsed(3725), '1:02:05');
  assert.equal(formatElapsed(-3), '0:00');
});

/* ── 倒计时（条目 7） ───────────────────────────── */

function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    timers,
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        for (const timer of [...timers.values()]) timer.fn();
      }
    }
  };
}

test('倒计时：重复 start 先清旧 timer，同一时刻只有一个 interval 在跑', () => {
  const clock = fakeTimers();
  const countdown = createCountdown({ setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  countdown.start(60);
  assert.equal(clock.timers.size, 1);
  countdown.start(30);
  assert.equal(clock.timers.size, 1, '旧 timer 必须先被清理');
  assert.equal(countdown.value, 30);
});

test('倒计时：走到 0 自动停止并通知订阅者', () => {
  const clock = fakeTimers();
  const countdown = createCountdown({ setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const values = [];
  countdown.subscribe((value) => values.push(value));
  countdown.start(2);
  clock.tick(2);
  assert.equal(countdown.value, 0);
  assert.equal(countdown.running, false);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(values, [0, 2, 1, 0]);
});

/* ── URL 状态（条目 10） ───────────────────────────── */

test('列表 URL 状态：筛选与页码写进 hash query，读回原值', () => {
  const hash = buildHashState('/category', { type: 'MOVIE', sort: 'hot', page: 2, tag: '' });
  assert.equal(hash, '#/category?type=MOVIE&sort=hot&page=2');
  assert.deepEqual(readListState(['type', 'sort', 'page', 'tag'], hash), {
    type: 'MOVIE',
    sort: 'hot',
    page: '2'
  });
  assert.deepEqual(parseHashState(hash).query, { type: 'MOVIE', sort: 'hot', page: '2' });
  assert.equal(readHashQuery(hash).get('page'), '2');
});

test('列表 URL 状态：空值不写进 URL，写回返回新的 hash', () => {
  assert.equal(buildHashState('/category', { type: '', tag: null, page: undefined }), '#/category');
  assert.equal(writeHashQuery('/category', { page: 3 }, { hash: '' }), '#/category?page=3');
});

/* ── 分页去重（条目 9） ───────────────────────────── */

test('分页叠加：同 id 去重且后到数据覆盖先到，不再出现 duplicate key', () => {
  const merged = appendUnique(
    [{ id: 1, title: '旧' }, { id: 2, title: 'B' }],
    [{ id: 2, title: 'B2' }, { id: 3, title: 'C' }, { id: 1, title: '新' }]
  );
  assert.deepEqual(merged.map((row) => row.id), [1, 2, 3]);
  assert.equal(merged[0].title, '新');
  assert.equal(merged[1].title, 'B2');
  assert.deepEqual(uniqueById([{ id: 1 }, { id: 1 }, { id: 2 }]).map((row) => row.id), [1, 2]);
});

test('页码夹取：用本次响应的 total 计算，旧 total 不会把页码夹到不存在的页', () => {
  assert.equal(totalPagesOf(0), 1);
  assert.equal(totalPagesOf(48, 24), 2);
  assert.equal(clampPage(3, 30, 24), 2, '30 条只有 2 页');
  assert.equal(clampPage(3, 72, 24), 3);
  assert.equal(clampPage(0, 72, 24), 1);
});

/* ── Retry-After（条目 15） ───────────────────────────── */

test('Retry-After：秒数与 HTTP-date 都解析，非法值回落 30s 并夹到 5–120s', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  assert.equal(parseRetryAfter('12'), 12);
  assert.equal(parseRetryAfter('2'), 5);
  assert.equal(parseRetryAfter('999'), 120);
  assert.equal(parseRetryAfter(''), 30);
  assert.equal(parseRetryAfter('not-a-date'), 30);
  assert.equal(parseRetryAfter(new Date(now + 60000).toUTCString(), { now }), 60);
  assert.equal(parseRetryAfter(new Date(now - 60000).toUTCString(), { now }), 5);
});

test('Retry-After：Headers 对象与普通对象两种 headers 都能取到值', () => {
  assert.equal(retryAfterOf({ response: { headers: { 'Retry-After': '45' } } }), 45);
  assert.equal(retryAfterOf({ headers: new Map([['retry-after', '20']]) }), 20);
  assert.equal(retryAfterOf({}), 30);
});

/* ── 接口响应判定（条目 12） ───────────────────────────── */

test('接口判定：HTTP 5xx 即使带 code 0000 也判失败', () => {
  assert.equal(apiOutcome({ ok: false, status: 500, json: { code: '0000', data: {} } }).kind, 'error');
  assert.equal(apiOutcome({ ok: false, status: 502, json: null }).code, 'http_502');
});

test('接口判定：200 + 业务错误码走错误路径，200 + 0000 才成功', () => {
  assert.equal(apiOutcome({ ok: true, status: 200, json: { code: '9999', msg: '失败' } }).kind, 'error');
  assert.equal(apiOutcome({ ok: true, status: 200, json: { code: '0000', data: { id: 1 } } }).kind, 'ok');
  assert.deepEqual(apiOutcome({ ok: true, status: 200, json: { code: '0000', data: { id: 1 } } }).data, { id: 1 });
});

test('接口判定：401 与业务码 0401 都归为未登录', () => {
  assert.equal(apiOutcome({ ok: false, status: 401, json: null }).kind, 'unauthorized');
  assert.equal(apiOutcome({ ok: true, status: 200, json: { code: '0401' } }).kind, 'unauthorized');
});

/* ── 埋点 loose（条目 3） ───────────────────────────── */

test('loose 上报：请求头复用进入时的 visitor 与 lang，不再硬编码 zh', () => {
  const headers = looseHeaders({ visitor: 'visitor-abc', lang: 'en', token: 'tk' });
  assert.equal(headers['x-mh-visitor'], 'visitor-abc');
  assert.equal(headers['x-mh-lang'], 'en');
  assert.equal(headers.authorization, 'Bearer tk');
});

test('loose guard：一次页面停留只发一条退出，reset 后可再次发送', () => {
  const guard = createLooseGuard();
  assert.equal(guard.trySend(), true);
  assert.equal(guard.trySend(), false, 'pagehide 与 visibilitychange 不能各发一条');
  guard.reset();
  assert.equal(guard.trySend(), true);
});

/* ── 成人门判定（条目 12） ───────────────────────────── */

test('成人门：enabled 是服务端年龄凭证，gated/confirmed=false 进门禁，credential 放行', () => {
  // 服务端 /api/adult/state 的 enabled 表示「已有 mh_adult 凭证」，不是频道开关；
  // 频道开关由 constants.adultMenu.enabled 控制（AdultPage 的 adultEnabled）。
  assert.equal(adultGateOf({ enabled: false }), 'gate');
  assert.equal(adultGateOf({ enabled: true }), 'open');
  assert.equal(adultGateOf({ gated: true }), 'gate');
  assert.equal(adultGateOf({ confirmed: false }), 'gate');
  assert.equal(adultGateOf({ confirmed: true }), 'open');
  assert.equal(adultGateOf({ closed: true }), 'closed');
  assert.equal(adultGateOf(null), 'open');
  assert.equal(adultGateOf({}, 'gate'), 'gate');
  // 服务端已确认时，即使本地 sessionStorage 为空也不应重复弹门禁
  assert.equal(needsAdultGate({ enabled: true }, false), 'open');
  assert.equal(needsAdultGate({ enabled: true }, true), 'open');
  assert.equal(needsAdultGate({ enabled: false }, true), 'gate');
  assert.equal(needsAdultGate({ enabled: false }, false), 'gate');
  assert.equal(needsAdultGate({}, false), 'gate');
});

/* ── 静态断言：不能跑浏览器的组件改动 ───────────────── */

test('静态断言：SearchPage 空关键词早退前复位 loading', () => {
  const source = src('public/src/pages/c/SearchPage.vue');
  assert.match(source, /if\s*\(!term\)\s*\{[\s\S]{0,240}loading\.value\s*=\s*false/);
  assert.match(source, /const term = keyword\.trim\(\)/);
});

test('静态断言：换集重建 PlayPage，离开时取消请求，迟到的响应不启动心跳', () => {
  const source = src('public/src/pages/c/PlayPage.vue');
  const app = src('public/src/App.vue');
  assert.match(app, /const componentKey = computed\(\(\) => `\$\{route\.path\}/);
  assert.match(app, /:key="componentKey"/);
  assert.match(source, /onBeforeUnmount\(\(\)\s*=>\s*\{[\s\S]{0,260}loadController\?\.abort\(\)[\s\S]{0,260}stopHeartbeat\(\)/);
  assert.match(source, /const nextPlayback = await publicApi\([^\n]+\{ signal \}\);\s*if \(signal\.aborted\) return;[\s\S]{0,220}startHeartbeat\(nextPlayback\)/);
});

test('静态断言：track.js 使用一次性 guard 与进入时上下文发送 loose', () => {
  const source = src('public/src/track.js');
  assert.match(source, /looseGuard\.trySend\(\)/);
  assert.match(source, /pageContext\s*=\s*\{\s*visitor:\s*readVisitor\(\),\s*lang:\s*getLang\(\)/);
  assert.match(source, /looseHeaders\(\{[\s\S]{0,120}pageContext\.visitor[\s\S]{0,120}pageContext\.lang/);
  assert.match(source, /looseGuard\.reset\(\)/);
});

test('静态断言：AppShell / LandingPage 切语言不再整页 reload，并保留滚动位置', () => {
  const shell = src('public/src/components/AppShell.vue');
  const landing = src('public/src/pages/c/LandingPage.vue');
  assert.doesNotMatch(shell, /window\.location\.reload/);
  assert.doesNotMatch(landing, /window\.location\.reload/);
  assert.match(shell, /langState/);
  assert.match(shell, /skip-link/);
  assert.match(shell, /id="main-content"/);
  assert.match(shell, /bottomItems = \[[\s\S]*?\]/);
  assert.equal((shell.match(/key:\s*'(home|category|adult|rank|me|messages)'/g) ?? []).length >= 5, true);
  assert.match(landing, /window\.scrollTo/);
});

test('静态断言：i18n 9 个缺键与成人门文案齐全', () => {
  const source = src('public/src/i18n.js');
  const keys = [
    '页面不存在',
    '返回精选',
    '暂无待播内容',
    '正在加载片单',
    '正在加载榜单',
    '榜单加载失败',
    '海报墙加载失败',
    '这类内容还没有上架',
    '还没有已发布内容',
    '是否年满18岁',
    '正在校验年龄凭证',
    '确认中',
    '成人频道暂未开放',
    '运营已关闭该频道入口。'
  ];
  for (const key of keys) {
    assert.ok(source.includes(`${key}:`) || source.includes(`'${key}':`), `缺少 i18n 词条：${key}`);
  }
  assert.match(source, /Are you 18 or older\?/);
});

test('静态断言：CategoryPage 按 id 去重、筛选与页码写入 URL 并在挂载时读回', () => {
  const source = src('public/src/pages/c/CategoryPage.vue');
  assert.match(source, /appendUnique/);
  assert.match(source, /clampPage/);
  assert.match(source, /readListState/);
  assert.match(source, /writeHashParams/);
  assert.match(source, /onMounted\(\(\)\s*=>\s*restoreFromUrl\(\)\)/);
  assert.match(source, /page\.value = 1/);
});

test('静态断言：ContentRankPage 请求带 AbortController 与序号守卫', () => {
  const source = src('public/src/pages/c/ContentRankPage.vue');
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /requestSeq/);
  assert.match(source, /seq !== requestSeq/);
  assert.match(source, /\.abort\(\)/);
});

test('静态断言：AdultPage 挂载先查 /adult/state，确认时 POST /adult/confirm，gated 回门禁', () => {
  const source = src('public/src/pages/c/AdultPage.vue');
  assert.match(source, /publicApi\('\/adult\/state'\)/);
  assert.match(source, /publicApi\('\/adult\/confirm',\s*\{\s*method:\s*'POST'/);
  assert.match(source, /gateState/);
  assert.match(source, /needsAdultGate\(info, state\.adultConfirmed\)/);
  assert.match(source, /adultGateOf\(data, 'open'\) === 'gate'/);
  assert.match(source, /t\('是否年满18岁'\)/);
});

test('静态断言：PagerBar 同时显示「共 N 条」与「第 X / Y 页」', () => {
  const source = src('public/src/components/PagerBar.vue');
  assert.match(source, /共 \{\{ total \}\} 条/);
  assert.match(source, /第 \{\{ current \}\} \/ \{\{ totalPages \}\} 页/);
});

test('静态断言：控件高度只能取 32/40/48，不出现 34/36/38 中间值', () => {
  const css = src('public/src/styles.css');
  const controls = ['.chip', '.segmented button', '.pager__step', '.pager__num', '.filter-toggle', '.nav-item'];
  for (const selector of controls) {
    // 只匹配选择器完全等于目标的规则块（不误伤 `.filter-toggle .icon` 这类子元素）
    const blockRe = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    let matched = 0;
    for (const match of css.matchAll(blockRe)) {
      matched += 1;
      const heightMatch = match[1].match(/height:\s*(\d+)px/);
      if (!heightMatch) continue;
      const height = Number(heightMatch[1]);
      // DESIGN.md §8.5.1：控件高度只允许 32/40/48（34/36/38 是报告点名的违规中间值）
      assert.ok(![34, 36, 38].includes(height), `${selector} 的高度 ${height}px 是报告点名的违规中间值`);
      assert.ok([32, 40, 48].includes(height), `${selector} 的高度 ${height}px 不在 32/40/48 档位`);
    }
    assert.ok(matched > 0, `没有找到 ${selector} 的样式块`);
  }
  // 侧栏宽度不能收成纯图标轨道：124px 装不下「内容数据榜」，标签会折行再被 40px 定高裁掉。
  // 这里只卡下限（装得下最长标签），具体像素值由 test/ui-layout.test.mjs 逐项校验。
  const sidebar = Number((/--sidebar:\s*(\d+)px/.exec(css) || [])[1]);
  assert.ok(sidebar >= 200, `--sidebar ${sidebar}px 装不下带文字的导航项`);
  assert.match(css, /grid-template-columns:\s*repeat\(5,\s*1fr\)/);
  assert.match(css, /gap:\s*calc\(48px \+ env\(safe-area-inset-bottom\)\)|height:\s*calc\(48px \+ env\(safe-area-inset-bottom\)\)/);
});

test('静态断言：styles.css 不再本地重定义 shared tokens，main.js 先加载 tokens.css', () => {
  const css = src('public/src/styles.css');
  assert.match(css, /--h-1:\s*var\(--h-sm\)/);
  assert.match(css, /--r-2:\s*var\(--r-md\)/);
  assert.match(css, /--sp-1:\s*var\(--sp-1\)|--ink-0:\s*var\(--bg\)/);
  assert.doesNotMatch(css, /--h-1:\s*32px/);
  assert.doesNotMatch(css, /--r-2:\s*12px/);
  const main = src('public/src/main.js');
  assert.match(main, /import '\.\.\/tokens\.css'/);
});

test('静态断言：首页续播进度条按百分比渲染，不再把秒当百分比', () => {
  const source = src('public/src/pages/c/HomePage.vue');
  assert.match(source, /watchedPercent/);
  assert.match(source, /continuePercent\(item\)/);
  assert.doesNotMatch(source, /Number\(item\.position \?\? 0\)\)\s*\}%/);
});

test('静态断言：详情页简介只渲染一次', () => {
  const source = src('public/src/pages/c/DetailPage.vue');
  assert.equal((source.match(/\{\{\s*detail\.description\s*\}\}/g) ?? []).length, 1);
});

test('静态断言：VideoPlayer 换源重置重试次数并带字幕轨', () => {
  const source = src('public/src/components/VideoPlayer.vue');
  assert.match(source, /resetRetries\(\)/);
  assert.match(source, /watch\(\s*\(\)\s*=>\s*props\.src[\s\S]{0,200}resetRetries\(\)/);
  assert.match(source, /<track/);
  assert.match(source, /parseRetryAfter/);
});

test('静态断言：购买单选组有 fieldset/legend，FilmArt 首屏不挂 video', () => {
  const checkout = src('public/src/components/CheckoutDialog.vue');
  assert.match(checkout, /<fieldset class="plan-fieldset">/);
  assert.match(checkout, /<legend class="sr-only">选择购买方式<\/legend>/);
  const film = src('public/src/components/FilmArt.vue');
  assert.match(film, /previewReady/);
  assert.match(film, /v-if="film\.previewUrl && previewReady"/);
});

test('静态断言：23 个页面路由级分包，首页保持同步', () => {
  const source = src('public/src/App.vue');
  assert.match(source, /defineAsyncComponent/);
  assert.equal((source.match(/defineAsyncComponent\(\(\) => import\(/g) ?? []).length, 22);
  assert.match(source, /import HomePage from '\.\/pages\/c\/HomePage\.vue'/);
  assert.doesNotMatch(source, /import DetailPage from '\.\/pages\/c\/DetailPage\.vue'/);
});

test('静态断言：三处验证码倒计时统一走 useCountdown', () => {
  for (const file of ['public/src/pages/c/LoginPage.vue', 'public/src/components/LoginDialog.vue', 'public/src/pages/c/ProfileEditPage.vue']) {
    const source = src(file);
    assert.match(source, /useCountdown\(/, `${file} 未使用 useCountdown`);
    assert.doesNotMatch(source, /window\.setInterval\(\(\)\s*=>\s*\{\s*\w+\.value -= 1/, `${file} 还留着无清理的 interval`);
  }
});

test('静态断言：models.js 的时间函数全部转发到 time.js，不再拼 Z', () => {
  const source = src('public/src/models.js');
  assert.match(source, /from '\.\/time\.js'/);
  assert.doesNotMatch(source, /\+\s*'Z'/);
  assert.match(source, /export function formatDate\(value\) \{[\s\S]{0,120}formatDay\(value\)/);
});
