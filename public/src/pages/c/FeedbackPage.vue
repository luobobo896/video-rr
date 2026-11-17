<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { publicApi } from '../../api.js';
import { formatDateTime } from '../../models.js';
import { href, route } from '../../router.js';
import { requireLogin, state, toast } from '../../authState.js';

const categories = ref([]);
const orders = ref([]);
const mine = ref([]);
const loading = ref(true);
const submitting = ref(false);
const error = ref('');
const result = ref(null);
const form = reactive({
  category: 'payment',
  content: '',
  contact: '',
  orderNo: ''
});

const orderQuery = computed(() => String(route.query?.order ?? ''));
const statusTone = (status) =>
  ({ pending: 'warn', processing: 'info', replied: 'info', resolved: 'ok', closed: 'muted' }[status] || 'muted');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const meta = await publicApi('/feedback/meta');
    categories.value = meta.categories ?? [];
    if (state.user) {
      form.contact = state.user.email || '';
      const [orderData, mineData] = await Promise.all([
        publicApi('/orders').catch(() => ({ list: [] })),
        publicApi('/feedback').catch(() => ({ list: [] }))
      ]);
      orders.value = orderData.list ?? [];
      mine.value = mineData.list ?? [];
    }
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
  if (orderQuery.value) form.orderNo = orderQuery.value;
}

async function submit() {
  if (submitting.value) return;
  if (form.content.trim().length < 5) {
    toast('请把问题描述清楚（至少 5 个字）', 'bad');
    return;
  }
  if (!state.user && !form.contact.trim()) {
    toast('未登录提交请留一个联系方式', 'bad');
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const data = await publicApi('/feedback', {
      method: 'POST',
      body: {
        category: form.category,
        content: form.content.trim(),
        contact: form.contact.trim(),
        orderNo: form.orderNo || undefined
      }
    });
    result.value = data;
    form.content = '';
    toast(`已提交，工单号 ${data.ticketNo}`);
    if (state.user) {
      const mineData = await publicApi('/feedback').catch(() => ({ list: [] }));
      mine.value = mineData.list ?? [];
    }
  } catch (requestError) {
    error.value = requestError.message;
    toast(requestError.message, 'bad');
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">投诉与反馈</h1>
      <p class="meta">播放、付费、账号问题都可以在这里提，客服会按工单回复；关联订单的问题可直接申请退款。</p>
    </div>
    <div class="toolbar">
      <a v-if="!state.user" class="section-link" href="#/login">登录后查看处理记录<Icon name="chevron" /></a>
      <a v-else class="section-link" :href="href('/orders')">我的订单<Icon name="chevron" /></a>
    </div>
  </div>

  <p v-if="error" class="field error" role="alert" style="margin: 0">{{ error }}</p>

  <div class="admin-grid">
    <form class="panel" @submit.prevent="submit">
      <div class="panel-head"><h3>提交问题</h3><span class="meta">工作日 24 小时内回复</span></div>
      <div class="toolbar" style="flex-wrap: wrap; gap: 8px; margin-bottom: 12px">
        <button
          v-for="item in categories"
          :key="item.code"
          class="chip"
          type="button"
          :aria-pressed="form.category === item.code"
          :title="item.hint"
          @click="form.category = item.code"
        >{{ item.label }}</button>
      </div>
      <div class="form-grid" style="grid-template-columns: 1fr">
        <div class="field">
          <label for="fb-content">问题描述</label>
          <textarea
            id="fb-content"
            v-model="form.content"
            maxlength="2000"
            rows="5"
            placeholder="例如：2026-11-17 购买单片后播放仍提示需要付费，订单号 MH…"
          ></textarea>
          <p class="small muted">{{ form.content.length }}/2000，写清时间、剧名、订单号会处理得更快。</p>
        </div>
        <div class="field" v-if="orders.length">
          <label for="fb-order">关联订单（可选）</label>
          <select id="fb-order" v-model="form.orderNo">
            <option value="">不关联订单</option>
            <option v-for="row in orders" :key="row.id" :value="row.outTradeNo">
              {{ row.outTradeNo }} · {{ row.statusLabel || row.status }} · ¥{{ row.amount }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="fb-contact">联系方式（未登录必填）</label>
          <input id="fb-contact" v-model="form.contact" maxlength="120" :placeholder="state.user?.email || '手机号或邮箱'" />
        </div>
      </div>
      <button class="btn btn--primary" style="margin-top: 16px" type="submit" :disabled="submitting">
        {{ submitting ? '提交中…' : '提交反馈' }}
      </button>
      <p v-if="result" class="small" style="margin-top: 12px">
        已受理：工单号 <strong>{{ result.ticketNo }}</strong>，可在{{ state.user ? '下方记录' : '邮件或联系方式' }}里查看回复。
      </p>
    </form>

    <section class="panel">
      <div class="panel-head"><h3>我的反馈</h3><span class="meta">{{ mine.length }} 条</span></div>
      <div v-if="!state.user" class="empty" style="padding: 20px 0">
        <Icon name="user" />
        <h3>登录后查看处理进度</h3>
        <p>未登录也能提交，但只有登录状态才能在此看到客服回复。</p>
        <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看处理进度')">去登录</button>
      </div>
      <div v-else-if="loading" class="empty" style="padding: 20px 0">
        <Icon name="orders" />
        <h3>正在加载</h3>
      </div>
      <div v-else-if="mine.length" class="todo-list">
        <article v-for="row in mine" :key="row.id" class="todo" style="align-items: flex-start">
          <span class="todo-mark"><Icon name="alert" /></span>
          <span class="todo-copy">
            <strong>{{ row.ticketNo }} · {{ row.categoryLabel }}</strong>
            <span>{{ row.content }}</span>
            <span class="meta">{{ formatDateTime(row.createdAt) }}<template v-if="row.orderNo"> · 订单 {{ row.orderNo }}</template></span>
            <span v-if="row.reply" class="small" style="color: var(--ink-1)">客服回复：{{ row.reply }}</span>
            <span v-if="row.refundStatus" class="small muted">
              退款单 {{ row.refundStatus }}{{ row.refundAmount ? ` · ¥${row.refundAmount}` : '' }}
            </span>
          </span>
          <span class="badge" :class="statusTone(row.status)">{{ row.statusLabel }}</span>
        </article>
      </div>
      <div v-else class="empty" style="padding: 20px 0">
        <Icon name="orders" />
        <h3>还没有提交过反馈</h3>
      </div>
    </section>
  </div>
</template>
