const ZH = {
  category: {
    ALL: '全部', MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧', ANIME: '动漫',
    VARIETY: '综艺', DOCUMENTARY: '纪录片',
  },
  contentType: { movie: '电影', series: '剧集', comic_drama: '漫剧', documentary: '纪录片' },
  access: {
    free: '免费', subscription: '会员', paid: '单片', owned: '已购',
    subscribed: '已开通', trial: '试看',
  },
  accessMode: { free: '免费', subscription: '会员免费', paid: '单独收费' },
  sort: { hot: '最热', new: '最新', score: '好评', discuss: '讨论最多', upcoming: '即将上线' },
  region: {
    US: '美国', UK: '英国', KR: '韩国', JP: '日本', TH: '泰国', CN: '内地',
    HK: '中国香港', TW: '中国台湾', OTHER: '其他',
  },
  orderStatus: {
    created: '待支付', pending: '待支付', paid: '已支付', fulfilled: '已完成',
    closed: '已关闭', refunded: '已退款', refunding: '退款中',
  },
  withdrawalStatus: {
    pending_review: '待审核', approved: '已批准', paid: '已打款', rejected: '已驳回',
  },
  commissionStatus: { pending: '冻结中', available: '可结算', settled: '已结算', reversed: '已冲减' },
  settlementStatus: {
    pending_review: '待审核', approved: '待打款', paying: '打款中', paid: '已打款', rejected: '已驳回',
  },
  currency: { CNY: '人民币', USD: '美元', USDT: 'USDT' },
  area: {
    中国: '中国', 内地: '内地', 中国香港: '中国香港', 中国台湾: '中国台湾',
    美国: '美国', 英国: '英国', 法国: '法国', 德国: '德国', 荷兰: '荷兰',
    日本: '日本', 韩国: '韩国', 泰国: '泰国', 印度: '印度', 加拿大: '加拿大',
    澳大利亚: '澳大利亚', 其他: '其他',
  },
  rank: {
    HOT: '热播榜', SEARCH: '热搜榜', RISE: '飙升榜', EXPECT: '期待榜', CLASSIC: '经典榜',
    PLAYLIST: '短剧榜', QUARTER: '季度榜', HIGHRATE: '高分榜', HIDDEN: '冷门佳作',
  },
  contentRank: { hot: '热播榜', favorite: '收藏榜', completion: '完播榜', new: '新片榜', recommend: '推荐榜' },
  genre: {
    剧情: '剧情', 喜剧: '喜剧', 动作: '动作', 冒险: '冒险', 爱情: '爱情', 动画: '动画',
    歌舞: '歌舞', 医疗: '医疗', 科幻: '科幻', 奇幻: '奇幻', 悬疑: '悬疑', 惊悚: '惊悚',
    犯罪: '犯罪', 传记: '传记', 历史: '历史', 战争: '战争', 灾难: '灾难', 美食: '美食',
    真人秀: '真人秀', 脱口秀: '脱口秀',
  },
}

const EN = {
  category: {
    ALL: 'All', MOVIE: 'Movies', TV: 'TV Series', PLAYLET: 'Short Drama', ANIME: 'Anime',
    VARIETY: 'Variety', DOCUMENTARY: 'Documentary',
  },
  contentType: { movie: 'Movie', series: 'Series', comic_drama: 'Anime', documentary: 'Documentary' },
  access: {
    free: 'Free', subscription: 'Membership', paid: 'Single purchase', owned: 'Owned',
    subscribed: 'Active member', trial: 'Preview',
  },
  accessMode: { free: 'Free', subscription: 'Membership', paid: 'Single purchase' },
  sort: { hot: 'Hot', new: 'Newest', score: 'Top rated', discuss: 'Most discussed', upcoming: 'Coming soon' },
  region: {
    US: 'United States', UK: 'United Kingdom', KR: 'South Korea', JP: 'Japan', TH: 'Thailand',
    CN: 'Mainland China', HK: 'Hong Kong', TW: 'Taiwan', OTHER: 'Other',
  },
  orderStatus: {
    created: 'Pending payment', pending: 'Pending payment', paid: 'Paid', fulfilled: 'Completed',
    closed: 'Closed', refunded: 'Refunded', refunding: 'Refunding',
  },
  withdrawalStatus: {
    pending_review: 'Pending review', approved: 'Approved', paid: 'Paid', rejected: 'Rejected',
  },
  commissionStatus: { pending: 'Frozen', available: 'Available', settled: 'Settled', reversed: 'Reversed' },
  settlementStatus: {
    pending_review: 'Pending review', approved: 'Ready to pay', paying: 'Paying', paid: 'Paid', rejected: 'Rejected',
  },
  currency: { CNY: 'Chinese Yuan', USD: 'US Dollar', USDT: 'USDT' },
  area: {
    中国: 'China', 内地: 'Mainland China', 中国香港: 'Hong Kong', 中国台湾: 'Taiwan',
    美国: 'United States', 英国: 'United Kingdom', 法国: 'France', 德国: 'Germany',
    荷兰: 'Netherlands', 日本: 'Japan', 韩国: 'South Korea', 泰国: 'Thailand',
    印度: 'India', 加拿大: 'Canada', 澳大利亚: 'Australia', 其他: 'Other',
  },
  rank: {
    HOT: 'Trending', SEARCH: 'Most Searched', RISE: 'Rising', EXPECT: 'Most Anticipated',
    CLASSIC: 'Classics', PLAYLIST: 'Short Dramas', QUARTER: 'This Quarter',
    HIGHRATE: 'Top Rated', HIDDEN: 'Hidden Gems',
  },
  contentRank: { hot: 'Trending', favorite: 'Most Favorited', completion: 'Most Completed', new: 'New Releases', recommend: 'Recommended' },
  genre: {
    剧情: 'Drama', 喜剧: 'Comedy', 动作: 'Action', 冒险: 'Adventure', 爱情: 'Romance', 动画: 'Animation',
    歌舞: 'Musical', 医疗: 'Medical', 科幻: 'Sci-Fi', 奇幻: 'Fantasy', 悬疑: 'Mystery', 惊悚: 'Thriller',
    犯罪: 'Crime', 传记: 'Biography', 历史: 'History', 战争: 'War', 灾难: 'Disaster', 美食: 'Food',
    真人秀: 'Reality', 脱口秀: 'Talk Show',
  },
}

export function normalizeLang(value = '') {
  return /^en(?:[-_]|$)/i.test(String(value).trim()) ? 'en' : 'zh'
}

export function langFromRequest(req, url) {
  return normalizeLang(
    url?.searchParams?.get('lang')
    || req?.headers?.['x-mh-lang']
    || req?.headers?.['accept-language']
    || 'zh',
  )
}

export function enumLabel(lang, domain, value, fallback = value) {
  const table = (normalizeLang(lang) === 'en' ? EN : ZH)[domain]
  return table?.[value] ?? fallback
}

export function enumOptions(lang, domain, values = []) {
  return values.map((value) => ({ value, label: enumLabel(lang, domain, value) }))
}

export function localizedYearLabel(lang, label) {
  if (normalizeLang(lang) !== 'en') return label
  if (label === '90年代') return '1990s'
  if (label === '80年代') return '1980s'
  return label
}
