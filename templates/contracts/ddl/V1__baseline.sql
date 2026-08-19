-- =====================================================================
-- <项目代号> · 基线迁移  V1__baseline.sql
-- 生成依据：<数据库设计.md> · <字典>.yaml
-- 规则版本：<BR vX.Y>   ·   <MySQL 8.0 / InnoDB / utf8mb4>
--
-- 纪律（CLAUDE.md <N-08 类禁令>）：
--   标 [APPEND-ONLY] 的表禁止 UPDATE 覆盖业务列、禁止物理 DELETE、无 del_flag、无 version
--   标 [CAS] 的表仅 status 及一次性回填列可 UPDATE，且必须 WHERE status=<from>
--   标 [MUTABLE] 的表可正常 UPDATE（带乐观锁）
-- 枚举值一律来自 <字典>.yaml，禁止新增（N-01）
-- 后续变更一律追加 V<n>__<说明>.sql，不修改本文件（关闭的 D-*/G-* 各自落一个迁移）
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ─────────────────────────────────────────────────────────────────────
-- 1. <第一个模块>
-- ─────────────────────────────────────────────────────────────────────

-- [MUTABLE] <主对象>：可编辑，带乐观锁
CREATE TABLE <prefix>_<entity> (
  id            bigint       NOT NULL COMMENT '雪花ID（conventions §N）',
  tenant_id     varchar(20)  NOT NULL DEFAULT '<000000>',
  name          varchar(200) NOT NULL COMMENT '<语义>',
  status        varchar(32)  NOT NULL DEFAULT '<initial>' COMMENT '<枚举名>: <a>/<b>/<c> —— 枚举见字典 yaml，禁新增',
  version       int          NOT NULL DEFAULT 0 COMMENT '乐观锁（<BR-XXX-00n>）',
  create_by     bigint       NULL,
  create_time   datetime(3)  NULL,
  update_by     bigint       NULL,
  update_time   datetime(3)  NULL,
  del_flag      char(1)      NOT NULL DEFAULT '0',
  PRIMARY KEY (id),
  KEY idx_tenant_name (tenant_id, name)
) ENGINE=InnoDB COMMENT='<主对象>';

-- [APPEND-ONLY] <不可变对象>：只许 INSERT（<BR-XXX-00n>）
--   业务列禁 UPDATE、禁物理 DELETE；因此无 del_flag、无 version
CREATE TABLE <prefix>_<immutable_entity> (
  id            bigint       NOT NULL COMMENT '雪花ID',
  tenant_id     varchar(20)  NOT NULL DEFAULT '000000',
  <parent_id>   bigint       NOT NULL COMMENT '所属 <主对象>',
  <content>     json         NOT NULL COMMENT '创建时冻结的快照',
  create_by     bigint       NOT NULL,
  create_time   datetime(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_<parent> (<parent_id>, create_time)
) ENGINE=InnoDB COMMENT='<不可变对象> · 追加而非覆盖（<BR-XXX-00n>）';

-- [CAS] <流程对象>：仅 status 可按状态机迁移
CREATE TABLE <prefix>_<workflow_entity> (
  id            bigint       NOT NULL,
  tenant_id     varchar(20)  NOT NULL DEFAULT '000000',
  status        varchar(32)  NOT NULL DEFAULT '<initial>' COMMENT '<枚举名>',
  fail_reason   varchar(500) NULL,
  external_ref  varchar(64)  NULL COMMENT '外部请求/订单标识 —— 查单依据',
  retry_of      bigint       NULL COMMENT '指向原记录；配合 uk_retry_once 保证只重试一次',
  create_time   datetime(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_retry_once (retry_of)
) ENGINE=InnoDB COMMENT='<流程对象> · 状态机见字典 yaml';

SET FOREIGN_KEY_CHECKS = 1;
