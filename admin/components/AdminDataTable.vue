<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { pageNumbers } from '../table-state.js'

const props = defineProps({
  columns: { type: Array, required: true },
  rows: { type: Array, default: () => [] },
  rowKey: { type: [String, Function], default: 'id' },
  loading: Boolean,
  error: { type: String, default: '' },
  emptyText: { type: String, default: '没有匹配的数据' },
  search: { type: String, default: '' },
  searchPlaceholder: { type: String, default: '搜索' },
  filters: { type: Array, default: () => [] },
  filterValues: { type: Object, default: () => ({}) },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  total: { type: Number, default: 0 },
  sortKey: { type: String, default: '' },
  sortDirection: { type: String, default: 'desc' },
})

const emit = defineEmits([
  'update:search',
  'update:filterValues',
  'update:page',
  'update:pageSize',
  'sort',
  'reset',
  'refresh',
])

const searchDraft = ref(props.search)
const hiddenKeys = ref(new Set())
let searchTimer

const visibleColumns = computed(() => props.columns.filter((column) => !hiddenKeys.value.has(column.key)))
const hideableColumns = computed(() => props.columns.filter((column) => column.hideable !== false))
const pageCount = computed(() => Math.max(1, Math.ceil(Math.max(0, props.total) / Math.max(1, props.pageSize))))
const numbers = computed(() => pageNumbers(props.page, pageCount.value))
const hasFilters = computed(() => Boolean(searchDraft.value) || Object.values(props.filterValues).some(Boolean))
const keyOf = (row) => typeof props.rowKey === 'function' ? props.rowKey(row) : row[props.rowKey]

watch(() => props.search, (value) => {
  const next = value ?? ''
  if (next === searchDraft.value || next === searchDraft.value.trim()) return
  clearTimeout(searchTimer)
  searchDraft.value = next
})
// 翻页后上一页的搜索草稿和隐藏列不能带过去：草稿会和 URL 里的新关键词打架，隐藏列按旧表头算也会错位
watch(() => props.page, () => {
  clearTimeout(searchTimer)
  searchDraft.value = props.search ?? ''
  hiddenKeys.value = new Set()
})
onBeforeUnmount(() => clearTimeout(searchTimer))

function onSearchInput(event) {
  searchDraft.value = event.target.value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => emit('update:search', searchDraft.value.trim()), 300)
}

function onFilterChange(key, value) {
  emit('update:filterValues', { ...props.filterValues, [key]: value })
}

function resetFilters() {
  clearTimeout(searchTimer)
  searchDraft.value = ''
  emit('reset')
}

function toggleColumn(key, visible) {
  const next = new Set(hiddenKeys.value)
  if (visible) next.delete(key)
  else next.add(key)
  hiddenKeys.value = next
}

function emitSort(key) {
  const direction = props.sortKey === key && props.sortDirection === 'asc' ? 'desc' : 'asc'
  emit('sort', { key, direction })
}

function ariaSort(column) {
  if (!column.sortable || props.sortKey !== column.key) return 'none'
  return props.sortDirection === 'asc' ? 'ascending' : 'descending'
}

function sortMark(column) {
  if (props.sortKey !== column.key) return '↕'
  return props.sortDirection === 'asc' ? '↑' : '↓'
}

function formatCell(column, row) {
  const value = row[column.key]
  return typeof column.format === 'function' ? column.format(value, row) : (value ?? '—')
}

function goPage(page) {
  if (page < 1 || page > pageCount.value || page === props.page) return
  emit('update:page', page)
}
</script>

<template>
  <section class="admin-data-table" :aria-busy="loading ? 'true' : 'false'">
    <div class="table-toolbar">
      <div class="table-toolbar-main">
        <label class="table-search">
          <span class="sr-only">{{ searchPlaceholder }}</span>
          <input :value="searchDraft" type="search" :placeholder="searchPlaceholder" @input="onSearchInput" />
        </label>
        <label v-for="filter in filters" :key="filter.key" class="table-filter">
          <span class="sr-only">{{ filter.label }}</span>
          <select :value="filterValues[filter.key] ?? ''" @change="onFilterChange(filter.key, $event.target.value)">
            <option value="">{{ filter.label }}：全部</option>
            <option v-for="option in filter.options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <button v-if="hasFilters" class="btn sm" type="button" @click="resetFilters">重置</button>
      </div>
      <div class="table-toolbar-side">
        <slot name="toolbar-actions" />
        <details class="table-view-menu">
          <summary class="btn sm">列</summary>
          <div class="table-view-popover">
            <label v-for="column in hideableColumns" :key="column.key">
              <input type="checkbox" :checked="!hiddenKeys.has(column.key)" @change="toggleColumn(column.key, $event.target.checked)" />
              {{ column.label }}
            </label>
          </div>
        </details>
        <label class="table-page-size">
          <span class="sr-only">每页数量</span>
          <select :value="pageSize" @change="$emit('update:pageSize', Number($event.target.value))">
            <option v-for="size in [10, 20, 50]" :key="size" :value="size">每页 {{ size }} 条</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="$slots.summary" class="table-summary">
      <slot name="summary" />
    </div>

    <div v-if="error" class="table-state table-state-error" role="alert">
      <strong>加载失败</strong>
      <span>{{ error }}</span>
      <button class="btn sm" type="button" @click="$emit('refresh')">重试</button>
    </div>

    <template v-else>
      <div v-if="loading && !rows.length" class="table-state table-loading" role="status" aria-live="polite">
        <span class="skeleton-line"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line"></span>
      </div>

      <div v-if="!loading && !rows.length" class="table-state">
        <strong>没有数据</strong>
        <span>{{ emptyText }}</span>
      </div>

      <div v-else class="table-scroll">
        <table class="admin-table" role="table">
          <thead>
            <tr>
              <th v-for="column in visibleColumns" :key="column.key" :aria-sort="ariaSort(column)" :style="{ width: column.width || undefined }">
                <button v-if="column.sortable" class="table-sort" type="button" @click="emitSort(column.key)">
                  {{ column.label }}
                  <span aria-hidden="true">{{ sortMark(column) }}</span>
                </button>
                <span v-else>{{ column.label }}</span>
              </th>
              <th v-if="$slots.actions" class="table-actions-head">操作</th>
            </tr>
          </thead>
          <tbody v-if="loading && !rows.length">
            <tr v-for="row in 5" :key="`skeleton-${row}`">
              <td v-for="column in visibleColumns" :key="column.key"><span class="skeleton-line"></span></td>
              <td v-if="$slots.actions"><span class="skeleton-line"></span></td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="row in rows" :key="keyOf(row)">
              <td v-for="column in visibleColumns" :key="column.key" :data-label="column.label" :class="column.className">
                <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
                  {{ formatCell(column, row) }}
                </slot>
              </td>
              <td v-if="$slots.actions" class="table-actions-cell" data-label="操作">
                <slot name="actions" :row="row" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!loading && rows.length" class="data-cards" role="list">
        <article v-for="row in rows" :key="keyOf(row)" class="data-card" role="listitem">
          <div v-for="column in visibleColumns" v-show="column.mobile !== false" :key="column.key" class="data-card-row">
            <span class="data-card-label">{{ column.label }}</span>
            <div class="data-card-value" :class="column.className">
              <slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]">
                {{ formatCell(column, row) }}
              </slot>
            </div>
          </div>
          <div v-if="$slots.actions" class="data-card-actions">
            <slot name="actions" :row="row" />
          </div>
        </article>
      </div>

      <footer v-if="total > 0" class="table-pagination">
        <span>共 <b>{{ total.toLocaleString('zh-CN') }}</b> 条 · 第 <b>{{ page }}</b> / {{ pageCount }} 页</span>
        <div class="table-pagination-pages">
          <button class="pager-btn" type="button" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button
            v-for="(number, index) in numbers"
            :key="`${number}-${index}`"
            class="pager-btn"
            :class="{ 'is-current': number === page }"
            type="button"
            :disabled="number === '…'"
            :aria-current="number === page ? 'page' : undefined"
            @click="number !== '…' && goPage(number)"
          >{{ number }}</button>
          <button class="pager-btn" type="button" :disabled="page >= pageCount" @click="goPage(page + 1)">下一页</button>
        </div>
      </footer>
    </template>
  </section>
</template>
