const STORAGE_KEY = 'mh-lang'
const SUPPORTED = new Set(['zh', 'en'])

export function normalizeLang(value = '') {
  return /^en(?:[-_]|$)/i.test(String(value).trim()) ? 'en' : 'zh'
}

function detectLang() {
  const query = new URLSearchParams(location.search).get('lang')
  if (query) return normalizeLang(query)
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (SUPPORTED.has(saved)) return saved
  } catch { /* ignore */ }
  return /^zh(?:[-_]|$)/i.test(navigator.language ?? '') ? 'zh' : 'en'
}

let current = detectLang()

export const getLang = () => current

export function setLang(lang) {
  current = SUPPORTED.has(lang) ? lang : normalizeLang(lang)
  try { localStorage.setItem(STORAGE_KEY, current) } catch { /* ignore */ }
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN'
  return current
}

export function t(key, fallback = key) {
  return current === 'en' ? (UI_EN[key] ?? fallback) : key
}

const UI_EN = {
  // Navigation and chrome
  音轨: 'Audio',
  字幕: 'Subtitles',
  关闭字幕: 'Off',
  影巢: 'Yingchao',
  影巢精选: 'Featured',
  '影巢 · 高清影视在线观看': 'Yingchao · Premium Streaming',
  跳到主要内容: 'Skip to main content',
  影巢正在加载: 'Yingchao · Loading',
  '影巢 · 正在加载': 'Yingchao · Loading',
  频道: 'Channels',
  精选: 'Featured',
  分类: 'Browse',
  电影: 'Movies',
  电视剧: 'TV Series',
  短剧: 'Short Drama',
  动漫: 'Anime',
  纪录片: 'Docs',
  综艺: 'Variety',
  即将上线: 'Coming Soon',
  片单广场: 'Collections',
  海报墙: 'Poster Wall',
  榜单: 'Rankings',
  我的: 'My Account',
  全部榜单: 'All',
  内容数据榜: 'Content',
  个人中心: 'Profile',
  观看历史: 'History',
  我的收藏: 'Favorites',
  佣金推广: 'Affiliate',
  历史: 'History',
  收藏: 'Save',
  消息: 'Messages',
  会员: 'Membership',
  登录: 'Log in',
  '登录 / 注册': 'Log in / Sign up',
  验证码登录: 'Email code',
  密码登录: 'Password',
  登录影巢: 'Log in to Yingchao',
  登录后即可播放与查看个人中心: 'Log in to play videos and access your account',
  '首页、分类、榜单、搜索与剧集详情均可直接浏览；播放与购买需要账号。': 'Browse the homepage, categories, rankings, search and details without an account. Playback and purchases require sign-in.',
  '未注册的邮箱会自动创建账号；密码可在「个人中心」设置。': 'New email addresses are registered automatically. You can set a password in Profile.',
  我的账号: 'My Account',
  进入个人中心: 'Open profile',
  '搜索剧名、简介、标签': 'Search titles, descriptions, tags',
  '移动端主导航': 'Mobile navigation',
  侧边导航: 'Sidebar navigation',
  语言切换: 'Language',
  暂停自动轮播: 'Pause carousel',
  继续自动轮播: 'Resume carousel',
  上一张推荐: 'Previous recommendation',
  下一张推荐: 'Next recommendation',
  选择推荐: 'Choose recommendation',
  是否年满18岁: 'Are you 18 or older?',
  成人内容: 'Adult content',
  '成人内容仅面向年满18岁的用户。': 'Adult content is intended for users aged 18 or older.',
  '是，我已满18岁': 'Yes, I am 18 or older',
  '否，未满18岁': 'No, I am under 18',
  成人分类暂无内容: 'No adult titles yet',

  // Common controls
  查看详情: 'View details',
  分享: 'Share',
  取消: 'Cancel',
  保存: 'Save',
  提交: 'Submit',
  关闭: 'Close',
  确定: 'Confirm',
  知道了: 'Got it',
  刷新: 'Refresh',
  重试: 'Retry',
  换一换: 'Refresh',
  展开全部: 'Expand all',
  收起全部: 'Collapse all',
  更多: 'More',
  收起选项: 'Collapse',
  清空筛选: 'Clear filters',
  加载更多: 'Load more',
  加载中: 'Loading',
  '加载中…': 'Loading...',
  筛选中: 'Filtering',
  '筛选中…': 'Filtering...',
  暂无: 'None',
  '暂无。': 'None.',
  未填写: 'Not set',
  已设置: 'Set',
  未设置: 'Not set',
  暂无消息: 'No messages',
  暂无数据: 'No data',
  '—': '—',

  // Home and listings
  首页推荐: 'Featured today',
  查看全部: 'View all',
  最新上线: 'New',
  评分: 'Rating',
  最多播放: 'Most played',
  全部: 'All',
  最热: 'Hot',
  最新: 'Newest',
  好评: 'Top rated',
  讨论最多: 'Most discussed',
  '共 0 部': '0 titles',
  '还没有内容，先去首页看看': 'No titles yet. Explore the homepage first.',
  没有找到相关剧集: 'No matching titles',
  '输入关键词，或直接点下面的标签': 'Enter a keyword or choose a tag below',
  搜索: 'Search',
  '“ 命中': ' results',
  全部分类: 'All Titles',
  频道筛选: 'Channel',
  排序: 'Sort',
  地区: 'Region',
  类型: 'Genre',
  年份: 'Year',
  标签: 'Tags',
  '更多筛选（标签）': 'More filters (tags)',
  '加载更多': 'Load more',
  没有符合条件的内容: 'No titles match these filters',
  这个分类暂时还没有内容: 'This category does not have any titles yet',
  美国: 'United States',
  英国: 'United Kingdom',
  韩国: 'South Korea',
  日本: 'Japan',
  泰国: 'Thailand',
  内地: 'Mainland China',
  中国香港: 'Hong Kong',
  中国台湾: 'Taiwan',
  其他: 'Other',
  剧情: 'Drama',
  喜剧: 'Comedy',
  动作: 'Action',
  冒险: 'Adventure',
  爱情: 'Romance',
  动画: 'Animation',
  歌舞: 'Musical',
  医疗: 'Medical',
  科幻: 'Sci-Fi',
  奇幻: 'Fantasy',
  悬疑: 'Mystery',
  惊悚: 'Thriller',
  犯罪: 'Crime',
  传记: 'Biography',
  战争: 'War',
  灾难: 'Disaster',
  美食: 'Food',
  真人秀: 'Reality',
  脱口秀: 'Talk Show',
  黑白: 'Black and White',
  历史: 'History',
  经典: 'Classic',
  无对白: 'No Dialogue',
  短片: 'Short Film',
  开源电影: 'Open Movie',
  追逃: 'Chase',
  都市: 'Urban',
  紧张: 'Tense',
  科普: 'Science',
  开放电影精选: 'Open Movie Picks',
  动画短片: 'Animated Shorts',
  脑洞科幻: 'Mind-Bending Sci-Fi',
  一次看完: 'Watch in One Go',

  // Rankings
  热播榜: 'Trending',
  热搜榜: 'Most Searched',
  飙升榜: 'Rising',
  期待榜: 'Most Anticipated',
  经典榜: 'Classics',
  短剧榜: 'Short Dramas',
  季度榜: 'This Quarter',
  高分榜: 'Top Rated',
  冷门佳作: 'Hidden Gems',
  收藏榜: 'Most Favorited',
  完播榜: 'Most Completed',
  新片榜: 'New Releases',
  推荐榜: 'Recommended',
  内容榜: 'Content Rankings',
  榜单待生成: 'Ranking has not been generated yet',
  该榜单暂无内容: 'No titles in this ranking yet',
  该榜单暂无足够数据: 'Not enough data for this ranking yet',

  // Detail, access and paywall
  免费: 'Free',
  已开通: 'Active',
  单片: 'Single purchase',
  已购: 'Owned',
  待支付: 'Pending payment',
  支付确认中: 'Confirming payment',
  已支付: 'Paid',
  已完成: 'Completed',
  已关闭: 'Closed',
  已退款: 'Refunded',
  退款中: 'Refunding',
  退款待审: 'Refund review',
  支付失败: 'Payment failed',
  模拟支付: 'Mock payment',
  '模拟支付（测试）': 'Mock payment (test)',
  支付宝: 'Alipay',
  微信支付: 'WeChat Pay',
  免费观看: 'Free to watch',
  会员权益: 'Membership access',
  已购买: 'Purchased',
  试看: 'Preview',
  免费看第: 'Watch Episode',
  解锁全部: 'Unlock all',
  开通会员: 'Get membership',
  开通会员看全集: 'Get membership to watch all',
  购买本片: 'Buy this title',
  '购买本片（永久解锁）': 'Buy this title (permanent access)',
  已收藏: 'Saved',
  选集: 'Episodes',
  部分集数单独定价: 'Some episodes are priced separately',
  '部分集数单独定价，点开可见具体规则': 'Some episodes are priced separately. Open an episode to see its price.',
  需会员: 'Membership required',
  需开通: 'Unlock required',
  暂无剧集: 'No episodes',
  第: 'Episode',
  全: 'All',
  集: 'episodes',
  前: 'First',
  集免费: 'episodes free',
  会员专享: 'Membership only',
  单片付费: 'Single purchase',
  续费: 'Renew',
  开通会员后观看: 'Get membership to watch',
  开通会员后可观看: 'Membership required to watch',
  该片需单独购买: 'This title requires a separate purchase',
  本片为单独付费内容: 'This title is sold separately',
  '本片为单独付费内容，会员也可观看全部剧集': 'This title is sold separately. Members can also watch all titles.',
  会员可看全站剧集: 'Membership includes all titles',
  限时租赁: 'Limited-time rental',
  永久解锁: 'Permanent access',
  优惠券码: 'Coupon code',
  '优惠券码（可选，如 WELCOME10）': 'Coupon code (optional, e.g. WELCOME10)',
  不可用: 'Unavailable',
  暂无可用支付渠道: 'No payment method is currently available',
  正在创建订单: 'Creating order',
  '正在创建订单…': 'Creating order...',
  支付成功: 'Payment successful',
  订单已超时: 'Order expired',
  收款地址已复制: 'Payment address copied',
  已选中地址: 'Address selected',
  请精确转账该金额: 'Please transfer the exact amount',
  播放: 'Play',
  播放异常: 'Playback error',
  自动清晰度: 'Auto quality',
  发送: 'Send',
  发送弹幕: 'Send comment',
  '发条弹幕…': 'Send a comment...',
  已提交: 'Submitted',
  很多人在看: 'Popular now',
  该集片源正在处理中: 'This episode is being processed',
  本集正在转码: 'This episode is transcoding',
  本集片源异常: 'This episode is temporarily unavailable',
  播放中断: 'Playback interrupted',
  该集片源暂不可用: 'Episode temporarily unavailable',
  手动重试: 'Retry manually',
  试看结束: 'Preview ended',
  已是最后一集: 'This is the last episode',
  未上传片源: 'Source unavailable',
  重新加载: 'Reload',
  查看购买选项: 'View purchase options',
  '第 1 集': 'Episode 1',

  // Account
  账户导航: 'Account navigation',
  会员订阅: 'Subscription',
  单片购买: 'Single purchase',
  订单: 'Orders',
  内容: 'Title',
  金额: 'Amount',
  状态: 'Status',
  时间: 'Time',
  操作: 'Actions',
  继续支付: 'Continue payment',
  继续观看: 'Continue watching',
  还没有订单: 'No orders yet',
  还没有收藏: 'No favorites yet',
  去首页看看: 'Explore homepage',
  登录后可查看订阅权益: 'Log in to view your membership and orders',
  退出登录: 'Log out',
  编辑资料: 'Edit profile',
  修改密码: 'Change password',
  更换: 'Change',
  更换头像: 'Change avatar',
  邮箱: 'Email',
  昵称: 'Nickname',
  生日: 'Birthday',
  性别: 'Gender',
  简介: 'Bio',
  个人简介: 'Bio',
  密码: 'Password',
  男: 'Male',
  女: 'Female',
  保密: 'Private',
  会员中: 'Active member',
  未开通: 'Not active',
  已购单片: 'Purchased titles',
  租赁至: 'Rental until',
  永久: 'Permanent',
  权益与订单通知: 'Membership and order updates',
  个人资料: 'Profile',
  完整度: 'completion',
  '开通后可看全站剧集（含单片付费内容）': 'Membership unlocks all titles, including separately sold content.',
  头像: 'Avatar',
  我的订单: 'My orders',
  订单记录: 'Orders',
  资料已保存: 'Profile saved',
  头像已更新: 'Avatar updated',
  头像不能超过: 'Avatar must be under',
  验证码已发送: 'Verification code sent',
  发送验证码: 'Send code',
  确认新密码: 'Confirm new password',
  新密码: 'New password',
  新邮箱: 'New email',
  新邮箱验证码: 'New email verification code',
  邮箱格式不正确: 'Invalid email address',
  邮箱已更换: 'Email updated',
  密码已更新: 'Password updated',
  两次输入的密码不一致: 'Passwords do not match',
  登录成功: 'Logged in',
  已退出登录: 'Logged out',
  注册成功: 'Account created',
  账号密码: 'Password',
  邮箱验证码: 'Email verification code',
  '6 位验证码': '6-digit code',
  获取验证码: 'Send code',
  使用: 'Apply',
  稍后再说: 'Not now',
  请输入邮箱: 'Enter your email',
  请输入正确的邮箱地址: 'Enter a valid email address',
  请输入密码: 'Enter your password',
  '请输入 6 位数字验证码': 'Enter the 6-digit code',

  // Affiliate
  申请开通佣金推广: 'Apply for affiliate program',
  申请状态: 'Application status',
  待审核: 'Pending review',
  已停用: 'Disabled',
  人民币: 'Chinese Yuan',
  美元: 'US Dollar',
  我的推广码: 'My referral code',
  推广数据: 'Performance',
  邀请人数: 'Direct invites',
  推广人数: 'Team size',
  好友支付订单: 'Paid orders',
  好友支付金额: 'Friend payments',
  佣金: 'Commission',
  冻结中: 'Frozen',
  可结算: 'Available',
  已结算: 'Settled',
  退款冲减: 'Refund adjustments',
  待抵扣: 'Debt offset',
  可提现: 'Withdrawable',
  申请提现: 'Request withdrawal',
  推广层级: 'Levels',
  提现记录: 'Withdrawal history',
  暂无提现记录: 'No withdrawal history',
  暂无推广数据: 'No affiliate data yet',
  提现方式: 'Withdrawal method',
  提交申请: 'Submit request',
  当前按人民币申请: 'Requested in CNY',
  '金额按实际申请币种显示；财务复核后打款': 'Amounts are shown in the requested currency; payouts are released after finance review.',
  该币种暂无可用提现方式: 'No withdrawal method is available for this currency',
  提现申请已提交: 'Withdrawal request submitted',
  复制推广链接: 'Copy referral link',
  保存推广海报: 'Save referral poster',
  邀请链接已复制: 'Referral link copied',
  推广申请已提交: 'Application submitted',
  待生成: 'Not generated',
  原币: 'Original',
  折算: 'converted',
  分享好片: 'Share titles',
  推广数据: 'Performance',
  '分享影巢好片，好友通过你的邀请注册并付费后，你可获得佣金。': 'Share Yingchao titles. When friends sign up and pay through your invite, you earn commission.',
  '分享好片，好友注册并付费后按推广层级结算佣金': 'Share titles and earn tiered commission when friends sign up and pay.',
  每小时更新: 'Updated hourly',
  查看内容数据榜: 'View content rankings',
  '免费观看 · HLS': 'Free to watch · HLS',
  '当前按人民币申请，实际到账金额以财务复核结果为准。': 'Requested in CNY. The final payout is confirmed after finance review.',

  // Poster wall and footer
  返回片库: 'Back to library',
  按内容类型筛选: 'Filter by content type',
  正在加载: 'Loading',
  '正在加载…': 'Loading...',
  内容来源: 'Sources',
  关闭: 'Close',
  全部: 'All',
  '部': 'titles',
  '共 0 部': '0 titles',
  客服邮箱: 'Support email',
  '客服邮箱：': 'Support email:',
  '© 2026 影巢': '© 2026 Yingchao',

  // Error and empty states
  加载失败: 'Failed to load',
  返回首页: 'Back to home',
  站点配置加载失败: 'Failed to load site configuration',
  网络异常: 'Network error',
  请求超时: 'Request timed out',
  登录已过期: 'Session expired',
  接口失败: 'Request failed',
  没有找到相关剧集: 'No matching titles',
  该分类暂无内容: 'This category has no titles',
  暂无可用支付渠道: 'No payment method available',
  暂无可用渠道: 'No channel available',
}

const REPLACE_PAIRS = [
  ['开放电影精选', 'Open Movie Picks'],
  ['动画短片', 'Animated Shorts'],
  ['脑洞科幻', 'Mind-Bending Sci-Fi'],
  ['一次看完', 'Watch in One Go'],
  ['会员订阅', 'Subscription'],
  ['单片购买', 'Single purchase'],
  ['支付确认中', 'Confirming payment'],
  ['退款待审', 'Refund review'],
  ['已关闭', 'Closed'],
  ['已支付', 'Paid'],
  ['已完成', 'Completed'],
  ['已退款', 'Refunded'],
  ['退款中', 'Refunding'],
  ['待支付', 'Pending payment'],
  ['月卡会员', 'Monthly Plan'],
  ['季卡会员', 'Quarterly Plan'],
  ['年卡会员', 'Annual Plan'],
  ['全站畅看', 'All titles included'],
  ['每小时更新', 'Updated hourly'],
  ['影巢', 'Yingchao'],
]

const PATTERNS = [
  [/^共 (\d+) 部$/, (_, n) => `${n} ${n === '1' ? 'title' : 'titles'}`],
  [/^(\d+) 部$/, (_, n) => `${n} ${n === '1' ? 'title' : 'titles'}`],
  [/^(\d+) 部精选$/, (_, n) => `${n} ${n === '1' ? 'pick' : 'picks'}`],
  [/^筛选命中 (\d+) 部 \/ 共 (\d+) 部$/, (_, a, b) => `${a} of ${b} titles`],
  [/^共 (\d+) 部 · 按(.+)$/, (_, n, sort) => `${n} ${n === '1' ? 'title' : 'titles'} · By ${sort}`],
  [/^按(.+)$/, (_, sort) => `By ${sort}`],
  [/^“(.+)” 命中 (\d+) 部$/, (_, term, n) => `“${term}” · ${n} ${n === '1' ? 'result' : 'results'}`],
  [/^(\d+) 人$/, (_, n) => `${n} ${n === '1' ? 'person' : 'people'}`],
  [/^(\d+) 条记录$/, (_, n) => `${n} ${n === '1' ? 'record' : 'records'}`],
  [/^(\d+) 笔$/, (_, n) => `${n} ${n === '1' ? 'order' : 'orders'}`],
  [/^(\d+) 个$/, (_, n) => `${n}`],
  [/^(\d+) 张$/, (_, n) => `${n} coupons`],
  [/^第 (\d+) 集$/, (_, n) => `Episode ${n}`],
  [/^第 (\d+) 集(.*)$/, (_, n, suffix) => `Episode ${n}${suffix}`],
  [/^(\d+) 集$/, (_, n) => `${n} ${n === '1' ? 'episode' : 'episodes'}`],
  [/^全 (\d+) 集$/, (_, n) => `${n} episodes`],
  [/^前 (\d+) 集免费$/, (_, n) => `First ${n} ${n === '1' ? 'episode' : 'episodes'} free`],
  [/^首 (\d+) 集免费$/, (_, n) => `First ${n} ${n === '1' ? 'episode' : 'episodes'} free`],
  [/^免费看第 (\d+) 集$/, (_, n) => `Watch Episode ${n} Free`],
  [/^解锁全部 ¥(.+)$/, (_, price) => `Unlock all · ¥${price}`],
  [/^(.+) · 共 (\d+) 集$/, (_, title, n) => `${title} · ${n} episodes`],
  [/^(\d+) 级$/, (_, n) => `Level ${n}`],
  [/^(\d+) 天$/, (_, n) => `${n} days`],
  [/^剩 (\d+) 天$/, (_, n) => `${n} days left`],
  [/^(\d+) 秒$/, (_, n) => `${n}s`],
  [/^(\d+) 分钟$/, (_, n) => `${n} min`],
  [/^有效期至 (.+) · 全站畅看$/, (_, value) => `Valid until ${value} · All titles included`],
  [/^有效期至 (.+)$/, (_, value) => `Valid until ${value}`],
  [/^看到第 (\d+) 集(.*)$/, (_, n, suffix) => `Episode ${n}${suffix}`],
  [/^共 (\d+) 笔$/, (_, n) => `${n} ${n === '1' ? 'order' : 'orders'}`],
  [/^个人资料 · 完整度 (\d+)%$/, (_, n) => `Profile · ${n}% complete`],
  [/^待完善：(.+)$/, (_, list) => `Missing: ${list.split('、').map((item) => UI_EN[item] ?? item).join(', ')}`],
  [/^(\d+) 部 \/ 共 (\d+) 部$/, (_, a, b) => `${a} of ${b} titles`],
  [/^播放链接 (\d+) 分钟内有效，失效后自动重连$/, (_, n) => `Playback link valid for ${n} minutes; reconnecting automatically.`],
  [/^试看剩余 (.+)$/, (_, left) => `Preview left: ${left}`],
  [/^已从上次观看到的 (.+) 继续播放$/, (_, time) => `Resumed from ${time}`],
  [/^(.+) 第 (\d+) 集 · 影巢$/, (_, title, n) => `${title} · Episode ${n} · Yingchao`],
  [/^(.+) · 影巢$/, (_, title) => `${title} · Yingchao`],
  [/^(.+) · (.+) · 影巢$/, (_, title, part) => `${title} · ${part} · Yingchao`],
  [/^查看《(.+)》$/, (_, title) => `View “${title}”`],
  [/^向左浏览(.+)$/, (_, title) => `Browse left: ${title}`],
  [/^向右浏览(.+)$/, (_, title) => `Browse right: ${title}`],
  [/^(.+)内容$/, (_, title) => `${title} content`],
  [/^(.+) · 第 (\d+) 集$/, (_, title, n) => `${title} · Episode ${n}`],
  [/^(.+) 第 (\d+) 集$/, (_, title, n) => `${title.replace(/\s*·\s*$/, '')} · Episode ${n}`],
  [/^(.+) · 搜索 · Yingchao$/, (_, keyword) => `${keyword} · Search · Yingchao`],
  [/^搜索 · Yingchao$/, () => 'Search · Yingchao'],
  [/^(.+) · Yingchao$/, (_, title) => `${translateCore(title)} · Yingchao`],
  [/^订单 (.+) 已创建，金额 ¥(.+)$/, (_, no, amount) => `Order ${no} created · ¥${amount}`],
  [/^订单 (.+)$/, (_, no) => `Order ${no}`],
  [/^验证码已发送至 (.+)，5 分钟内有效$/, (_, email) => `Code sent to ${email}. Valid for 5 minutes.`],
  [/^(\d+)s 后重发$/, (_, n) => `Resend in ${n}s`],
  [/^申请状态：(.+)$/, (_, status) => `Application status: ${translateCore(status)}`],
  [/^当前金额统一按人民币展示；提现记录按实际申请币种显示。$/, () => 'All amounts are shown in CNY. Withdrawals are shown in their requested currency.'],
  [/^当前金额统一按美元（1 USD ≈ ¥(.+)）展示；提现记录按实际申请币种显示。$/, (_, rate) => `All amounts are shown in USD (1 USD ≈ ¥${rate}). Withdrawals are shown in their requested currency.`],
  [/^原币 ¥(.+) · 按 1 USD ≈ ¥(.+) 折算$/, (_, amount, rate) => `Original ¥${amount} · 1 USD ≈ ¥${rate}`],
]

const SKIP_SELECTOR = [
  '[data-i18n-ignore]',
  'script',
  'style',
  '.hero-title',
  '.hero-sub',
  '.wide-card-copy',
  '.card-title',
  '.card-sub',
  '.detail-title',
  '.detail-desc',
  '.history-title',
  '.pw-copy',
  '.pw-credits',
  '.detail-tags',
  '.chip',
  '.tag',
  '.danmu',
].join(',')

function translateCore(text, el) {
  if (!text) return text
  let core = text
  if (el?.closest?.('.top-actions')) {
    if (core === '历史') return 'History'
    if (core === '收藏') return 'Saved'
    if (core === '消息') return 'Inbox'
    if (core === '会员') return 'VIP'
  }
  if (UI_EN[core]) return UI_EN[core]
  for (const [from, to] of REPLACE_PAIRS) {
    if (core === from) return to
    if (core.includes(from)) core = core.replaceAll(from, to)
  }
  if (UI_EN[core]) return UI_EN[core]
  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(core)) return core.replace(pattern, replacement)
  }
  return core
}

export function translateText(value, el = null) {
  if (current !== 'en' || value === null || value === undefined) return value
  const text = String(value)
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/)
  if (!match) return text
  const translated = translateCore(match[2], el)
  return translated === match[2] ? text : `${match[1]}${translated}${match[3]}`
}

export function translateDom(root = document.body) {
  if (current !== 'en' || !root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    const parent = node.parentElement
    if (!parent || parent.closest(SKIP_SELECTOR)) continue
    const next = translateText(node.nodeValue, parent)
    if (next !== node.nodeValue) node.nodeValue = next
  }
  const attrSelector = '[placeholder],[aria-label],[title]'
  const elements = root.matches?.(attrSelector) ? [root, ...root.querySelectorAll(attrSelector)] : [...root.querySelectorAll(attrSelector)]
  for (const el of elements) {
    if (el.closest(SKIP_SELECTOR)) continue
    for (const name of ['placeholder', 'aria-label', 'title']) {
      const value = el.getAttribute(name)
      if (!value) continue
      const next = translateText(value, el)
      if (next !== value) el.setAttribute(name, next)
    }
  }
  document.title = translateText(document.title)
}

let observer
let scheduled = false

export function initI18n() {
  setLang(current)
  translateDom(document.body)
  if (observer) return
  observer = new MutationObserver((mutations) => {
    if (current !== 'en' || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) translateDom(node)
        }
      }
      document.title = translateText(document.title)
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
