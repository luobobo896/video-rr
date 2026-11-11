import { reactive } from 'vue'
import { getLang } from './i18n.js'

export const chromeState = reactive({
  user: null,
  lang: getLang(),
  hash: location.hash || '#/home',
  adultMenu: null,
  actions: {},
})

export function syncChrome({ user, lang, hash, adultMenu }) {
  chromeState.user = user ?? null
  chromeState.lang = lang
  chromeState.hash = hash
  chromeState.adultMenu = adultMenu ?? null
}

export function bindChromeActions(actions) {
  chromeState.actions = actions
}
