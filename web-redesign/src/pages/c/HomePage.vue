<script setup>
import { computed, onMounted, ref } from 'vue';
import CheckoutDialog from '../../components/CheckoutDialog.vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import RankRow from '../../components/RankRow.vue';
import { mediaUrl, publicApi } from '../../api.js';
import { t } from '../../i18n.js';
import { formatCount, normalizeCard, normalizedSection } from '../../models.js';
import { href } from '../../router.js';
import { loadConstants, loadPlans, refreshMe, requireLogin, state } from '../../authState.js';

const loading = ref(true);
const error = ref('');
const home = ref({ banners: [], sections: [], hotwords: [] });
const rankItems = ref([]);
const checkoutOpen = ref(false);

const sections = computed(() =>
  home.value.sections.map(normalizedSection).filter((section) => section.items.length)
);
const featureSection = computed(() => sections.value[0] ?? { title: '编辑片单', items: [] });
const featuredFilms = computed(() => featureSection.value.items.slice(0, 7));
const topRanks = computed(() => rankItems.value.slice(0, 4));
const vipPrice = computed(() => state.constants?.vipPrice ?? '25.00');
const adultEnabled = computed(() => state.constants?.adultMenu?.enabled !== false);
const heroBanner = computed(() => home.value.banners?.[0] ?? null);

const continueItems = computed(() =>
  (state.me?.history ?? []).slice(0, 3).map((row) => ({
    ...row,
    film: normalizeCard({
      dramaId: row.dramaId,
      title: row.title,
      coverUrl: row.coverUrl
    })
  }))
);

async function loadHome() {
  loading.value = true;
  error.value = '';
  try {
    const [homeData, rankData] = await Promise.all([
      publicApi('/home'),
      publicApi('/rank?type=HOT').catch(() => ({ items: [] })),
      loadConstants().catch(() => null),
      loadPlans().catch(() => []),
      refreshMe().catch(() => null)
    ]);
    home.value = homeData;
    rankItems.value = (rankData.items ?? []).map(normalizeCard);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadHome);

function openCheckout() {
  if (!state.user) {
    requireLogin('登录后即可开通会员');
    return;
  }
  checkoutOpen.value = true;
}
</script>

<template>
  <div v-if="heroBanner" class="hero">
    <img v-if="heroBanner.image" :src="mediaUrl(heroBanner.image)" alt="" />
    <div class="hero-body">
      <div class="hero-kicker"><span class="line"></span>影巢 · 精选</div>
      <h1 class="hero-title">{{ heroBanner.name || heroBanner.title }}</h1>
      <div class="hero-meta">
        <span v-if="heroBanner.score" class="accent">{{ Number(heroBanner.score).toFixed(1) }}</span>
        <span v-if="heroBanner.year">{{ heroBanner.year }}</span>
        <span v-if="heroBanner.categoryLabel">{{ heroBanner.categoryLabel }}</span>
        <span v-if="heroBanner.areaLabel">{{ heroBanner.areaLabel }}</span>
      </div>
      <p class="hero-desc">{{ heroBanner.description || heroBanner.subTitle }}</p>
      <div class="hero-actions">
        <a v-if="heroBanner.targetDramaId" class="btn btn--primary btn--lg" :href="href(`/detail/${heroBanner.targetDramaId}`)">
          <Icon name="play" />查看详情
        </a>
        <a class="btn btn--ghost btn--lg" :href="href('/category')"><Icon name="grid" />浏览片库</a>
      </div>
    </div>
  </div>
  <div v-else class="hero" :class="{ 'hero--adult': adultEnabled }">
    <div class="hero-side">
      <span>{{ adultEnabled ? '18+ · MIDNIGHT' : 'SELECTED · CINEMA' }}</span>
      <span>CHANNEL 01</span>
    </div>
    <div class="hero-body">
      <div class="hero-kicker"><span class="line"></span>影巢 · {{ adultEnabled ? '午夜场' : '精选' }}</div>
      <h1 class="hero-title">{{ adultEnabled ? t('午夜场') : t('影巢放映厅') }}</h1>
      <div class="hero-meta">
        <span v-if="adultEnabled" class="badge badge--18">18+</span>
        <span>影片</span><span>剧集</span><span>会员畅看</span>
      </div>
      <p class="hero-desc">
        {{ adultEnabled
          ? '深夜才开的放映厅。成人影片与短剧，更成熟的题材、更克制的界面，以及只对成年用户开放的内容分级。'
          : '精选电影、剧集与短剧。浏览片库，登录后同步观看记录、收藏与会员权益。' }}
      </p>
      <div class="hero-actions">
        <a v-if="adultEnabled" class="btn btn--primary btn--lg" :href="href('/adult')"><Icon name="lock" />进入成人专区</a>
        <a v-else class="btn btn--primary btn--lg" :href="href('/category')"><Icon name="grid" />浏览片库</a>
        <a v-if="adultEnabled" class="btn btn--ghost btn--lg" :href="href('/category')"><Icon name="grid" />浏览片库</a>
        <a v-else class="btn btn--ghost btn--lg" :href="href('/vip')"><Icon name="crown" />会员权益</a>
      </div>
    </div>
  </div>

  <div v-if="loading" class="empty">
    <Icon name="film" />
    <h3>正在加载片库</h3>
    <p>内容与观看记录正在同步。</p>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>首页加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="loadHome">重试</button>
  </div>
  <template v-else>
    <section>
      <div class="section-head">
        <div><h2>继续观看</h2><p>从上次停下的地方接着看</p></div>
        <a class="section-link" :href="href('/history')">全部记录<Icon name="chevron" /></a>
      </div>
      <div v-if="continueItems.length" class="continue-grid">
        <a
          v-for="item in continueItems"
          :key="item.dramaId"
          class="continue-card"
          :href="href(`/play/${item.dramaId}/${item.episode}`)"
        >
          <div class="continue-art">
            <img v-if="item.film.coverUrl" :src="item.film.coverUrl" alt="" />
            <span class="continue-glyph">{{ item.film.title[0] }}</span>
            <span class="continue-label">看到第 {{ item.episode }} 集</span>
            <div class="progress">
              <span :style="{ width: `${Math.min(96, Math.max(8, Number(item.position ?? 0)))}%` }"></span>
            </div>
          </div>
          <div class="continue-copy">
            <h3>{{ item.film.title }}</h3>
            <span>{{ formatCount(item.position ?? 0) }} 秒</span>
          </div>
        </a>
      </div>
      <div v-else class="panel">
        <div class="empty" style="padding: 32px 12px">
          <Icon name="clock" />
          <h3>还没有观看记录</h3>
          <p>{{ state.user ? '开始播放后会自动记录进度。' : '登录后同步观看记录。' }}</p>
          <a class="btn btn--ghost btn--sm" :href="href('/category')">去片库看看</a>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div><h2>{{ featureSection.title }}</h2><p>{{ featuredFilms.length }} 部内容</p></div>
        <a class="section-link" :href="href('/category')">查看全部<Icon name="chevron" /></a>
      </div>
      <div v-if="featuredFilms.length" class="film-grid">
        <PosterCard v-for="film in featuredFilms" :key="film.id" :film="film" />
      </div>
      <div v-else class="empty">
        <Icon name="film" />
        <h3>内容正在上架</h3>
        <p>剧场暂时没有已发布内容。</p>
      </div>
    </section>

    <section>
      <div class="member-strip">
        <div class="member-copy">
          <h3>会员套餐，随时入场</h3>
          <p>月卡 / 季卡 / 年卡可选，全站畅看、4K 原画、成人专区同权。</p>
        </div>
        <div class="member-price"><strong>¥{{ vipPrice }}</strong><span>/ 月</span></div>
        <button class="btn btn--primary" type="button" @click="openCheckout">选择会员套餐</button>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div><h2>本周榜单</h2><p>按服务端热播数据排序</p></div>
        <a class="section-link" :href="href('/rank')">完整榜单<Icon name="chevron" /></a>
      </div>
      <div v-if="topRanks.length" class="panel">
        <div class="rank-list">
          <RankRow
            v-for="(film, index) in topRanks"
            :key="film.id"
            :to="`/detail/${film.id}`"
            :rank="film.rankNo || index + 1"
            :title="film.title"
            :subtitle="[film.typeLabel, film.year, film.area].filter(Boolean).join(' · ')"
            :score="film.score.toFixed(1)"
          />
        </div>
      </div>
      <div v-else class="empty">
        <Icon name="chart" />
        <h3>榜单暂无内容</h3>
        <p>后台生成榜单后会显示在这里。</p>
      </div>
    </section>
  </template>

  <CheckoutDialog
    v-model="checkoutOpen"
    title="开通会员"
    subtitle="全站畅看 · 成人专区同权"
  />
</template>
