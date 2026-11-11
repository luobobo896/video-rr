(function () {
  var path = location.pathname.replace(/\/index\.html$/, '')
  if (/\/$/.test(path)) path = path.slice(0, -1)
  window.__MH_BASE = /^\/(video|video-admin)$/.test(path) ? path : ''
})()
