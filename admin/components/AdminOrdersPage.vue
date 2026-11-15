<script setup>
import { computed, onMounted, ref } from 'vue'
import AdminDataTable from './AdminDataTable.vue'
import { readHashQuery, writeHashQuery } from '../table-state.js'

const props = defineProps({
  api: { type: Function, required: true },
  toast: { type: Function, required: true },
  fmt: { type: Function, required: true },
  fmtTs: { type: Function, required: true },
  openOrderDetail: { type: Function, required: true },
  askText: { type: Function, required: true },
  askConfirm: { type: Function, required: true },
  permissions: { type: Array, default: () => [] },
})

const initial = readHashQuery()
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const page = ref(Math.max(1, Number(initial.page) || 1))
const pageSize = ref([10, 20, 50].includes(Number(initial.pageSize)) ? Number(initial.pageSize) : 20)
const q = ref(initial.q ?? '')
const status = ref(initial.status ?? '')
const sortKey = ref(initial.sort ?? 'id')
const sortDirection = ref(initial.dir === 'asc' ? 'asc' : 'desc')
const pagePaidTotal = computed(() => rows.value
  .filter((order) => ['paid', 'fulfilled'].includes(order.status))
  .reduce((sum, order) => sum + Number(order.amount_cny ?? 0), 0))
const permissions = computed(() => new Set(props.permissions ?? []))
const canConfirm = computed(() => permissions.value.has('finance.order.confirm'))
const canRefund = computed(() => permissions.value.has('finance.refund.create'))
let loadSeq = 0

const columns = [
  { key: 'out_trade_no', label: '单号', sortable: true, width: '190px' },
  { key: 'nickname', label: '用户', sortable: false },
  { key: 'product_type', label: '商品', sortable: false },
  { key: 'amount_cny', label: '金额', sortable: true, width: '100px' },
  { key: 'channel', label: '渠道', sortable: false, width: '92px' },
  { key: 'status', label: '状态', sortable: true, width: '100px' },
  { key: 'created_at', label: '时间', sortable: true, width: '160px' },
]

const filters = [{
  key: 'status',
  label: '状态',
  options: [
    { value: 'created', label: '待支付' },
    { value: 'pending', label: '待支付' },
    { value: 'paid', label: '已支付' },
    { value: 'fulfilled', label: '已完成' },
    { value: 'refunded', label: '已退款' },
    { value: 'closed', label: '已关闭' },
  ],
}]

const STATUS_LABEL = {
  fulfilled: ['ok', '已完成'],
  paid: ['ok', '已支付'],
  created: ['', '待支付'],
  pending: ['', '待支付'],
  closed: ['bad', '已关闭'],
  refunded: ['bad', '已退款'],
  refunding: ['', '退款中'],
}

function syncHash() {
  writeHashQuery('orders', {
    page: page.value > 1 ? page.value : '',
    pageSize: pageSize.value !== 20 ? pageSize.value : '',
    q: q.value.trim(),
    status: status.value,
    sort: sortKey.value !== 'id' ? sortKey.value : '',
    dir: sortDirection.value !== 'desc' ? sortDirection.value : '',
  })
}

async function load() {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      pageSize: String(pageSize.value),
      sort: sortKey.value,
      dir: sortDirection.value,
    })
    if (q.value.trim()) query.set('q', q.value.trim())
    if (status.value) query.set('status', status.value)
    const data = await props.api(`/admin/api/orders?${query.toString()}`)
    if (seq !== loadSeq) return
    rows.value = data.list ?? []
    total.value = Number(data.total ?? rows.value.length)
    page.value = Number(data.page ?? page.value)
  } catch (requestError) {
    if (seq !== loadSeq || requestError?.name === 'AbortError') return
    error.value = requestError.message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function applySearch(value) {
  q.value = value
  page.value = 1
  syncHash()
  load()
}

function applyFilters(values) {
  status.value = values.status ?? ''
  page.value = 1
  syncHash()
  load()
}

function resetFilters() {
  q.value = ''
  status.value = ''
  page.value = 1
  syncHash()
  load()
}

function applySort({ key, direction }) {
  sortKey.value = key
  sortDirection.value = direction
  page.value = 1
  syncHash()
  load()
}

function changePage(next) {
  page.value = next
  syncHash()
  load()
}

function changePageSize(next) {
  pageSize.value = next
  page.value = 1
  syncHash()
  load()
}

function productText(row) {
  return row.product_type === 'subscription'
    ? `会员 · ${row.plan_name ?? '—'}`
    : `单片 · ${row.drama_title ?? '—'}`
}

async function confirmOrder(row) {
  const txid = await props.askText({
    title: '确认订单到账',
    label: '链上 txid / 流水号',
    hint: 'USDT 建议填写；留空将记为人工补单。',
    required: false,
    confirmText: '确认到账',
  })
  if (txid === null) return
  try {
    await props.api(`/admin/api/orders/${row.id}/confirm`, { method: 'POST', body: { txid: txid || undefined } })
    props.toast('已确认到账并发放权益')
    await load()
  } catch (requestError) {
    props.toast(requestError.message)
  }
}

async function createRefund(row) {
  const reason = await props.askText({
    title: '发起退款',
    label: '退款原因',
    hint: '至少 4 个字，提交后需另一位管理员审批。',
    minLength: 4,
    confirmText: '提交退款',
  })
  if (reason === null) return
  try {
    await props.api('/admin/api/refunds', { method: 'POST', body: { orderId: row.id, reason } })
    props.toast('退款单已创建，需另一位管理员审批')
    await load()
  } catch (requestError) {
    props.toast(requestError.message)
  }
}

async function closeExpired() {
  if (!(await props.askConfirm({
    title: '关闭超时订单',
    message: '将关闭全部超过支付期限且未支付的订单，操作会立即生效。',
    confirmText: '关闭订单',
  }))) return
  try {
    const result = await props.api('/admin/api/close-expired', { method: 'POST', body: {} })
    props.toast(`已关闭 ${result.closed} 笔`)
    await load()
  } catch (requestError) {
    props.toast(requestError.message)
  }
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <h3>订单 <span class="muted">共 {{ fmt(total) }} 笔 · 本页已支付 ¥{{ pagePaidTotal.toFixed(2) }}</span></h3>
    </div>
    <AdminDataTable
      :columns="columns"
      :rows="rows"
      :loading="loading"
      :error="error"
      :search="q"
      search-placeholder="搜索单号 / 用户 / 商品"
      :filters="filters"
      :filter-values="{ status }"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :sort-key="sortKey"
      :sort-direction="sortDirection"
      empty-text="没有匹配的订单"
      @update:search="applySearch"
      @update:filter-values="applyFilters"
      @update:page="changePage"
      @update:page-size="changePageSize"
      @sort="applySort"
      @reset="resetFilters"
      @refresh="load"
    >
      <template #toolbar-actions>
        <button class="btn sm" type="button" @click="closeExpired">关闭超时订单</button>
      </template>
      <template #cell-nickname="{ row }">
        <div>{{ row.nickname || '—' }}</div>
        <div class="muted small">{{ row.phone || row.email || '' }}</div>
      </template>
      <template #cell-product_type="{ row }">{{ productText(row) }}</template>
      <template #cell-amount_cny="{ row }">¥{{ Number(row.amount_cny ?? 0).toFixed(2) }}</template>
      <template #cell-status="{ row }">
        <span class="pill" :class="(STATUS_LABEL[row.status] ?? ['', row.status])[0]">{{ (STATUS_LABEL[row.status] ?? ['', row.status])[1] }}</span>
      </template>
      <template #cell-created_at="{ row }">{{ fmtTs(row.paid_at ?? row.created_at) }}</template>
      <template #actions="{ row }">
        <div class="table-actions">
          <button class="btn sm" type="button" @click="openOrderDetail(row.id)">详情</button>
          <button v-if="canRefund && ['paid', 'fulfilled'].includes(row.status)" class="btn sm danger" type="button" @click="createRefund(row)">发起退款</button>
          <button v-else-if="canConfirm && ['created', 'pending'].includes(row.status)" class="btn sm" type="button" @click="confirmOrder(row)">确认到账</button>
        </div>
      </template>
    </AdminDataTable>
  </div>
</template>
