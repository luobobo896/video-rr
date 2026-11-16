import { computed, onBeforeUnmount, ref } from 'vue';
import { createCountdown } from './countdown.js';

/**
 * 验证码倒计时 composable：重复发送先清旧 timer，组件卸载一定清理，
 * 避免「重开对话框后两个 interval 同时改同一个 ref」导致的跳变。
 */
export function useCountdown(defaultSeconds = 60) {
  const remaining = ref(0);
  const countdown = createCountdown();
  const unsubscribe = countdown.subscribe((value) => {
    remaining.value = value;
  });

  onBeforeUnmount(() => {
    countdown.stop();
    unsubscribe();
  });

  const start = (seconds = defaultSeconds) => countdown.start(seconds);
  const stop = () => {
    countdown.stop();
    remaining.value = 0;
  };

  return { remaining, running: computed(() => remaining.value > 0), start, stop };
}
