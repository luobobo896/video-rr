<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { adminApi } from '../../api.js';
import {
  CATEGORY_LABEL,
  STATUS_LABEL,
  formatCount,
  formatDate,
  formatDateTime,
  formatMoney,
  statusClass
} from '../../models.js';
import { route } from '../../router.js';
import { toast } from '../../authState.js';

const key = computed(() => route.path.split('/').pop() || 'overview');
const loading = ref(true);
const error = ref('');
const payload = ref(null);
const adultEnabled = ref(true);
const adultZh = ref('成人');
const adultEn = ref('Adult');
const savingAdult = ref(false);

const loaders = {
  overview: () => adminApi('/stats'),
  analytics: () => adminApi('/analytics?days=7'),
  tracking: () => adminApi('/events?days=7&pageSize=20'),
  channels: () => adminApi('/channels/analytics?days=7'),
  dramas: () => adminApi('/dramas?page=1&pageSize=20'),
  policies: () => adminApi('/policy-groups'),
  adult: async () => {
    const [menu, stats] = await Promise.all([
      adminApi('/adult-menu'),
      adminApi('/adult-stats')
    ]);
    adultEnabled.value = menu.enabled !== false;
    adultZh.value = menu.labelZh ?? '成人';
    adultEn.value = menu.labelEn ?? 'Adult';
    return { menu, stats };
  },
  tags: () => adminApi('/tags?scope=all&includeDisabled=1'),
  ranks: () => adminApi('/ranks'),
  moderation: async () => {
    const [danmus, comments] = await Promise.all([
      adminApi('/danmus?status=pending&pageSize=20'),
      adminApi('/comments?status=pending&pageSize=20')
    ]);
    return { danmus, comments };
  },
  'content-stats': async () => {
    const [stats, ranks] = await Promise.all([
      adminApi('/content-stats?days=7'),
      adminApi('/content-ranks?type=hot&contentType=all')
    ]);
    return { stats, ranks };
  },
  plans: () => adminApi('/plans'),
  coupons: () => adminApi('/coupons'),
  orders: () => adminApi('/orders?page=1&pageSize=20'),
  refunds: () => adminApi('/refunds?page=1&pageSize=20'),
  distribution: async () => {
    const [overview, dashboard] = await Promise.all([
      adminApi('/distribution/overview?days=30'),
      adminApi('/distribution/dashboard?days=30')
    ]);
    return { overview, dashboard };
  },
  'distribution-config': () => adminApi('/distribution/config'),
  users: () => adminApi('/users?page=1&pageSize=20'),
  menus: () => adminApi('/admin-menus'),
  roles: async () => {
    const [roles, admins] = await Promise.all([
      adminApi('/roles'),
      adminApi('/admins')
    ]);
    return { ...roles, admins: admins.list ?? [] };
  },
  'admin-users': () => adminApi('/admins'),
  audit: () => adminApi('/audit?page=1&pageSize=20'),
  pay: () => adminApi('/pay-channels'),
  mail: () => adminApi('/email-channels')
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const loader = loaders[key.value];
    if (!loader) throw new Error('页面不存在');
    payload.value = await loader();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function saveAdultMenu() {
  savingAdult.value = true;
  try {
    await adminApi('/adult-menu', {
      method: 'PUT',
      body: {
        enabled: adultEnabled.value,
        labelZh: adultZh.value.trim(),
        labelEn: adultEn.value.trim()
      }
    });
    toast('成人菜单设置已保存');
    await load();
  } catch (requestError) {
    toast(requestError.message, 'bad');
  } finally {
    savingAdult.value = false;
  }
}

async function review(kind, row, action) {
  try {
    await adminApi(`/${kind}/${row.id}/${action}`, { method: 'POST', body: {} });
    toast(action === 'approve' ? '已通过' : '已驳回');
    await load();
  } catch (requestError) {
    toast(requestError.message, 'bad');
  }
}

async function approveRefund(row) {
  try {
    const result = await adminApi(`/refunds/${row.id}/approve`, { method: 'POST', body: {} });
    toast(result.warning || '退款已通过，权益已回收');
    await load();
  } catch (requestError) {
    toast(requestError.message, 'bad');
  }
}

async function rejectRefund(row) {
  const reason = window.prompt('请输入驳回原因（至少 4 个字）');
  if (reason === null) return;
  if (reason.trim().length < 4) {
    toast('驳回原因至少 4 个字', 'bad');
    return;
  }
  try {
    await adminApi(`/refunds/${row.id}/reject`, {
      method: 'POST',
      body: { reason: reason.trim() }
    });
    toast('退款已驳回');
    await load();
  } catch (requestError) {
    toast(requestError.message, 'bad');
  }
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="empty">
    <Icon name="refresh" />
    <h3>正在读取后台数据</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>页面加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>

  <template v-else-if="key === 'overview'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">已上架剧集</span><strong class="v">{{ formatCount(payload.publishedDramas) }}</strong><span class="d">草稿 {{ payload.draftDramas ?? 0 }}</span></div>
      <div class="kpi"><span class="k">分集</span><strong class="v">{{ formatCount(payload.episodes) }}</strong><span class="d">可播 {{ payload.readyEpisodes ?? 0 }}</span></div>
      <div class="kpi"><span class="k">标签</span><strong class="v">{{ formatCount(payload.tags) }}</strong><span class="d">启用中</span></div>
      <div class="kpi"><span class="k">C 端用户</span><strong class="v">{{ formatCount(payload.users) }}</strong><span class="d">7 日活跃 {{ payload.activeUsers7d ?? 0 }}</span></div>
      <div class="kpi"><span class="k">转码队列</span><strong class="v">{{ payload.queue?.pending ?? 0 }}</strong><span class="d">{{ payload.queue?.running ? '转码中' : '空闲' }}</span></div>
      <div class="kpi"><span class="k">待审弹幕</span><strong class="v">{{ payload.pendingDanmu ?? 0 }}</strong><span class="d">条</span></div>
      <div class="kpi"><span class="k">待审评论</span><strong class="v">{{ payload.pendingComments ?? 0 }}</strong><span class="d">条</span></div>
      <div class="kpi"><span class="k">邮件通道</span><strong class="v" style="font-size: 18px">{{ payload.mailReady ? '可用' : '未配置' }}</strong><span class="d" :class="{ down: !payload.mailReady }">{{ payload.mailReady ? '验证码可发送' : '需检查邮件设置' }}</span></div>
    </div>
    <div class="admin-grid">
      <div class="panel">
        <div class="panel-head"><h3>近 7 日活跃</h3><span class="meta">服务端统计</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日期</th><th>播放</th><th>观众</th><th>新用户</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.activity" :key="row.day">
                <td>{{ row.day }}</td><td>{{ formatCount(row.plays) }}</td>
                <td>{{ formatCount(row.viewers) }}</td><td>{{ formatCount(row.users) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>内容结构</h3><span class="meta">{{ payload.dramas }} 部</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>类型</th><th>数量</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.categories" :key="row.category">
                <td>{{ row.label || CATEGORY_LABEL[row.category] || row.category }}</td>
                <td>{{ row.n }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'analytics'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">播放量</span><strong class="v">{{ formatCount(payload.totals?.plays) }}</strong><span class="d">历史 {{ formatCount(payload.totals?.playsAllTime) }}</span></div>
      <div class="kpi"><span class="k">独立观众</span><strong class="v">{{ formatCount(payload.totals?.viewers) }}</strong><span class="d">人均 {{ payload.totals?.playsPerViewer ?? 0 }} 次</span></div>
      <div class="kpi"><span class="k">收入</span><strong class="v">{{ formatMoney(payload.money?.revenue) }}</strong><span class="d">客单价 {{ formatMoney(payload.money?.aov) }}</span></div>
      <div class="kpi"><span class="k">支付转化</span><strong class="v">{{ payload.funnel?.payRate ?? 0 }}<small>%</small></strong><span class="d">{{ payload.funnel?.paid ?? 0 }} / {{ payload.funnel?.orders ?? 0 }} 单</span></div>
    </div>
    <div class="admin-grid">
      <div class="panel">
        <div class="panel-head"><h3>每日播放</h3><span class="meta">近 7 天</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日期</th><th>播放</th><th>观众</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.playsByDay" :key="row.day">
                <td>{{ row.day }}</td><td>{{ row.plays }}</td><td>{{ row.viewers }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>热门内容</h3><span class="meta">Top 10</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>内容</th><th>播放</th><th>观众</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.topDramas" :key="row.title">
                <td>{{ row.title }}</td><td>{{ row.plays }}</td><td>{{ row.viewers }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>订单漏斗</h3><span class="meta">服务端口径</span></div>
      <div class="detail-facts" style="border: 0; padding: 0">
        <span><strong>下单</strong> {{ payload.funnel?.orders ?? 0 }}</span>
        <span><strong>已支付</strong> {{ payload.funnel?.paid ?? 0 }}</span>
        <span><strong>关闭</strong> {{ payload.funnel?.closed ?? 0 }}</span>
        <span><strong>退款中</strong> {{ payload.money?.pendingRefunds ?? 0 }}</span>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'tracking'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">事件总数</span><strong class="v">{{ formatCount(payload.total) }}</strong><span class="d">近 7 天</span></div>
      <div class="kpi"><span class="k">独立访客</span><strong class="v">{{ formatCount(payload.visitors) }}</strong><span class="d">去重</span></div>
      <div class="kpi"><span class="k">事件类型</span><strong class="v">{{ payload.byType?.length ?? 0 }}</strong><span class="d">种</span></div>
      <div class="kpi"><span class="k">明细</span><strong class="v">{{ payload.list?.length ?? 0 }}</strong><span class="d">当前页</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>事件明细</h3><span class="meta">最近记录</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>事件</th><th>用户</th><th>访客</th><th>路径</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.type }}</td><td>{{ row.user_id || '匿名' }}</td>
              <td class="mono">{{ row.visitor_id ? row.visitor_id.slice(0, 8) : '—' }}</td>
              <td>{{ row.path || '—' }}</td><td>{{ formatDateTime(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'channels'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">渠道访客</span><strong class="v">{{ formatCount(payload.totals?.visitors) }}</strong><span class="d">人</span></div>
      <div class="kpi"><span class="k">新增注册</span><strong class="v">{{ formatCount(payload.totals?.newUsers) }}</strong><span class="d">人</span></div>
      <div class="kpi"><span class="k">支付订单</span><strong class="v">{{ formatCount(payload.totals?.paidOrders) }}</strong><span class="d">单</span></div>
      <div class="kpi"><span class="k">支付金额</span><strong class="v">{{ formatMoney(payload.totals?.grossPaidAmount) }}</strong><span class="d">访客支付率 {{ payload.totals?.visitorToPaidRate ?? 0 }}%</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>渠道表现</h3><span class="meta">近 7 天</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>渠道</th><th>访客</th><th>注册</th><th>下单</th><th>支付</th><th>支付率</th><th>净收入</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.rows" :key="row.channelCode">
              <td>{{ row.channelName }}<span class="meta"> · {{ row.channelCode }}</span></td>
              <td>{{ row.visitors }}</td><td>{{ row.newUsers }}</td><td>{{ row.createdOrders }}</td>
              <td>{{ row.paidOrders }}</td><td>{{ row.payRate }}%</td><td>{{ formatMoney(row.netRevenue) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'dramas'">
    <div class="panel">
      <div class="panel-head"><h3>剧集库</h3><span class="meta">共 {{ payload.total }} 部 · 当前页 {{ payload.list?.length ?? 0 }} 部</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>标题</th><th>类型</th><th>分集</th><th>状态</th><th>更新</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.id }}</td>
              <td>{{ row.title }}<div class="meta">{{ row.sub_title }}</div></td>
              <td>{{ CATEGORY_LABEL[row.category] || row.category }}<span v-if="row.isAdult" class="badge badge--18">18+</span></td>
              <td>{{ row.readyEpisodes }}/{{ row.episodeCount }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
              <td>{{ formatDateTime(row.updatedAt || row.updated_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'policies'">
    <div class="panel">
      <div class="panel-head"><h3>策略组</h3><span class="meta">共 {{ payload.groups?.length ?? 0 }} 组 · 未分组 {{ payload.ungrouped ?? 0 }} 部</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>策略组</th><th>模式</th><th>免费集</th><th>试看秒数</th><th>单片价</th><th>已分配</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.groups" :key="row.id">
              <td>{{ row.name }}<div class="meta">{{ row.description }}</div></td>
              <td>{{ row.access_mode }}</td><td>{{ row.free_episodes }}</td>
              <td>{{ row.trial_seconds }}</td><td>{{ formatMoney(row.single_price_cny) }}</td>
              <td>{{ row.assigned }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'adult'">
    <div class="settings-grid">
      <div class="panel">
        <div class="panel-head"><h3>成人菜单</h3><span class="badge" :class="adultEnabled ? 'badge--ok' : 'badge--muted'">{{ adultEnabled ? '启用' : '停用' }}</span></div>
        <div class="setting-row">
          <span class="setting-copy"><strong>菜单状态</strong><span>停用后 C 端不再显示成人入口。</span></span>
          <label class="switch"><input v-model="adultEnabled" type="checkbox" /><span>启用</span></label>
        </div>
        <div class="form-grid" style="margin-top: 16px">
          <div class="field"><label>中文标签</label><input v-model="adultZh" maxlength="20" /></div>
          <div class="field"><label>英文标签</label><input v-model="adultEn" maxlength="20" /></div>
        </div>
        <button class="btn btn--primary" style="margin-top: 20px" type="button" :disabled="savingAdult" @click="saveAdultMenu">
          {{ savingAdult ? '保存中' : '保存设置' }}
        </button>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>成人内容统计</h3><span class="meta">{{ payload.stats?.total ?? 0 }} 部</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>内容</th><th>状态</th><th>收藏</th><th>今日浏览</th><th>总浏览</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.stats?.list" :key="row.dramaId">
                <td>{{ row.title }}</td>
                <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
                <td>{{ row.favoriteCount ?? 0 }}</td><td>{{ row.todayViews ?? 0 }}</td><td>{{ row.totalViews ?? 0 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'tags'">
    <div class="panel">
      <div class="panel-head"><h3>标签</h3><span class="meta">共 {{ payload.total ?? 0 }} 个</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>名称</th><th>范围</th><th>层级</th><th>剧集数</th><th>排序</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.name }}</td><td>{{ row.scope === 'adult' ? '成人' : '普通' }}</td>
              <td>{{ row.parent_id ? '二级' : '一级' }}</td><td>{{ row.dramaCount ?? 0 }}</td>
              <td>{{ row.sort }}</td><td><span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--muted'">{{ row.status === 'active' ? '启用' : '停用' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'ranks'">
    <div v-for="list in payload.list" :key="list.id" class="panel">
      <div class="panel-head"><h3>{{ list.name }}</h3><span class="meta">{{ list.type }} · {{ list.items?.length ?? 0 }} 条</span></div>
      <div class="rank-list">
        <div v-for="item in list.items" :key="item.id" class="rank-row" style="grid-template-columns: 48px 1fr auto">
          <span class="rank-no">{{ String(item.rank_no).padStart(2, '0') }}</span>
          <span class="rank-main"><strong>{{ item.title }}</strong><span>内容 #{{ item.drama_id }}</span></span>
          <span class="badge badge--muted">#{{ item.drama_id }}</span>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'moderation'">
    <div class="panel">
      <div class="panel-head"><h3>待审弹幕</h3><span class="meta">{{ payload.danmus?.total ?? 0 }} 条</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>剧集</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.danmus?.list" :key="row.id">
              <td>{{ row.id }}</td><td>{{ row.title }}</td><td>{{ row.content }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
              <td class="row-actions">
                <button class="btn btn--quiet btn--sm" type="button" @click="review('danmus', row, 'approve')">通过</button>
                <button class="btn btn--quiet btn--sm" type="button" @click="review('danmus', row, 'reject')">驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>待审评论</h3><span class="meta">{{ payload.comments?.total ?? 0 }} 条</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>剧集</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.comments?.list" :key="row.id">
              <td>{{ row.id }}</td><td>{{ row.title }}</td><td>{{ row.content }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
              <td class="row-actions">
                <button class="btn btn--quiet btn--sm" type="button" @click="review('comments', row, 'approve')">通过</button>
                <button class="btn btn--quiet btn--sm" type="button" @click="review('comments', row, 'reject')">驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'content-stats'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">点击</span><strong class="v">{{ formatCount(payload.stats?.totals?.clickCount) }}</strong><span class="d">人数 {{ payload.stats?.totals?.clickUv ?? 0 }}</span></div>
      <div class="kpi"><span class="k">有效观看</span><strong class="v">{{ formatCount(payload.stats?.totals?.viewCount) }}</strong><span class="d">人数 {{ payload.stats?.totals?.viewerCount ?? 0 }}</span></div>
      <div class="kpi"><span class="k">完播率</span><strong class="v">{{ ((payload.stats?.totals?.completionRate ?? 0) * 100).toFixed(1) }}<small>%</small></strong><span class="d">服务端口径</span></div>
      <div class="kpi"><span class="k">当前收藏</span><strong class="v">{{ formatCount(payload.stats?.totals?.favoriteCount) }}</strong><span class="d">个</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>内容表现</h3><span class="meta">近 7 天</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>内容</th><th>点击</th><th>观看</th><th>人数</th><th>完播率</th><th>当前收藏</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.stats?.rows" :key="row.contentId">
              <td>{{ row.title }}<span class="meta"> #{{ row.contentId }}</span></td>
              <td>{{ row.clickCount }}</td><td>{{ row.viewCount }}</td><td>{{ row.viewerCount }}</td>
              <td>{{ ((row.completionRate ?? 0) * 100).toFixed(1) }}%</td><td>{{ row.favoriteCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'plans'">
    <div class="plan-grid" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))">
      <div v-for="plan in payload.list" :key="plan.id" class="plan">
        <strong>{{ plan.name }}</strong>
        <span>{{ plan.description }}</span>
        <b>{{ formatMoney(plan.price_cny) }} / {{ plan.duration_days }} 天</b>
        <span class="badge" :class="plan.status === 'active' ? 'badge--ok' : 'badge--muted'">{{ plan.status === 'active' ? '在售' : '下架' }}</span>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'coupons'">
    <div class="panel">
      <div class="panel-head"><h3>优惠券</h3><span class="meta">{{ payload.list?.length ?? 0 }} 张</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>券码</th><th>名称</th><th>类型</th><th>面额</th><th>门槛</th><th>使用</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td class="mono">{{ row.code }}</td><td>{{ row.name }}</td>
              <td>{{ row.discount_type === 'amount' ? '立减' : '折扣' }}</td>
              <td>{{ row.discount_type === 'amount' ? formatMoney(row.discount_value) : `${row.discount_value}%` }}</td>
              <td>{{ formatMoney(row.min_amount) }}</td><td>{{ row.used }}/{{ row.total || '不限' }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'orders'">
    <div class="panel">
      <div class="panel-head"><h3>订单</h3><span class="meta">共 {{ payload.total ?? 0 }} 笔</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>单号</th><th>用户</th><th>商品</th><th>金额</th><th>渠道</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td class="mono">{{ row.out_trade_no }}</td>
              <td>{{ row.nickname || row.email || '—' }}</td>
              <td>{{ row.product_type === 'subscription' ? `会员 · ${row.plan_name || ''}` : `单片 · ${row.drama_title || ''}` }}</td>
              <td>{{ formatMoney(row.amount_cny) }}</td><td>{{ row.channel }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
              <td>{{ formatDateTime(row.paid_at || row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'refunds'">
    <div class="panel">
      <div class="panel-head"><h3>退款审核</h3><span class="meta">共 {{ payload.total ?? 0 }} 笔</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>单号</th><th>用户</th><th>金额</th><th>原因</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.id }}</td><td class="mono">{{ row.out_trade_no }}</td>
              <td>{{ row.nickname || '—' }}</td><td>{{ formatMoney(row.amount_cny) }}</td>
              <td>{{ row.reason }}</td>
              <td><span class="badge" :class="statusClass(row.status)">{{ STATUS_LABEL[row.status] || row.status }}</span></td>
              <td class="row-actions">
                <button v-if="row.status === 'pending'" class="btn btn--quiet btn--sm" type="button" @click="approveRefund(row)">通过</button>
                <button v-if="row.status === 'pending'" class="btn btn--quiet btn--sm" type="button" @click="rejectRefund(row)">驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'distribution'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">邀请点击</span><strong class="v">{{ formatCount(payload.dashboard?.summary?.inviteClicks) }}</strong><span class="d">访客 {{ payload.dashboard?.summary?.inviteVisitors ?? 0 }}</span></div>
      <div class="kpi"><span class="k">有效邀请</span><strong class="v">{{ formatCount(payload.dashboard?.summary?.invites) }}</strong><span class="d">覆盖 {{ payload.dashboard?.summary?.invitees ?? 0 }} 人</span></div>
      <div class="kpi"><span class="k">佣金总额</span><strong class="v">{{ formatMoney(Number(payload.dashboard?.summary?.commissionTotalFen ?? 0) / 100) }}</strong><span class="d">已结算 {{ formatMoney(Number(payload.dashboard?.summary?.commissionSettledFen ?? 0) / 100) }}</span></div>
      <div class="kpi"><span class="k">推广员</span><strong class="v">{{ formatCount(payload.dashboard?.summary?.activeDistributors) }}</strong><span class="d">待审 {{ payload.dashboard?.summary?.pendingDistributors ?? 0 }}</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>推广员汇总</h3><span class="meta">近 30 天</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>用户</th><th>直邀</th><th>团队</th><th>支付订单</th><th>支付金额</th><th>净佣金</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.overview?.rows" :key="row.distributorUserId">
              <td>{{ row.nickname || row.email || `#${row.distributorUserId}` }}</td>
              <td>{{ row.directInvitees }}</td><td>{{ row.teamSize }}</td>
              <td>{{ row.paidOrders }}</td><td>{{ formatMoney(row.paidAmount) }}</td>
              <td>{{ formatMoney(Number(row.netCommissionFen ?? 0) / 100) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'distribution-config'">
    <div class="panel">
      <div class="panel-head"><h3>基础规则</h3><span class="meta">服务端配置</span></div>
      <div class="detail-facts" style="border: 0; padding: 0">
        <span><strong>状态</strong> {{ payload.config?.status === 'disabled' ? '停用' : '启用' }}</span>
        <span><strong>启用级数</strong> {{ payload.config?.max_enabled_level ?? '—' }}</span>
        <span><strong>总比例上限</strong> {{ (Number(payload.config?.max_total_rate_bp ?? 0) / 100).toFixed(2) }}%</span>
        <span><strong>冻结期</strong> {{ payload.config?.freeze_days ?? '—' }} 天</span>
        <span><strong>最低结算</strong> {{ formatMoney(Number(payload.config?.min_settlement_fen ?? 0) / 100) }}</span>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>佣金规则</h3><span class="meta">{{ payload.rules?.length ?? 0 }} 条</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>层级</th><th>编码</th><th>比例</th><th>范围</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.rules" :key="row.id">
              <td>{{ row.relation_level }} 级</td><td>{{ row.rule_code }}</td>
              <td>{{ (Number(row.rate_bp ?? 0) / 100).toFixed(2) }}%</td>
              <td>{{ row.scope_type }} {{ row.scope_value || '' }}</td>
              <td>{{ row.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'users'">
    <div class="panel">
      <div class="panel-head"><h3>C 端用户</h3><span class="meta">共 {{ payload.total ?? 0 }} 人</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>邮箱</th><th>昵称</th><th>状态</th><th>会员到期</th><th>订单</th><th>累计付费</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.id }}</td><td>{{ row.email || row.phone || '—' }}</td>
              <td>{{ row.nickname }}</td>
              <td><span class="badge" :class="row.status === 'active' ? 'badge--ok' : 'badge--bad'">{{ row.status === 'active' ? '正常' : '已禁用' }}</span></td>
              <td>{{ formatDate(row.vip_until) }}</td><td>{{ row.order_count }}</td>
              <td>{{ formatMoney(row.paid_total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'menus'">
    <div v-for="group in payload.groups" :key="group.key" class="panel">
      <div class="panel-head"><h3>{{ group.label }}</h3><span class="meta">{{ group.items?.length ?? 0 }} 项</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>菜单</th><th>路由</th><th>权限</th><th>排序</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="item in group.items" :key="item.id">
              <td>{{ item.label }}</td><td class="mono">{{ item.route }}</td>
              <td class="mono">{{ item.permCode || '登录可见' }}</td>
              <td>{{ item.sort }}</td>
              <td><span class="badge" :class="item.visible ? 'badge--ok' : 'badge--muted'">{{ item.visible ? '显示' : '隐藏' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'roles'">
    <div class="admin-grid">
      <div class="panel">
        <div class="panel-head"><h3>角色</h3><span class="meta">{{ payload.roles?.length ?? 0 }} 个</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>角色</th><th>编码</th><th>权限</th><th>类型</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.roles" :key="row.id">
                <td>{{ row.name }}</td><td class="mono">{{ row.code }}</td>
                <td>{{ row.permissions?.length ?? 0 }}</td><td>{{ row.is_system ? '内置' : '自定义' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>后台账号</h3><span class="meta">{{ payload.admins?.length ?? 0 }} 个</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>账号</th><th>角色</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="row in payload.admins" :key="row.id">
                <td>{{ row.username }}</td>
                <td>{{ (row.roles || []).map((role) => role.name).join(' / ') }}</td>
                <td>{{ row.status }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'admin-users'">
    <div class="panel">
      <div class="panel-head"><h3>后台账号</h3><span class="meta">{{ payload.list?.length ?? 0 }} 个</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>账号</th><th>显示名</th><th>角色</th><th>状态</th><th>最近操作</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.id }}</td><td>{{ row.username }}</td><td>{{ row.display_name || '—' }}</td>
              <td>{{ (row.roles || []).map((role) => role.name).join(' / ') || '未分配' }}</td>
              <td>{{ row.status }}<span v-if="row.mustChangePassword" class="badge badge--warn">待改密</span></td>
              <td>{{ formatDateTime(row.lastAuditAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'audit'">
    <div class="panel">
      <div class="panel-head"><h3>审计日志</h3><span class="meta">共 {{ payload.total ?? 0 }} 条</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th><th>IP</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ formatDateTime(row.created_at) }}</td>
              <td>{{ row.actor_name || row.actor_type }}</td><td class="mono">{{ row.action }}</td>
              <td>{{ row.target_type }}{{ row.target_id ? ` #${row.target_id}` : '' }}</td>
              <td><span class="badge" :class="row.result === 'denied' ? 'badge--bad' : 'badge--ok'">{{ row.result === 'denied' ? '拒绝' : '成功' }}</span></td>
              <td class="mono">{{ row.ip || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'pay'">
    <div class="panel">
      <div class="panel-head"><h3>支付渠道</h3><span class="meta">密钥版本 v{{ payload.keyVersion ?? '—' }}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>编码</th><th>名称</th><th>场景</th><th>环境</th><th>状态</th><th>默认</th><th>币种</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.list" :key="row.id">
              <td>{{ row.id }}</td><td>{{ row.channel_code }}</td><td>{{ row.name }}</td>
              <td>{{ row.scene }}</td><td>{{ row.env }}</td>
              <td><span class="badge" :class="row.status === 'enabled' ? 'badge--ok' : 'badge--muted'">{{ row.status === 'enabled' ? '启用' : '停用' }}</span></td>
              <td>{{ row.is_default ? '默认' : '—' }}</td><td>{{ row.currency }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>

  <template v-else-if="key === 'mail'">
    <div class="kpi-grid">
      <div class="kpi"><span class="k">发信状态</span><strong class="v" style="font-size: 18px">{{ payload.mailMissing ? '未配置' : '可用' }}</strong><span class="d">{{ payload.mailMissing ? '验证码无法发送' : '至少一条通道可用' }}</span></div>
      <div class="kpi"><span class="k">通道数</span><strong class="v">{{ payload.channels?.length ?? 0 }}</strong><span class="d">按优先级回退</span></div>
      <div class="kpi"><span class="k">默认发件人</span><strong class="v" style="font-size: 16px">{{ payload.from || '未设置' }}</strong><span class="d">{{ payload.fromName || '影巢' }}</span></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>邮件通道</h3><span class="meta">服务端配置</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>优先级</th><th>名称</th><th>类型</th><th>发件人 / 端点</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="row in payload.channels" :key="row.id">
              <td>{{ row.priority }}</td><td>{{ row.name }}</td><td>{{ row.type }}</td>
              <td>{{ row.from || row.smtp?.host || row.http?.url || '—' }}</td>
              <td><span class="badge" :class="row.enabled === false ? 'badge--muted' : row.lastTest?.ok ? 'badge--ok' : 'badge--warn'">{{ row.enabled === false ? '停用' : row.lastTest?.ok ? '可用' : '未测试' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
