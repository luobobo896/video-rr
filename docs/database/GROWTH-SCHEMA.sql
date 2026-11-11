-- 影巢增长域 Schema（SQLite 参考脚本）
-- 运行入口：server/db.mjs -> ensureGrowthSchema()
-- 该脚本与运行时代码保持同一字段口径；生产升级由代码内幂等迁移执行。

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_code TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'paid_ad',
  status TEXT NOT NULL DEFAULT 'active',
  owner_name TEXT,
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS channel_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  campaign_code TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  external_campaign_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  start_at TEXT,
  end_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (channel_id, campaign_code)
);

CREATE TABLE IF NOT EXISTS channel_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES channel_campaigns(id) ON DELETE SET NULL,
  host TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (host, path_prefix)
);
CREATE INDEX IF NOT EXISTS idx_channel_domains_lookup ON channel_domains(host, status);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES channel_campaigns(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL DEFAULT 'acquisition',
  distributor_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_promo_codes_lookup ON promo_codes(code, purpose, status);

CREATE TABLE IF NOT EXISTS channel_touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT,
  user_id INTEGER,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  campaign_id INTEGER REFERENCES channel_campaigns(id) ON DELETE SET NULL,
  promo_code TEXT,
  channel_type TEXT NOT NULL,
  domain_source TEXT,
  landing_url TEXT,
  referrer_url TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  match_rule TEXT NOT NULL DEFAULT 'direct',
  is_valid INTEGER NOT NULL DEFAULT 1,
  reject_reason TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_touches_visitor ON channel_touches(visitor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_touches_channel ON channel_touches(channel_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_touches_campaign ON channel_touches(campaign_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_touches_promo ON channel_touches(promo_code, occurred_at DESC);

CREATE TABLE IF NOT EXISTS channel_daily_spend (
  stat_date TEXT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  campaign_id INTEGER REFERENCES channel_campaigns(id) ON DELETE SET NULL,
  spend_fen INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (stat_date, channel_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS user_acquisitions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_channel_id INTEGER NOT NULL REFERENCES channels(id),
  first_campaign_id INTEGER REFERENCES channel_campaigns(id) ON DELETE SET NULL,
  first_promo_code TEXT,
  first_domain_source TEXT,
  first_enter_at TEXT NOT NULL,
  attributed_at TEXT NOT NULL,
  attribution_model TEXT NOT NULL DEFAULT 'first_touch',
  attribution_touch_id INTEGER REFERENCES channel_touches(id) ON DELETE SET NULL,
  last_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  last_touch_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_acquisitions_channel ON user_acquisitions(first_channel_id, attributed_at DESC);

-- 老库补列
ALTER TABLE visitors ADD COLUMN first_channel_id INTEGER;
ALTER TABLE visitors ADD COLUMN first_campaign_id INTEGER;
ALTER TABLE visitors ADD COLUMN first_promo_code TEXT;
ALTER TABLE visitors ADD COLUMN first_domain_source TEXT;
ALTER TABLE visitors ADD COLUMN first_enter_at TEXT;
ALTER TABLE visitors ADD COLUMN attributed_at TEXT;
ALTER TABLE visitors ADD COLUMN attribution_model TEXT;
ALTER TABLE visitors ADD COLUMN first_channel_touch_id INTEGER;
ALTER TABLE visitors ADD COLUMN last_channel_id INTEGER;
ALTER TABLE visitors ADD COLUMN last_touch_at TEXT;

ALTER TABLE orders ADD COLUMN acquisition_channel_id INTEGER;
ALTER TABLE orders ADD COLUMN acquisition_channel_type TEXT;
ALTER TABLE orders ADD COLUMN acquisition_campaign_id INTEGER;
ALTER TABLE orders ADD COLUMN promo_code TEXT;
ALTER TABLE orders ADD COLUMN domain_source TEXT;
ALTER TABLE orders ADD COLUMN first_enter_at TEXT;
ALTER TABLE orders ADD COLUMN attributed_at TEXT;
ALTER TABLE orders ADD COLUMN attribution_model TEXT;
ALTER TABLE orders ADD COLUMN attribution_touch_id INTEGER;
ALTER TABLE orders ADD COLUMN attribution_snapshot_json TEXT;
ALTER TABLE orders ADD COLUMN attribution_status TEXT DEFAULT 'ok';
ALTER TABLE orders ADD COLUMN distributor_user_id INTEGER;
ALTER TABLE orders ADD COLUMN distribution_code TEXT;
ALTER TABLE orders ADD COLUMN distribution_relation_id INTEGER;
ALTER TABLE orders ADD COLUMN commission_base_fen INTEGER;
ALTER TABLE orders ADD COLUMN commission_total_fen INTEGER;
ALTER TABLE orders ADD COLUMN commission_record_count INTEGER;
ALTER TABLE orders ADD COLUMN commission_rule_snapshot_json TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_acquisition_channel ON orders(acquisition_channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_acquisition_paid ON orders(acquisition_channel_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_distributor ON orders(distributor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_attribution_status ON orders(attribution_status, created_at DESC);

ALTER TABLE dramas ADD COLUMN content_type TEXT;
ALTER TABLE dramas ADD COLUMN published_at TEXT;
CREATE INDEX IF NOT EXISTS idx_dramas_content_type ON dramas(content_type, status, published_at DESC);

CREATE TABLE IF NOT EXISTS content_click_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  viewer_key TEXT NOT NULL,
  user_id INTEGER,
  visitor_id TEXT,
  content_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_id INTEGER,
  entry_page TEXT,
  source_module TEXT,
  position INTEGER,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_ts TEXT,
  ip_hash TEXT,
  ua_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_clicks_content ON content_click_events(content_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_clicks_viewer ON content_click_events(viewer_key, content_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS content_view_sessions (
  id TEXT PRIMARY KEY,
  viewer_key TEXT NOT NULL,
  user_id INTEGER,
  visitor_id TEXT,
  content_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_id INTEGER,
  content_type TEXT,
  source TEXT NOT NULL DEFAULT 'play',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_seconds REAL,
  effective_seconds REAL NOT NULL DEFAULT 0,
  max_position_seconds REAL NOT NULL DEFAULT 0,
  playback_rate REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  is_valid INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  valid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_sessions_content ON content_view_sessions(content_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_sessions_viewer ON content_view_sessions(viewer_key, content_id, episode_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_sessions_valid ON content_view_sessions(is_valid, content_id, started_at DESC);

CREATE TABLE IF NOT EXISTS content_favorite_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_state INTEGER NOT NULL DEFAULT 0,
  to_state INTEGER NOT NULL DEFAULT 1,
  is_migration INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_favorites_content ON content_favorite_events(content_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_favorites_user ON content_favorite_events(user_id, content_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS content_stats_daily (
  stat_date TEXT NOT NULL,
  content_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  content_type TEXT,
  click_count INTEGER NOT NULL DEFAULT 0,
  click_uv INTEGER NOT NULL DEFAULT 0,
  play_request_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  viewer_count INTEGER NOT NULL DEFAULT 0,
  completion_count INTEGER NOT NULL DEFAULT 0,
  completion_rate REAL NOT NULL DEFAULT 0,
  favorite_add_count INTEGER NOT NULL DEFAULT 0,
  favorite_remove_count INTEGER NOT NULL DEFAULT 0,
  favorite_add_uv INTEGER NOT NULL DEFAULT 0,
  avg_watch_seconds REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (stat_date, content_id)
);
CREATE INDEX IF NOT EXISTS idx_content_stats_date ON content_stats_daily(stat_date, content_type);

CREATE TABLE IF NOT EXISTS content_stats_total (
  content_id INTEGER PRIMARY KEY REFERENCES dramas(id) ON DELETE CASCADE,
  lifetime_click_count INTEGER NOT NULL DEFAULT 0,
  lifetime_view_count INTEGER NOT NULL DEFAULT 0,
  lifetime_viewer_count INTEGER NOT NULL DEFAULT 0,
  current_favorite_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_rank_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rank_type TEXT NOT NULL,
  dimension_type TEXT NOT NULL DEFAULT 'all',
  dimension_value TEXT,
  window_start TEXT,
  window_end TEXT,
  strategy_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'running',
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS content_rank_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES content_rank_runs(id) ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  rank_no INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  metrics_json TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, content_id),
  UNIQUE (run_id, rank_no)
);
CREATE INDEX IF NOT EXISTS idx_content_rank_snapshots_run ON content_rank_snapshots(run_id, rank_no);

CREATE TABLE IF NOT EXISTS distribution_config (
  site_code TEXT PRIMARY KEY,
  max_enabled_level INTEGER NOT NULL DEFAULT 3,
  hard_max_level INTEGER NOT NULL DEFAULT 5,
  max_total_rate_bp INTEGER NOT NULL DEFAULT 1800,
  auto_approve INTEGER NOT NULL DEFAULT 1,
  attribution_window_days INTEGER NOT NULL DEFAULT 30,
  freeze_days INTEGER NOT NULL DEFAULT 7,
  min_settlement_fen INTEGER NOT NULL DEFAULT 10000,
  status TEXT NOT NULL DEFAULT 'active',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS distributor_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  available_balance_fen INTEGER NOT NULL DEFAULT 0,
  frozen_balance_fen INTEGER NOT NULL DEFAULT 0,
  settled_total_fen INTEGER NOT NULL DEFAULT 0,
  debt_fen INTEGER NOT NULL DEFAULT 0,
  debt_offset_fen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  distributor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_type TEXT NOT NULL DEFAULT 'link',
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_distributor ON referral_codes(distributor_user_id, status);

CREATE TABLE IF NOT EXISTS distribution_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  distributor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_id TEXT,
  user_id INTEGER,
  ip_hash TEXT,
  ua_hash TEXT,
  referrer_url TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_distribution_clicks_code ON distribution_clicks(code, occurred_at DESC);

CREATE TABLE IF NOT EXISTS distribution_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_user_id INTEGER NOT NULL REFERENCES users(id),
  invitee_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  relation_level INTEGER NOT NULL DEFAULT 1,
  source_code TEXT,
  source_click_id INTEGER REFERENCES distribution_clicks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  risk_status TEXT NOT NULL DEFAULT 'normal',
  bound_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_distribution_relations_inviter ON distribution_relations(inviter_user_id, bound_at DESC);

CREATE TABLE IF NOT EXISTS distribution_tree_closure (
  ancestor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  descendant_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ancestor_user_id, descendant_user_id)
);
CREATE INDEX IF NOT EXISTS idx_distribution_closure_ancestor ON distribution_tree_closure(ancestor_user_id, depth);
CREATE INDEX IF NOT EXISTS idx_distribution_closure_descendant ON distribution_tree_closure(descendant_user_id, depth);

CREATE TABLE IF NOT EXISTS commission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_value TEXT,
  relation_level INTEGER NOT NULL DEFAULT 1,
  rate_bp INTEGER NOT NULL DEFAULT 0,
  min_order_fen INTEGER NOT NULL DEFAULT 0,
  max_commission_fen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_match ON commission_rules(scope_type, relation_level, status, priority);

CREATE TABLE IF NOT EXISTS commission_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  distributor_user_id INTEGER NOT NULL REFERENCES users(id),
  invitee_user_id INTEGER NOT NULL REFERENCES users(id),
  source_relation_id INTEGER REFERENCES distribution_relations(id) ON DELETE SET NULL,
  commission_level INTEGER NOT NULL,
  order_amount_fen INTEGER NOT NULL,
  base_amount_fen INTEGER NOT NULL,
  rule_code TEXT,
  rate_bp INTEGER NOT NULL DEFAULT 0,
  rule_snapshot_json TEXT,
  commission_amount_fen INTEGER NOT NULL DEFAULT 0,
  reversed_fen INTEGER NOT NULL DEFAULT 0,
  settled_fen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'frozen',
  available_at TEXT,
  settlement_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE (order_id, distributor_user_id)
);
CREATE INDEX IF NOT EXISTS idx_commission_records_distributor ON commission_records(distributor_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_records_order ON commission_records(order_id, commission_level);

CREATE TABLE IF NOT EXISTS commission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commission_id INTEGER NOT NULL REFERENCES commission_records(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  amount_fen INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  operator_id INTEGER,
  reference_type TEXT,
  reference_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_events_commission ON commission_events(commission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commission_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  distributor_user_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_fen INTEGER NOT NULL DEFAULT 0,
  debt_offset_fen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_by INTEGER,
  reviewed_by INTEGER,
  payout_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commission_settlements_distributor ON commission_settlements(distributor_user_id, status, period_start);

CREATE TABLE IF NOT EXISTS commission_settlement_items (
  settlement_id INTEGER NOT NULL REFERENCES commission_settlements(id) ON DELETE CASCADE,
  commission_id INTEGER NOT NULL REFERENCES commission_records(id) ON DELETE CASCADE,
  amount_fen INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, commission_id)
);

INSERT OR IGNORE INTO channels (channel_code, channel_name, channel_type, status)
VALUES ('direct', '直接访问', 'direct', 'active');
INSERT OR IGNORE INTO channels (channel_code, channel_name, channel_type, status)
VALUES ('legacy_unattributed', '历史未归因', 'legacy_unattributed', 'active');
INSERT OR IGNORE INTO channels (channel_code, channel_name, channel_type, status)
VALUES ('distribution', '分销邀请', 'distribution', 'active');
INSERT OR IGNORE INTO distribution_config (site_code) VALUES ('default');
