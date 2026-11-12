<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { publicApi } from '../api.js';
import { formatMoney } from '../models.js';
import { loadPlans, state, toast } from '../authState.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '开通会员' },
  subtitle: { type: String, default: '全站畅看 · 4K 原画' },
  allowSingle: { type: Boolean, default: false },
  dramaId: { type: Number, default: 0 },
  singlePrice: { type: Number, default: 0 }
});

const emit = defineEmits(['update:modelValue']);
const dialog = ref(null);
const plans = ref([]);
const selection = ref('');
const loading = ref(false);
const submitting = ref(false);
const error = ref('');
const order = ref(null);

const hasSingle = computed(() => props.allowSingle && props.singlePrice > 0);

function close() {
  emit('update:modelValue', false);
}

function selectDefault() {
  if (hasSingle.value) selection.value = 'single';
  else if (plans.value.length) selection.value = `plan:${plans.value[0].id}`;
}

async function load() {
  loading.value = true;
  error.value = '';
  order.value = null;
  try {
    plans.value = await loadPlans();
    selectDefault();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!state.user) {
    error.value = '请先登录后再购买';
    return;
  }
  if (!selection.value) {
    error.value = '请选择购买方式';
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    const payload = selection.value === 'single'
      ? { productType: 'single', dramaId: props.dramaId }
      : { productType: 'subscription', planId: Number(selection.value.split(':')[1]) };
    const result = await publicApi('/orders', { method: 'POST', body: payload });
    order.value = result;
    if (result.payUrl) window.open(result.payUrl, '_blank', 'noopener');
    toast('订单已创建');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    submitting.value = false;
  }
}

function openPayPage() {
  if (order.value?.payUrl) window.open(order.value.payUrl, '_blank', 'noopener');
}

watch(
  () => props.modelValue,
  async (open) => {
    await nextTick();
    if (!dialog.value) return;
    if (open && !dialog.value.open) {
      dialog.value.showModal();
      await load();
    } else if (!open && dialog.value.open) {
      dialog.value.close();
    }
  }
);
</script>

<template>
  <dialog ref="dialog" :aria-labelledby="`checkout-title-${dramaId}`" @close="close" @click.self="close">
    <div class="dialog-head">
      <div>
        <h2 :id="`checkout-title-${dramaId}`">{{ order ? '订单已创建' : title }}</h2>
        <p>{{ order ? order.outTradeNo : subtitle }}</p>
      </div>
      <button class="icon-btn dialog-close" type="button" aria-label="关闭" @click="close">
        <Icon name="close" />
      </button>
    </div>

    <div v-if="order" class="dialog-body">
      <div class="dialog-note">
        <Icon name="clock" />
        <span>请在支付页完成付款。支付确认后权益由服务端自动发放，本页不会伪造成功状态。</span>
      </div>
      <div class="detail-facts" style="border: 0; padding: 0">
        <span><strong>订单号</strong> {{ order.outTradeNo }}</span>
        <span><strong>金额</strong> {{ formatMoney(order.amount) }}</span>
        <span><strong>渠道</strong> {{ order.channel }}</span>
      </div>
      <div v-if="order.usdt" class="panel" style="margin: 0">
        <div class="panel-head"><h3>USDT（TRC20）</h3><span class="badge badge--warn">等待确认</span></div>
        <p class="small muted">应付 {{ order.usdt.amount }} USDT，汇率 {{ order.usdt.rate }}，确认数 {{ order.usdt.confirmations }}。</p>
        <p class="mono small" style="margin-top: 8px; word-break: break-all">{{ order.usdt.address }}</p>
      </div>
    </div>
    <div v-if="order" class="dialog-foot">
      <button class="btn btn--ghost" type="button" @click="close">关闭</button>
      <button class="btn btn--primary" type="button" @click="openPayPage" :disabled="!order.payUrl">
        打开支付页
      </button>
    </div>

    <form v-else @submit.prevent="submit">
      <div class="dialog-body">
        <div v-if="loading" class="empty" style="padding: 24px">正在加载价格…</div>
        <template v-else>
          <div class="plan-grid" :class="{ 'plan-grid--two': true }">
            <label v-if="hasSingle" class="plan">
              <input v-model="selection" type="radio" name="purchase" value="single" />
              <strong>单片购买</strong>
              <span>买断当前内容</span>
              <b>{{ formatMoney(singlePrice) }}</b>
            </label>
            <label v-for="plan in plans" :key="plan.id" class="plan">
              <input v-model="selection" type="radio" name="purchase" :value="`plan:${plan.id}`" />
              <strong>{{ plan.name }}</strong>
              <span>{{ plan.description }}</span>
              <b>{{ formatMoney(plan.price) }}</b>
            </label>
          </div>
          <div class="field">
            <label>支付方式</label>
            <div class="pay-method">
              <span>USDT（TRC20）</span>
              <span class="badge badge--ok">当前可用</span>
            </div>
          </div>
          <p v-if="error" class="field error" role="alert">{{ error }}</p>
        </template>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn btn--ghost" @click="close">取消</button>
        <button v-if="!order" class="btn btn--primary" type="submit" :disabled="loading || submitting">
          {{ submitting ? '创建订单中' : '去支付' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
