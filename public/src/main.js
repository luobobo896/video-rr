import { createApp } from 'vue';
import App from './App.vue';
import { initI18n } from './i18n.js';
// 令牌唯一来源：shared/tokens.css 由 scripts/sync-tokens.mjs 生成 public/tokens.css，
// 必须先于样式表加载，styles.css 里的别名（--ink-*、--h-*、--r-* …）才有值。
import '../tokens.css';
import './styles.css';

initI18n();
createApp(App).mount('#app');
