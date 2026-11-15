<script setup>
import { computed, onMounted, ref } from 'vue'
import AdminDataTable from './AdminDataTable.vue'
import { readHashQuery, writeHashQuery } from '../table-state.js'

const props = defineProps({
  api: { type: Function, required: true },
  toast: { type: Function, required: true },
  fmt: { type: Function, required: true },
  fmtTs: { type: Function, required: true },
  permissions: { type: Array, default: () => [] },
  openUserPasswordEditor: { type: Function, required: true },
  askText: { type: Function, required: true },
  showNotice: { type: Function, required: true },
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
const perms = computed(() => new Set(props.permissions))
const canManage = computed(() => perms.value.has('user.manage'))
const canPassword = computed(() => perms.value.has('user.password'))
const canAssist = computed(() => perms.value.has('user.login.assist'))
const pagePaidTotal = computed(() => rows.value.reduce((sum, row) => sum + Number(row.paid_total ?? 0), 0))
let loadSeq = 0

const columns = [
  { key: 'id', label: 'ID', sortable: true, width: '64px' },
  { key: 'email', label: '邮箱', sortable: true },
  { key: 'nickname', label: '昵称', sortable: true },
  { key: 'status', label: '状态', sortable: true, width: '92px' },
  { key: 'vip_until', label: '会员到期', sortable: true },
  { key: 'order_count', label: '订单数', sortable: true, width: '92px' },
  { key: 'paid_total', label: '累计付费', sortable: true, width: '112px' },
]

const filters = [{
  key: 'status',
  label: '状态',
  options: [
    { value: 'active', label: '正常' },
    { value: 'banned', label: '已禁用' },
  ],
}]

function syncHash() {
  writeHashQuery('users', {
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
    const data = await props.api(`/admin/api/users?${query.toString()}`)
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

async function toggleStatus(row) {
  const next = row.status === 'banned' ? 'active' : 'banned'
  const reason = await props.askText({
    title: next === 'banned' ? '禁用用户' : '恢复用户',
    label: '操作原因',
    hint: '原因会写入审计日志。',
    minLength: 2,
    confirmText: '提交',
  })
  if (reason === null) return
  try {
    await props.api(`/admin/api/users/${row.id}/status`, { method: 'POST', body: { status: next, reason } })
    props.toast('已更新用户状态')
    await load()
  } catch (requestError) {
    props.toast(requestError.message)
  }
}

async function issueLoginCode(row) {
  const reason = await props.askText({
    title: '签发一次性登录码',
    label: '签发原因',
    hint: '原因会写入审计日志。',
    minLength: 2,
    confirmText: '生成',
  })
  if (reason === null) return
  try {
    const result = await props.api(`/admin/api/users/${row.id}/login-code`, { method: 'POST', body: { reason } })
    await props.showNotice({
      title: '一次性登录码已生成',
      message: `${result.email}\n${Math.round(result.expiresIn / 60)} 分钟内有效，仅可使用一次。请通过可靠渠道转交用户，关闭后无法再次查看。`,
      code: result.code,
    })
    await load()
  } catch (requestError) {
    props.toast(requestError.message)
  }
}

function editPassword(row, mode) {
  props.openUserPasswordEditor(row, mode, load)
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <h3>用户 <span class="muted">共 {{ fmt(total) }} 人 · 当前页付费合计 ¥{{ pagePaidTotal.toFixed(2) }}</span></h3>
    </div>
    <p class="muted">C 端使用邮箱验证码登录。搜索和筛选会保留在地址栏，刷新后仍可继续。</p>
    <AdminDataTable
      :columns="columns"
      :rows="rows"
      :loading="loading"
      :error="error"
      :search="q"
      search-placeholder="搜索邮箱或昵称"
      :filters="filters"
      :filter-values="{ status }"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :sort-key="sortKey"
      :sort-direction="sortDirection"
      empty-text="没有匹配的用户"
      @update:search="applySearch"
      @update:filter-values="applyFilters"
      @update:page="changePage"
      @update:page-size="changePageSize"
      @sort="applySort"
      @reset="resetFilters"
      @refresh="load"
    >
      <template #cell-status="{ row }">
        <span class="pill" :class="row.status === 'banned' ? 'bad' : 'ok'">{{ row.status === 'banned' ? '已禁用' : '正常' }}</span>
      </template>
      <template #cell-vip_until="{ row }">{{ fmtTs(row.vip_until) }}</template>
      <template #cell-order_count="{ row }">{{ fmt(Number(row.order_count ?? 0)) }}</template>
      <template #cell-paid_total="{ row }">¥{{ Number(row.paid_total ?? 0).toFixed(2) }}</template>
      <template #actions="{ row }">
        <div class="table-actions">
          <button v-if="canManage" class="btn sm" type="button" @click="toggleStatus(row)">{{ row.status === 'banned' ? '解禁' : '禁用' }}</button>
          <button v-if="canPassword" class="btn sm" type="button" @click="editPassword(row, 'set')">改密</button>
          <button v-if="canPassword && row.email" class="btn sm" type="button" @click="editPassword(row, 'reset')">重置密码</button>
          <button v-if="canAssist && row.email" class="btn sm ghost" type="button" @click="issueLoginCode(row)">登录码</button>
          <span v-if="!canManage && !canPassword && !canAssist" class="muted">只读</span>
        </div>
      </template>
    </AdminDataTable>
  </div>
</template>
