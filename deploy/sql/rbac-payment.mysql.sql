-- 影巢 · RBAC（RuoYi 风格，无部门）与多支付渠道表结构
-- 目标库：MySQL 8.0（utf8mb4_0900_ai_ci）。当前实现用 SQLite，字段语义一致；
-- 差异只在自增/JSON/索引写法，文末给出等价说明。

-- =====================================================================
-- 一、RBAC 三主体：用户、角色、菜单/权限
-- =====================================================================

DROP TABLE IF EXISTS sys_user_role, sys_role_menu, sys_menu, sys_role, sys_user;

CREATE TABLE sys_user (
  user_id        BIGINT       NOT NULL AUTO_INCREMENT COMMENT '管理员ID',
  username       VARCHAR(30)  NOT NULL COMMENT '登录账号',
  nickname       VARCHAR(30)  NOT NULL COMMENT '姓名/显示名',
  password       VARCHAR(100) NOT NULL COMMENT 'BCrypt 口令哈希',
  phonenumber    VARCHAR(11)  DEFAULT NULL,
  email          VARCHAR(50)  DEFAULT NULL,
  avatar         VARCHAR(255) DEFAULT NULL,
  status         CHAR(1)      NOT NULL DEFAULT '0' COMMENT '0正常 1停用',
  two_factor     TINYINT      NOT NULL DEFAULT 0 COMMENT '是否开启2FA',
  login_ip       VARCHAR(128) DEFAULT NULL,
  login_date     DATETIME     DEFAULT NULL,
  pwd_update_at  DATETIME     DEFAULT NULL COMMENT '口令更新时间（90天轮换）',
  del_flag       CHAR(1)      NOT NULL DEFAULT '0',
  create_by      VARCHAR(64)  DEFAULT '',
  create_time    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  update_time    DATETIME     DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  remark         VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (user_id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB COMMENT='管理端用户（无部门/岗位）';

CREATE TABLE sys_role (
  role_id     BIGINT      NOT NULL AUTO_INCREMENT,
  role_name   VARCHAR(30) NOT NULL,
  role_key    VARCHAR(100) NOT NULL COMMENT '角色标识 super_admin/content_ops/finance/cs/auditor/analyst',
  role_sort   INT         NOT NULL DEFAULT 0,
  data_scope  CHAR(1)     NOT NULL DEFAULT '1' COMMENT '1全部 2仅本人（无部门，故只保留两档）',
  status      CHAR(1)     NOT NULL DEFAULT '0' COMMENT '0正常 1停用',
  del_flag    CHAR(1)     NOT NULL DEFAULT '0',
  create_time DATETIME    DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME    DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  remark      VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (role_id),
  UNIQUE KEY uk_role_key (role_key)
) ENGINE=InnoDB COMMENT='角色';

CREATE TABLE sys_menu (
  menu_id     BIGINT      NOT NULL AUTO_INCREMENT,
  menu_name   VARCHAR(50) NOT NULL COMMENT '显示名',
  parent_id   BIGINT      NOT NULL DEFAULT 0 COMMENT '父节点，0=顶级',
  order_num   INT         NOT NULL DEFAULT 0 COMMENT '同级排序',
  path        VARCHAR(200) DEFAULT '' COMMENT '路由地址（目录/菜单）',
  component   VARCHAR(255) DEFAULT NULL COMMENT '前端组件路径',
  query       VARCHAR(255) DEFAULT NULL COMMENT '路由默认参数',
  is_frame    TINYINT     NOT NULL DEFAULT 1 COMMENT '0是外链 1否',
  is_cache    TINYINT     NOT NULL DEFAULT 0 COMMENT '0缓存 1不缓存',
  menu_type   CHAR(1)     NOT NULL COMMENT 'M目录 C菜单 F按钮',
  visible     CHAR(1)     NOT NULL DEFAULT '0' COMMENT '0显示 1隐藏',
  status      CHAR(1)     NOT NULL DEFAULT '0' COMMENT '0正常 1停用',
  perms       VARCHAR(200) DEFAULT NULL COMMENT '权限标识 content.drama.write',
  icon        VARCHAR(100) DEFAULT '#',
  ancestors   VARCHAR(500) DEFAULT '0' COMMENT '祖级路径 0,1,3（加速子树查询）',
  create_by   VARCHAR(64)  DEFAULT '',
  create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME     DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  remark      VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (menu_id),
  KEY idx_parent (parent_id),
  KEY idx_perms (perms),
  KEY idx_ancestors (ancestors)
) ENGINE=InnoDB COMMENT='菜单/权限（树形：目录→菜单→按钮）';

CREATE TABLE sys_role_menu (
  role_id BIGINT NOT NULL,
  menu_id BIGINT NOT NULL,
  PRIMARY KEY (role_id, menu_id),
  KEY idx_menu (menu_id)
) ENGINE=InnoDB COMMENT='角色-菜单（含目录/菜单/按钮节点）';

CREATE TABLE sys_user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id),
  KEY idx_role (role_id)
) ENGINE=InnoDB COMMENT='用户-角色（多对多）';

-- =====================================================================
-- 二、支付渠道（多渠道、敏感配置加密、默认渠道唯一）
-- =====================================================================

DROP TABLE IF EXISTS sys_pay_channel_log, sys_pay_channel;

CREATE TABLE sys_pay_channel (
  channel_id      BIGINT       NOT NULL AUTO_INCREMENT,
  channel_code    VARCHAR(32)  NOT NULL COMMENT 'alipay|wechat|usdt|mock',
  channel_name    VARCHAR(64)  NOT NULL,
  scene           VARCHAR(32)  NOT NULL DEFAULT 'all' COMMENT 'all|subscription|single（订阅/单片可分渠道）',
  env             VARCHAR(16)  NOT NULL DEFAULT 'sandbox' COMMENT 'sandbox|prod',
  status          CHAR(1)      NOT NULL DEFAULT '1' COMMENT '0启用 1停用',
  is_default      TINYINT      NOT NULL DEFAULT 0 COMMENT '同 scene 内唯一',
  priority        INT          NOT NULL DEFAULT 100 COMMENT '越小越优先',
  currency        VARCHAR(8)   NOT NULL DEFAULT 'CNY',
  min_amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  max_amount      DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '0=不限',
  -- 关键：敏感配置整体加密后存一列；再冗余一列脱敏预览用于列表展示
  config_cipher   TEXT         DEFAULT NULL COMMENT 'AES-256-GCM(v1:iv:tag:cipher)，JSON 明文含 AppID/私钥等',
  config_preview  JSON         DEFAULT NULL COMMENT '脱敏后的配置，供列表/详情安全回显',
  key_version     INT          NOT NULL DEFAULT 1 COMMENT '加密密钥版本，便于轮换',
  remark          VARCHAR(500) DEFAULT NULL,
  create_by       VARCHAR(64)  DEFAULT '',
  create_time     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  update_time     DATETIME     DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id),
  UNIQUE KEY uk_channel (channel_code, env, scene),
  -- 同一场景只能有一个默认：用生成列做部分唯一索引
  default_scene   VARCHAR(40) GENERATED ALWAYS AS (IF(is_default = 1, CONCAT(scene, ':default'), NULL)) STORED,
  UNIQUE KEY uk_default_per_scene (default_scene)
) ENGINE=InnoDB COMMENT='支付渠道配置（多环境多场景）';

CREATE TABLE sys_pay_channel_log (
  log_id      BIGINT      NOT NULL AUTO_INCREMENT,
  channel_id  BIGINT      NOT NULL,
  action      VARCHAR(32) NOT NULL COMMENT 'create|update|status|default|delete|test',
  field_diff  JSON        DEFAULT NULL COMMENT '仅记录字段名与是否变更，不记录明文',
  operator_id BIGINT      NOT NULL,
  operator_ip VARCHAR(64) DEFAULT NULL,
  reason      VARCHAR(500) DEFAULT NULL,
  create_time DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_channel (channel_id)
) ENGINE=InnoDB COMMENT='支付渠道变更审计（不含密钥明文）';

-- =====================================================================
-- 三、订单侧需要的"渠道快照"（配置改了也能对账）
-- =====================================================================
-- ALTER TABLE orders
--   ADD COLUMN channel_id     BIGINT      NULL COMMENT '下单时使用的渠道记录ID',
--   ADD COLUMN channel_env    VARCHAR(16) NULL COMMENT 'sandbox|prod 快照',
--   ADD COLUMN channel_key_ver INT        NULL COMMENT '下单时密钥版本快照',
--   ADD COLUMN channel_txn_id VARCHAR(128) NULL COMMENT '渠道交易号';

-- =====================================================================
-- 四、与当前 SQLite 实现的对应关系
-- =====================================================================
-- sys_user        ↔ admins
-- sys_role        ↔ roles
-- sys_menu        ↔ permissions(code,name,type,parent_code,sort,path,icon,visible)
-- sys_role_menu   ↔ role_permissions(role_id, permission_code)
-- sys_user_role   ↔ admin_roles
-- sys_pay_channel ↔ pay_channels（SQLite 用 config_cipher TEXT + 应用层校验唯一默认）
-- 差异说明：
--   1) SQLite 无 GENERATED 列索引，默认唯一性由事务 + 应用层保证（setDefaultChannel 内先清零同场景再置位）；
--   2) SQLite 的 JSON 以 TEXT 存；preview 字段是字符串化 JSON；
--   3) 无 sys_dept / sys_post / sys_user_post / 数据权限"部门树"，data_scope 仅保留 1=全部、2=仅本人。
