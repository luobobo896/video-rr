import { createApp } from 'vue';
import AdminApp from './AdminApp.vue';
import { initI18n } from './i18n.js';
import './styles.css';

initI18n();
createApp(AdminApp).mount('#app');
