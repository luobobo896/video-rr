<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { publicApi, siteBase } from '../../api.js';
import { formatDateTime, formatMoney } from '../../models.js';
import { state, requireLogin, toast } from '../../authState.js';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const applying = ref(false);

const link = computed(() => {
  if (!data.value?.code) return '';
  return `${window.location.origin}${siteBase}/i/${encodeURIComponent(data.value.code)}`;
});
const commission = computed(() => data.value?.commissions ?? {});

async function load() {
  if (!state.user) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    data.value = await publicApi('/distribution/me');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function apply() {
  applying.value = true;
  try {
    const result = await publicApi('/distribution/apply', { method: 'POST', body: {} });
    toast(result.message || '推广申请已提交');
    await load();
  } catch (requestError) {
    toast(requestError.message, 'bad');
  } finally {
    applying.value = false;
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(link.value);
    toast('推广链接已复制');
  } catch {
    toast(link.value);
  }
}

function downloadPoster() {
  if (!link.value) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1440);
  gradient.addColorStop(0, '#1b0b12');
  gradient.addColorStop(1, '#0b0709');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1440);
  ctx.strokeStyle = 'rgba(217,178,111,.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(48, 48, 984, 1344);
  ctx.fillStyle = '#d9b26f';
  ctx.font = "700 40px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText('影巢 · 午夜场', 96, 150);
  ctx.fillStyle = '#f7eef1';
  ctx.font = "700 108px 'Songti SC', 'SimSun', serif";
  ctx.fillText('深夜才开的', 96, 430);
  ctx.fillText('放映厅', 96, 560);
  ctx.fillStyle = '#c3adb4';
  ctx.font = "32px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText('电影 · 剧集 · 会员畅看', 96, 640);
  ctx.fillStyle = '#f0335f';
  ctx.fillRect(96, 760, 888, 4);
  ctx.fillStyle = '#f7eef1';
  ctx.font = "600 36px 'PingFang SC', sans-serif";
  ctx.fillText('扫码或打开推广链接', 96, 900);
  ctx.fillStyle = '#d9b26f';
  ctx.font = '24px ui-monospace, monospace';
  ctx.fillText(link.value.replace(/^https?:\/\//, ''), 96, 952);
  ctx.fillStyle = '#9a828b';
  ctx.font = "22px 'PingFang SC', sans-serif";
  ctx.fillText(`推广码 ${data.value.code} · 18+ 仅限成年用户`, 96, 1300);
  const anchor = document.createElement('a');
  anchor.download = `yingchao-promo-${data.value.code}.png`;
  anchor.href = canvas.toDataURL('image/png');
  anchor.click();
  toast('推广海报已生成');
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div><h1 class="h1">佣金推广</h1><p class="meta">分享片单，好友付费后按层级结算</p></div>
    <button v-if="data?.profile?.status === 'active'" class="btn btn--ghost btn--sm" type="button" @click="copyLink">
      <Icon name="share" />复制推广链接
    </button>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="share" />
    <h3>正在加载推广数据</h3>
  </div>
  <div v-else-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后开通佣金推广</h3>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后开通佣金推广')">登录</button>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>推广数据加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <div v-else-if="!data?.profile" class="empty">
    <Icon name="share" />
    <h3>还没有开通推广</h3>
    <p>申请通过后会自动生成专属推广码。</p>
    <button class="btn btn--primary btn--sm" type="button" :disabled="applying" @click="apply">
      {{ applying ? '提交中' : '申请开通佣金推广' }}
    </button>
  </div>
  <div v-else-if="data.profile.status !== 'active'" class="empty">
    <Icon name="clock" />
    <h3>{{ data.profile.status === 'pending' ? '申请待审核' : '推广已停用' }}</h3>
    <p>状态更新后会在这里显示推广码。</p>
  </div>
  <template v-else>
    <h2 class="sr-only">推广数据</h2>
    <div class="kpi-grid">
      <div class="kpi"><span class="k">推广码</span><strong class="v" style="font-size: 22px">{{ data.code }}</strong><span class="d">邀请链接已生成</span></div>
      <div class="kpi"><span class="k">邀请人数</span><strong class="v">{{ data.directInvitees ?? 0 }}</strong><span class="d">团队 {{ data.teamSize ?? 0 }} 人</span></div>
      <div class="kpi"><span class="k">好友支付</span><strong class="v">¥{{ Number(data.teamPaidAmount ?? 0).toFixed(2) }}</strong><span class="d">{{ data.paidOrders ?? 0 }} 笔订单</span></div>
      <div class="kpi"><span class="k">可提现</span><strong class="v">{{ formatMoney(Number(commission.withdrawableFen ?? 0) / 100) }}</strong><span class="d">冻结 {{ formatMoney(Number(commission.pendingFen ?? 0) / 100) }}</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>推广链接</h3><span class="meta">好友注册后绑定</span></div>
      <p class="mono small" style="word-break: break-all">{{ link }}</p>
      <div class="toolbar" style="margin-top: 12px">
        <button class="btn btn--primary btn--sm" type="button" @click="copyLink">复制链接</button>
        <button class="btn btn--ghost btn--sm" type="button" @click="downloadPoster">
          <Icon name="share" />下载推广海报
        </button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>佣金明细</h3><span class="meta">单位：元</span></div>
      <div class="rank-list">
        <div class="rank-row" style="grid-template-columns: 1fr auto">
          <span class="rank-main"><strong>可结算</strong><span>已过冻结期</span></span>
          <span class="rank-score">{{ formatMoney(Number(commission.availableFen ?? 0) / 100) }}</span>
        </div>
        <div class="rank-row" style="grid-template-columns: 1fr auto">
          <span class="rank-main"><strong>已结算</strong><span>已进入结算单</span></span>
          <span class="rank-score">{{ formatMoney(Number(commission.settledFen ?? 0) / 100) }}</span>
        </div>
        <div class="rank-row" style="grid-template-columns: 1fr auto">
          <span class="rank-main"><strong>退款冲减</strong><span>订单退款后冲减</span></span>
          <span class="rank-score">{{ formatMoney(Number(commission.reversedFen ?? 0) / 100) }}</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>提现记录</h3><span class="meta">{{ data.withdrawals?.length ?? 0 }} 条</span></div>
      <div v-if="data.withdrawals?.length" class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>金额</th><th>方式</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in data.withdrawals" :key="row.id">
              <td>{{ formatDateTime(row.created_at) }}</td>
              <td>{{ row.currency_symbol || '' }}{{ Number(row.amount ?? 0).toFixed(2) }}</td>
              <td>{{ row.method_name || row.method_code }}</td>
              <td>{{ row.statusLabel || row.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty" style="padding: 32px 12px">
        <Icon name="share" />
        <h3>还没有提现记录</h3>
      </div>
    </div>
  </template>
</template>
