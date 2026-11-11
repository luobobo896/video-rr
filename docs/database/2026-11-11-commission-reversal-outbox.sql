-- 退款成功后佣金冲减任务：与退款同事务入队，失败后台重试。
CREATE TABLE IF NOT EXISTS commission_reversal_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL UNIQUE REFERENCES refunds(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  total_refunded_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_commission_reversal_outbox_retry
  ON commission_reversal_outbox(status, next_retry_at);
