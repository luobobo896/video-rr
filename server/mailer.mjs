/** 兼容层：发信统一走 mail-channels（通道化、厂家无关）。 */
export {
  PRESETS,
  channelList,
  emailSettings,
  isDevMail,
  markTest,
  newChannel,
  presetOf,
  removeChannel,
  saveEmailSettings,
  sendMail,
  upsertChannel,
  verifyChannel,
} from './mail-channels.mjs'
