<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { parseRetryAfter, retryAfterOf } from '../retry-after.js';

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  title: { type: String, default: '' }
});

const emit = defineEmits(['timeupdate', 'ended', 'play', 'pause', 'failed']);
const video = ref(null);
const status = ref('');
const captionSrc = ref('');
let hls = null;
let attachSeq = 0;
let retryTimer = 0;
let autoRetries = 0;

// 外部片源是「有保鲜期的票」：过期后网关回 503 + Retry-After。
// 这时候不该把播放键留给用户对着发呆，按网关给的秒数自动重试几次。
function scheduleRetry(seconds, hint) {
  const wait = parseRetryAfter(seconds);
  if (autoRetries >= 3) {
    status.value = `${hint}，请稍后手动重试`;
    emit('failed', { status: status.value });
    return;
  }
  autoRetries += 1;
  status.value = `${hint}，${wait} 秒后自动重试（第 ${autoRetries}/3 次）`;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    void attach();
  }, wait * 1000);
}

/** 换集 = 新的一次播放机会：重试计数与待触发的重试定时器都要清掉 */
function resetRetries() {
  autoRetries = 0;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
}

async function attach() {
  const seq = ++attachSeq;
  const element = video.value;
  if (!element) return;
  window.clearTimeout(retryTimer);
  hls?.destroy();
  hls = null;
  element.removeAttribute('src');
  element.load();
  status.value = '';
  if (!props.src) {
    status.value = '该集片源暂不可用';
    return;
  }
  // 直链文件源（mp4/webm…）不是 HLS：原生播，hls.js 只会解析失败
  if (/\.(mp4|m4v|webm|mkv|mov|ogv)(\?|$)/i.test(props.src)) {
    element.src = props.src;
    return;
  }
  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = props.src;
    return;
  }
  try {
    const module = await import(
      /* @vite-ignore */ new URL('vendor/hls.mjs', document.baseURI).href
    );
    if (seq !== attachSeq) return;
    const Hls = module.default ?? module.Hls;
    if (!Hls?.isSupported?.()) {
      element.src = props.src;
      return;
    }
    // 外部片源经香港服务器回源，单段要一秒上下：缓冲给足、重试放宽，
    // 宁可多等一会也不要因为一次抖动就整片停住
    hls = new Hls({
      lowLatencyMode: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 60 * 1000 * 1000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 800,
      fragLoadingMaxRetryTimeout: 20000,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6
    });
    hls.loadSource(props.src);
    hls.attachMedia(element);
    hls.on(Hls.Events.ERROR, (_event, payload) => {
      if (!payload.fatal) return;
      // 503 = 片源签名过期、服务端正在续期：这是临时的，等一下再来
      if (Number(payload.response?.code) === 503) {
        scheduleRetry(retryAfterOf(payload), '片源正在续期');
        return;
      }
      status.value = '播放异常，请重试或切换集数';
      emit('failed', { status: status.value });
    });
  } catch {
    status.value = '播放器加载失败，请刷新页面';
  }
}

watch(
  () => props.src,
  () => {
    // 换集先清零再挂载，否则上一集用完的 3 次重试会带过来（新集直接不给重试）
    resetRetries();
    void attach();
  },
  { flush: 'post' }
);
onMounted(attach);

/** 真的播起来了就把自动重试计数清零，下次抖动还有三次机会 */
function onPlaying() {
  autoRetries = 0;
  status.value = '';
}

/** 原生播放（mp4 直链 / Safari 原生 HLS）拿不到 hls.js 的错误细节，只能给通用提示 */
function onElementError() {
  if (hls || !props.src) return;
  status.value = '片源加载失败，请稍后重试';
  emit('failed', { status: status.value });
}

/**
 * WCAG 1.2.2（A 级）要求 prerecorded video 有字幕轨道。
 * 片源侧目前没有字幕文件，这里挂一条空的 WebVTT 轨道（走 blob: 以适配 CSP media-src），
 * 同时给读屏用户一句说明，等字幕源接入后替换 src 即可。
 */
onMounted(() => {
  try {
    const vtt = 'WEBVTT\n\nNOTE 该片源暂未提供字幕\n';
    captionSrc.value = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  } catch {
    captionSrc.value = '';
  }
});

onBeforeUnmount(() => {
  attachSeq += 1;
  window.clearTimeout(retryTimer);
  hls?.destroy();
  hls = null;
  if (captionSrc.value) URL.revokeObjectURL(captionSrc.value);
  captionSrc.value = '';
});
</script>

<template>
  <div class="player">
    <video
      ref="video"
      class="video-el"
      controls
      playsinline
      preload="metadata"
      :poster="poster"
      :aria-label="title"
      @timeupdate="$emit('timeupdate', $event)"
      @ended="$emit('ended', $event)"
      @play="$emit('play', $event)"
      @pause="$emit('pause', $event)"
      @playing="onPlaying"
      @error="onElementError"
    >
      <track v-if="captionSrc" kind="captions" srclang="zh" label="中文字幕" :src="captionSrc" default />
    </video>
    <p v-if="status" class="player-notice">{{ status }}</p>
    <p class="sr-only">该片源暂未提供字幕，如需无障碍观看请联系客服。</p>
  </div>
</template>
