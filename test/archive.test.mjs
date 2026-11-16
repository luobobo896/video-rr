/**
 * archive.org 刮削器解析测试：只用纯函数，不联网、不碰真实数据库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  areaOf, buildDrama, buildQuery, canonicalNameOf, categoryOf, cleanText, contentTypeOf,
  episodeNumberIn, groupEpisodes, pickVideoFiles, releaseYearOf, searchUrl, titleWithoutYear, yearOf,
} from '../server/archive.mjs'

const video = (name, extra = {}) => ({ name, format: 'h.264', size: 5_000_000, length: '3600', ...extra })

test('cleanText 去掉 HTML 标签并解码实体', () => {
  assert.equal(cleanText('<p>A&nbsp;&amp; B</p><br>第二行'), 'A & B\n第二行')
  assert.equal(cleanText(['第一段', '第二段']), '第一段 第二段')
  assert.equal(cleanText(undefined), '')
})

test('yearOf 从各种日期写法里取年份', () => {
  assert.equal(yearOf('1938'), 1938)
  assert.equal(yearOf('1938-01-01T00:00:00Z'), 1938)
  assert.equal(yearOf('unknown'), null)
  assert.equal(yearOf(''), null)
})

test('areaOf 认语言全称，也优先用 country', () => {
  assert.equal(areaOf({ language: 'English' }), '美国')
  assert.equal(areaOf({ language: 'fre, eng' }), '法国')
  assert.equal(areaOf({ country: 'France; Italy', language: 'English' }), 'France')
  assert.equal(areaOf({}), '')
})

test('canonicalNameOf 把同一部片的派生版本收敛成一个键', () => {
  assert.equal(canonicalNameOf('sex_madness_512kb.mp4'), canonicalNameOf('sex_madness.mp4'))
  assert.equal(canonicalNameOf('His Girl Friday 512kb.mp4'), canonicalNameOf('his_girl_friday.mp4'))
  assert.notEqual(canonicalNameOf('ep01.mp4'), canonicalNameOf('ep02.mp4'))
})

test('pickVideoFiles 丢掉封面/文本/种子，同名派生版只留一份', () => {
  const files = [
    video('sex_madness_512kb.mp4', { format: '512Kb MPEG4', size: 3_000_000 }),
    video('sex_madness.mp4', { format: 'h.264', size: 9_000_000 }),
    { name: 'sex_madness_meta.xml', format: 'Metadata', size: 2000 },
    { name: 'sex_madness.thumbs/1.jpg', format: 'Thumbnail', size: 9000 },
    { name: '__ia_thumb.jpg', format: 'Item Tile', size: 6000 },
    { name: 'sex_madness_files.xml', format: 'Metadata' },
    video('tiny.mp4', { size: 10_000 }),
  ]
  const picked = pickVideoFiles(files)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].name, 'sex_madness.mp4')
})

test('episodeNumberIn 只认明确集号，不从片名数字里猜', () => {
  assert.equal(episodeNumberIn('show_s01e02.mp4'), 2)
  assert.equal(episodeNumberIn('show_s02e03.mp4'), 2003)
  assert.equal(episodeNumberIn('show_ep07.mp4'), 7)
  assert.equal(episodeNumberIn('show episode 12.mkv'), 12)
  assert.equal(episodeNumberIn('连续剧 第4集.mp4'), 4)
  assert.equal(episodeNumberIn('film_part3.mp4'), 3)
  assert.equal(episodeNumberIn('Rocky 2.mp4'), 0)
  assert.equal(episodeNumberIn('Chaplin-1915.mp4'), 0)
  assert.equal(episodeNumberIn('VoyagetothePlanetofPrehistoricWomen.mp4'), 0)
})

test('groupEpisodes 按识别到的集号排序，识别不到的按自然顺序补号', () => {
  const noNumbers = groupEpisodes([video('part_b.mp4'), video('part_a.mp4')], 'item')
  assert.deepEqual(noNumbers.map((item) => item.no), [1, 2])
  assert.deepEqual(noNumbers.map((item) => item.source), ['part_a.mp4', 'part_b.mp4'])

  const numbered = groupEpisodes([video('ep10.mp4'), video('ep2.mp4'), video('ep1.mp4')], 'item')
  assert.deepEqual(numbered.map((item) => item.no), [1, 2, 10])
  assert.equal(numbered[0].remoteUrl, 'https://archive.org/download/item/ep1.mp4')
})

test('groupEpisodes 遇到重复集号时往后挪，保证唯一', () => {
  const episodes = groupEpisodes([video('ep1.mp4'), video('show_ep1.mkv'), video('ep2.mp4')], 'item')
  const numbers = episodes.map((item) => item.no)
  assert.equal(new Set(numbers).size, numbers.length)
})

test('categoryOf 把短剧降级成电影，避免成人内容被刮进来', () => {
  assert.equal(categoryOf({ category: 'PLAYLET' }), 'MOVIE')
  assert.equal(categoryOf({ category: 'TV' }), 'TV')
  assert.equal(categoryOf({ collection: ['classic_tv'] }), 'TV')
  assert.equal(categoryOf({ collection: ['feature_films'] }), 'MOVIE')
  assert.equal(contentTypeOf('TV'), 'series')
  assert.equal(contentTypeOf('MOVIE'), 'movie')
})

test('buildDrama 组装剧目与剧集，无视频文件返回 null', () => {
  const draft = buildDrama({
    identifier: 'his_girl_friday',
    metadata: {
      title: 'His Girl Friday',
      year: '1940',
      language: 'English',
      subject: ['comedy', 'newspaper', 'screwball'],
      description: '<p>报社喜剧。</p>',
      licenseurl: 'http://creativecommons.org/licenses/publicdomain/',
    },
    files: [video('his_girl_friday.mp4'), video('his_girl_friday_512kb.mp4', { format: '512Kb MPEG4' })],
    doc: { downloads: 42 },
  })
  assert.equal(draft.sourceKey, 'archive:his_girl_friday')
  assert.equal(draft.title, 'His Girl Friday')
  assert.equal(draft.year, 1940)
  assert.equal(draft.area, '美国')
  assert.equal(draft.category, 'MOVIE')
  assert.equal(draft.contentType, 'movie')
  assert.equal(draft.coverUrl, 'https://archive.org/services/img/his_girl_friday')
  assert.deepEqual(draft.tags, ['comedy', 'newspaper', 'screwball'])
  assert.equal(draft.episodes.length, 1)
  assert.equal(draft.description, '报社喜剧。')
  assert.equal(draft.downloads, 42)

  assert.equal(buildDrama({ identifier: 'empty', metadata: {}, files: [] }), null)
})

test('buildDrama 给没有简介的条目写兜底文案', () => {
  const draft = buildDrama({
    identifier: 'sex_madness',
    metadata: { title: 'Sex Madness', year: '1938', subject: ['drama'] },
    files: [video('sex_madness.mp4')],
  })
  assert.match(draft.description, /archive\.org/)
  assert.equal(draft.episodes[0].no, 1)
})

test('标题尾部的年份挪进 year 字段，上传年不会盖掉发行年', () => {
  assert.equal(titleWithoutYear('My Man Godfrey (1936) (2010)'), 'My Man Godfrey')
  assert.equal(titleWithoutYear('Le voyage dans la lune (2006)'), 'Le voyage dans la lune')
  assert.equal(titleWithoutYear('Rocky 2'), 'Rocky 2')
  assert.equal(releaseYearOf({ title: 'My Man Godfrey (1936)', metadata: { year: '2010' } }), 1936)
  assert.equal(releaseYearOf({ metadata: { date: '1940-01-11', year: '2012' } }), 1940)
  assert.equal(releaseYearOf({ metadata: { year: '2010' } }), 2010)
  assert.equal(releaseYearOf({ metadata: {} }), null)

  const draft = buildDrama({
    identifier: 'my_man_godfrey',
    metadata: { title: 'My Man Godfrey (1936)', year: '2010', subject: ['comedy'] },
    files: [video('my_man_godfrey.mp4')],
  })
  assert.equal(draft.title, 'My Man Godfrey')
  assert.equal(draft.year, 1936)
})

test('buildQuery / searchUrl 拼检索式与字段', () => {
  assert.equal(buildQuery({}), 'mediatype:movies AND licenseurl:*')
  assert.equal(
    buildQuery({ collection: 'feature_films,film_noir', yearFrom: 1940, yearTo: 1950 }),
    'mediatype:movies AND licenseurl:* AND collection:feature_films AND collection:film_noir AND year:[1940 TO 1950]',
  )
  assert.equal(buildQuery({ query: 'title:(chaplin)', licenseOnly: false }), '(title:(chaplin))')

  const url = searchUrl({ collection: 'feature_films', rows: 50, page: 2 })
  const parsed = url instanceof URL ? url : new URL(String(url))
  assert.equal(parsed.host, 'archive.org')
  assert.equal(parsed.searchParams.get('q'), 'mediatype:movies AND licenseurl:* AND collection:feature_films')
  assert.equal(parsed.searchParams.get('rows'), '50')
  assert.equal(parsed.searchParams.get('page'), '2')
  assert.equal(parsed.searchParams.get('output'), 'json')
  assert.ok(parsed.searchParams.getAll('fl[]').includes('licenseurl'))
})
