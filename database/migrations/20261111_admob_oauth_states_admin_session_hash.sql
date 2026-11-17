-- ==============================================================================
-- FaceTube - Database Migration: Add Admin Session Hash to AdMob OAuth States
-- Migration: 20261111_admob_oauth_states_admin_session_hash.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Security Model (Phase 2.4.1):
-- - Separates the cookie binding secret hash from the admin session token hash
-- - `session_hash` VARCHAR(64) stores SHA-256(binding_secret)
-- - `admin_session_hash` VARCHAR(64) stores SHA-256(initiating_admin_session_token)
-- - Never stores raw session tokens or binding secrets in plaintext
-- - Enables independent verification that the exact initiating admin session is active
-- ==============================================================================

-- Compatible with Oracle MySQL 8.0, 5.7, 8.4 LTS and MariaDB
-- 1. Conditionally add column `admin_session_hash` if not already present
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_oauth_states'
    AND COLUMN_NAME = 'admin_session_hash'
);

SET @sql_add_col := IF(
  @col_exists = 0,
  'ALTER TABLE `admob_oauth_states` ADD COLUMN `admin_session_hash` VARCHAR(64) NOT NULL DEFAULT \'\' AFTER `session_hash`',
  'SELECT \'Column admin_session_hash already exists in admob_oauth_states\''
);

PREPARE stmt_add_col FROM @sql_add_col;
EXECUTE stmt_add_col;
DEALLOCATE PREPARE stmt_add_col;

-- 2. Conditionally add index `idx_admob_state_admin_session` if not already present
SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_oauth_states'
    AND INDEX_NAME = 'idx_admob_state_admin_session'
);

SET @sql_add_idx := IF(
  @idx_exists = 0,
  'ALTER TABLE `admob_oauth_states` ADD KEY `idx_admob_state_admin_session` (`admin_session_hash`)',
  'SELECT \'Index idx_admob_state_admin_session already exists in admob_oauth_states\''
);

PREPARE stmt_add_idx FROM @sql_add_idx;
EXECUTE stmt_add_idx;
DEALLOCATE PREPARE stmt_add_idx;

