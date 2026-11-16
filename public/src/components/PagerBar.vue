<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  page: { type: Number, default: 1 },
  total: { type: Number, default: 0 },
  pageSize: { type: Number, default: 24 },
  loading: { type: Boolean, default: false }
});
const emit = defineEmits(['change']);

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))));
const current = computed(() => Math.min(Math.max(1, props.page), totalPages.value));

// 首页、末页、当前页与左右各一页，其余折叠成省略号
const slots = computed(() => {
  const last = totalPages.value;
  const cur = current.value;
  const keep = new Set([1, last, cur - 1, cur, cur + 1]);
  if (cur <= 3) [2, 3, 4].forEach((n) => keep.add(n));
  if (cur >= last - 2) [last - 1, last - 2, last - 3].forEach((n) => keep.add(n));
  const nums = [...keep].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of nums) {
    if (prev && n - prev > 1) out.push({ gap: true, key: `gap-${prev}-${n}` });
    out.push({ gap: false, key: `p-${n}`, n });
    prev = n;
  }
  return out;
});

function goPage(next) {
  if (props.loading) return;
  const target = Math.min(Math.max(1, next), totalPages.value);
  if (target === current.value) return;
  emit('change', target);
}
</script>

<template>
  <nav v-if="total > 0" class="pager" aria-label="分页">
    <template v-if="totalPages > 1">
      <button
        class="pager__step"
        type="button"
        :disabled="current <= 1 || loading"
        @click="goPage(current - 1)"
      >
        <Icon name="chevron" class="pager__icon pager__icon--prev" />
        <span>上一页</span>
      </button>
      <template v-for="slot in slots" :key="slot.key">
        <span v-if="slot.gap" class="pager__gap">…</span>
        <button
          v-else
          class="pager__num"
          type="button"
          :aria-current="slot.n === current ? 'page' : undefined"
          :disabled="loading"
          @click="goPage(slot.n)"
        >
          {{ slot.n }}
        </button>
      </template>
      <button
        class="pager__step"
        type="button"
        :disabled="current >= totalPages || loading"
        @click="goPage(current + 1)"
      >
        <span>下一页</span>
        <Icon name="chevron" class="pager__icon" />
      </button>
    </template>
    <!-- RESPONSIVE-DESIGN-SYSTEM §6.6：分页器必须显示「共 N 条 · 第 X / Y 页」 -->
    <span class="pager__meta">共 {{ total }} 条 · 第 {{ current }} / {{ totalPages }} 页</span>
  </nav>
</template>
