/**
 * 与框架无关的倒计时：每次 start 先清掉上一枚 timer，同一时刻最多一个 tick 在跑。
 * 组件侧用 useCountdown（会自动 onBeforeUnmount 清理），这里只做纯状态机，方便单测。
 */
export function createCountdown(options = {}) {
  const schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = options.clearInterval ?? ((id) => clearInterval(id));
  const listeners = new Set();
  let handle = null;
  let value = 0;

  function emit() {
    listeners.forEach((listener) => listener(value));
  }

  function stop() {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    return value;
  }

  function start(seconds = 60) {
    stop();
    value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value <= 0) {
      value = 0;
      emit();
      return value;
    }
    handle = schedule(() => {
      value = Math.max(0, value - 1);
      if (value === 0) stop();
      emit();
    }, 1000);
    emit();
    return value;
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(value);
    return () => listeners.delete(listener);
  }

  // 用 defineProperty 而不是对象字面量的 get 方法：仓库的 check-frontend 静态扫描器
  // 会把 `get running()` 误认成未声明的函数调用，这里保持纯数据访问器。
  const result = { start, stop, subscribe };
  Object.defineProperty(result, 'value', { enumerable: true, get: () => value });
  Object.defineProperty(result, 'running', { enumerable: true, get: () => handle !== null });
  return result;
}
