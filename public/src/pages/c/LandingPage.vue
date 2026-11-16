<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { getLang, setLang } from '../../i18n.js';
import { href } from '../../router.js';
import { isVip, loadPlans, state } from '../../authState.js';

const plans = ref([]);
const features = [
  { title: '全站畅看', text: '片库与剧集同权，会员内容不再单独购买。' },
  { title: '4K 原画', text: '清晰度、音轨与字幕偏好会保存在当前浏览器。' },
  { title: '双端同步', text: '观看记录、收藏和会员有效期跟随账号。' }
];
const lang = ref(getLang());
const minPrice = computed(() => {
  const values = plans.value.map((plan) => Number(plan.price)).filter((value) => value > 0);
  return values.length ? Math.min(...values) : Number(state.constants?.vipPrice ?? 25);
});

function toggleLang() {
  const next = lang.value === 'en' ? 'zh' : 'en';
  const url = new URL(window.location.href);
  url.searchParams.set('lang', next);
  window.history.replaceState(null, '', url);
  setLang(next);
  window.location.reload();
}

onMounted(async () => {
  try {
    plans.value = await loadPlans();
  } catch {
    plans.value = [];
  }
});
</script>

<template>
  <div class="landing">
    <header class="topbar">
      <a class="topbar-brand" :href="href('/')">
        <span class="brand-mark brand-mark--logo"><img :src="'./art/logo-mark.png'" alt="" width="32" height="32" /></span><span class="brand-name">影巢</span>
      </a>
      <div class="top-actions">
        <button class="icon-btn" type="button" :aria-label="lang === 'en' ? '切换到中文' : 'Switch to English'" @click="toggleLang">
          {{ lang === 'en' ? '中' : 'EN' }}
        </button>
        <a class="btn btn--ghost btn--sm" :href="href('/login')">登录</a>
      </div>
    </header>
    <main class="page">
      <section class="hero hero--lp">
        <div class="hero-media" style="position: absolute; inset: 0; z-index: -2; background: linear-gradient(120deg, #1a0a11, #0b0709 70%)"></div>
        <div class="hero-side"><span>MEMBERSHIP</span><span>ALL AGES</span></div>
        <div class="hero-body">
          <div class="hero-kicker"><span class="line"></span>影巢 · 精选放映</div>
          <h1 class="hero-title">今晚，<br />只放给你看。</h1>
          <p class="hero-desc">电影、剧集与动漫，会员全站畅看。4K 原画、无广告、双端同步；权益由服务端实时确认。</p>
          <div class="hero-meta">
            <span>¥{{ minPrice }} 起</span><span>随时取消</span>
          </div>
          <div class="hero-actions">
            <a class="btn btn--primary btn--lg" :href="href('/vip')">{{ isVip ? '立即续费' : '开通会员' }}</a>
            <a class="btn btn--ghost btn--lg" :href="href('/category')">浏览片库</a>
          </div>
        </div>
      </section>
      <section>
        <div class="section-head"><div><h2>会员能得到什么</h2><p>三个真实的权益，不堆形容词</p></div></div>
        <div class="feature-grid">
          <article v-for="feature in features" :key="feature.title" class="panel">
            <div class="panel-head"><h3>{{ feature.title }}</h3></div>
            <p class="small muted">{{ feature.text }}</p>
          </article>
        </div>
      </section>
      <section v-if="plans.length" class="landing-plans">
        <div class="section-head"><div><h2>会员套餐</h2><p>{{ plans.length }} 个在售</p></div></div>
        <div class="plan-grid">
          <div v-for="plan in plans" :key="plan.id" class="plan">
            <strong>{{ plan.name }}</strong>
            <span>{{ plan.description }}</span>
            <b>¥{{ Number(plan.price).toFixed(2) }} / {{ plan.days }} 天</b>
          </div>
        </div>
      </section>
      <section class="member-strip">
        <div class="member-copy"><h3>会员 ¥{{ minPrice }} 起</h3><p>支付成功后自动开通；未支付订单可在“我的订单”继续支付。</p></div>
        <div class="member-price"><strong>¥{{ minPrice }}</strong><span>起</span></div>
        <a class="btn btn--primary" :href="href('/vip')">立即开通</a>
      </section>
      <p class="meta">权益与价格由服务端确认 · <a href="mailto:support@yingchao.tv">support@yingchao.tv</a></p>
    </main>
  </div>
</template>
