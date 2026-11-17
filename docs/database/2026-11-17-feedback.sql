-- 投诉反馈：C 端提交 → B 端受理/回复 → 关联订单退款。
-- 由 server/db.mjs 的 ensureFeedbackSchema() 幂等建表，这里留一份可审阅的 DDL。

CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT UNIQUE,                                 -- FB + 北京日期 + 4 位序号，INSERT 后同事务回填
  user_id INTEGER,                                       -- 登录用户；匿名为 NULL
  visitor_id TEXT,                                       -- 匿名访客标识，用于串起同一人的多次提交
  order_id INTEGER,                                      -- 关联订单（可选）
  drama_id INTEGER,                                      -- 关联剧目（可选）
  category TEXT NOT NULL DEFAULT 'other',                -- playback|payment|account|content|report|suggestion|other
  content TEXT NOT NULL,                                  -- 5–2000 字
  contact TEXT,                                          -- 匿名必填，回复靠它送到人
  source TEXT NOT NULL DEFAULT 'web',
  status TEXT NOT NULL DEFAULT 'pending',                -- pending|processing|replied|resolved|closed
  priority INTEGER NOT NULL DEFAULT 0,                   -- payment/report=2、playback/account=1、其余 0
  reply TEXT,
  replied_by INTEGER,
  replied_at TEXT,
  refund_id INTEGER,                                     -- 从本工单发起的退款单
  admin_note TEXT,                                       -- 处理备注，按时间追加
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_order ON feedbacks(order_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
