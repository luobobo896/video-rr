import { createApp } from 'vue'
import LegacyHost from './LegacyHost.vue'

createApp(LegacyHost).mount('#vue-root')
await import('./app.js')
