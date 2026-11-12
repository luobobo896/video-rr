import { createApp } from 'vue';
import App from './App.vue';
import { initI18n } from './i18n.js';
import './styles.css';

initI18n();
createApp(App).mount('#app');
