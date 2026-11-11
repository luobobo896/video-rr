const ACTION_LABEL = {
  login: '登录',
  change_password: '修改密码',
  change_email: '更换邮箱',
  password_reset: '密码重置',
}

export const DEFAULT_CODE_TEMPLATE = {
  brand: '影巢',
  subject: '{{brand}} · {{action}}验证码',
  title: '{{action}}验证码',
  intro: '请在 {{minutes}} 分钟内输入以下验证码。验证码仅可使用一次。',
  footer: '如非本人操作，请忽略本邮件。',
  accent: '#ff3d6e',
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]))

export function normalizeCodeTemplate(input = {}) {
  const accent = /^#[0-9a-f]{6}$/i.test(String(input.accent ?? '')) ? input.accent : DEFAULT_CODE_TEMPLATE.accent
  return {
    brand: String(input.brand ?? DEFAULT_CODE_TEMPLATE.brand).trim().slice(0, 30) || DEFAULT_CODE_TEMPLATE.brand,
    subject: String(input.subject ?? DEFAULT_CODE_TEMPLATE.subject).trim().slice(0, 100) || DEFAULT_CODE_TEMPLATE.subject,
    title: String(input.title ?? DEFAULT_CODE_TEMPLATE.title).trim().slice(0, 80) || DEFAULT_CODE_TEMPLATE.title,
    intro: String(input.intro ?? DEFAULT_CODE_TEMPLATE.intro).trim().slice(0, 300) || DEFAULT_CODE_TEMPLATE.intro,
    footer: String(input.footer ?? DEFAULT_CODE_TEMPLATE.footer).trim().slice(0, 300) || DEFAULT_CODE_TEMPLATE.footer,
    accent,
  }
}

const render = (template, vars) => String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ''))

export function buildCodeEmail({ to, code, purpose = 'login', expiresIn = 300, attempts = 3, template } = {}) {
  const tpl = normalizeCodeTemplate(template)
  const vars = {
    brand: tpl.brand,
    action: ACTION_LABEL[purpose] ?? '验证',
    code,
    minutes: Math.max(1, Math.round(Number(expiresIn) / 60)),
    attempts,
    email: to ?? '',
    year: new Date().getFullYear(),
  }
  const subject = render(tpl.subject, vars)
  const title = render(tpl.title, vars)
  const intro = render(tpl.intro, vars)
  const footer = render(tpl.footer, vars)
  const plainCode = String(code ?? '')
  const text = [`${title}`, '', intro, '', plainCode, '', footer, '', `—— ${vars.brand}`].join('\r\n')
  const html = `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:0;background:#f3f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f2430">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f7;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e8ef;border-radius:16px;overflow:hidden">
        <tr><td style="height:5px;background:${escapeHtml(tpl.accent)}"></td></tr>
        <tr><td style="padding:32px 34px 10px">
          <div style="font-size:14px;font-weight:700;letter-spacing:.08em;color:${escapeHtml(tpl.accent)}">${escapeHtml(vars.brand)}</div>
          <h1 style="margin:14px 0 0;font-size:26px;line-height:1.3;font-weight:700;color:#171a21">${escapeHtml(title)}</h1>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.75;color:#687083">${escapeHtml(intro)}</p>
        </td></tr>
        <tr><td style="padding:20px 34px 8px">
          <div style="padding:22px 18px;text-align:center;background:#f8f9fc;border:1px solid #e8eaf0;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:38px;font-weight:700;letter-spacing:.22em;color:${escapeHtml(tpl.accent)};white-space:nowrap">${escapeHtml(plainCode)}</div>
        </td></tr>
        <tr><td style="padding:8px 34px 30px">
          <p style="margin:0;font-size:13px;line-height:1.7;color:#8a91a1">${escapeHtml(footer)}</p>
        </td></tr>
        <tr><td style="padding:18px 34px;background:#fafbfe;border-top:1px solid #eceef4;font-size:12px;color:#9aa0ad">
          © ${vars.year} ${escapeHtml(vars.brand)} · 此邮件由系统自动发送
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  return { subject, text, html }
}

export function buildPasswordResetEmail({ to, password, template } = {}) {
  const tpl = normalizeCodeTemplate(template)
  const brand = tpl.brand
  const subject = `${brand} · 密码已重置`
  const text = [
    '您好，', '',
    `管理员已为您的 ${brand} 账号重置密码。`, '',
    `临时密码：${password}`, '',
    '请使用临时密码登录，并尽快在个人中心修改密码。',
    '如非本人申请，请联系客服。', '', `—— ${brand}`,
  ].join('\r\n')
  const html = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#f3f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f2430">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f7;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #e6e8ef;border-radius:16px;overflow:hidden">
      <tr><td style="height:5px;background:${escapeHtml(tpl.accent)}"></td></tr>
      <tr><td style="padding:32px 34px 8px">
        <div style="font-size:14px;font-weight:700;letter-spacing:.08em;color:${escapeHtml(tpl.accent)}">${escapeHtml(brand)}</div>
        <h1 style="margin:14px 0 0;font-size:26px;line-height:1.3">密码已重置</h1>
        <p style="margin:14px 0 0;font-size:15px;line-height:1.75;color:#687083">管理员已为您的账号生成临时密码。</p>
      </td></tr>
      <tr><td style="padding:18px 34px 8px">
        <div style="padding:20px 16px;text-align:center;background:#f8f9fc;border:1px solid #e8eaf0;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:.08em;color:${escapeHtml(tpl.accent)};word-break:break-all">${escapeHtml(password)}</div>
      </td></tr>
      <tr><td style="padding:10px 34px 28px"><p style="margin:0;font-size:13px;line-height:1.7;color:#8a91a1">请使用临时密码登录，并尽快在个人中心修改密码。如非本人申请，请联系客服。</p></td></tr>
      <tr><td style="padding:16px 34px;background:#fafbfe;border-top:1px solid #eceef4;font-size:12px;color:#9aa0ad">${escapeHtml(to)} · © ${new Date().getFullYear()} ${escapeHtml(brand)}</td></tr>
    </table>
  </td></tr></table>
</body></html>`
  return { subject, text, html }
}
