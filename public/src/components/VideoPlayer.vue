<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  title: { type: String, default: '' }
});

const emit = defineEmits(['timeupdate', 'ended', 'play', 'pause']);
const video = ref(null);
const status = ref('');
let hls = null;
let attachSeq = 0;

async function attach() {
  const seq = ++attachSeq;
  const element = video.value;
  if (!element) return;
  hls?.destroy();
  hls = null;
  element.removeAttribute('src');
  element.load();
  status.value = '';
  if (!props.src) {
    status.value = '该集片源暂不可用';
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
      if (payload.fatal) status.value = '播放异常，请重试或切换集数';
    });
  } catch {
    status.value = '播放器加载失败，请刷新页面';
  }
}

watch(() => props.src, attach, { flush: 'post' });
onMounted(attach);

onBeforeUnmount(() => {
  attachSeq += 1;
  hls?.destroy();
  hls = null;
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
    ></video>
    <p v-if="status" class="player-notice">{{ status }}</p>
  </div>
</template>
