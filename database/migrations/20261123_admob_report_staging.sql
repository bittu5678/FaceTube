-- ==============================================================================
-- FaceTube - Database Migration: Company AdMob Reporting Staging Snapshots
-- Migration: 20261123_admob_report_staging.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Accounting & Compliance Model (Step 9C Phase 2):
-- - 100% of AdMob revenue belongs to FaceTube company (no creator wallet credits)
-- - API-fetched estimated earnings remain strictly in this staging table
-- - Never touches wallet_balances or creator income_ledger
-- - Enforces unique (publisher_id, app_id, report_month) idempotency
-- - Currency is strictly verified INR from Google AdMob publisher metadata
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Conditionally add reporting_time_zone to admob_oauth_credentials if missing
-- ------------------------------------------------------------------------------
SET @cred_tbl_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_oauth_credentials'
);

SET @tz_col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_oauth_credentials'
    AND COLUMN_NAME = 'reporting_time_zone'
);

SET @sql_add_tz := IF(
  @cred_tbl_exists > 0 AND @tz_col_exists = 0,
  'ALTER TABLE `admob_oauth_credentials` ADD COLUMN `reporting_time_zone` VARCHAR(100) DEFAULT NULL AFTER `currency_code`',
  'SELECT ''Column reporting_time_zone already exists or admob_oauth_credentials missing'''
);

PREPARE stmt_add_tz FROM @sql_add_tz;
EXECUTE stmt_add_tz;
DEALLOCATE PREPARE stmt_add_tz;

-- ------------------------------------------------------------------------------
-- 2. Table: admob_report_snapshots
-- Dedicated idempotent staging table for monthly company AdMob API snapshots.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admob_report_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `publisher_id` VARCHAR(100) NOT NULL,
  `app_id` VARCHAR(100) NOT NULL,
  `report_month` VARCHAR(7) NOT NULL COMMENT 'Format: YYYY-MM',
  `period_start` DATE NOT NULL,
  `period_end` DATE NOT NULL,
  `reporting_time_zone` VARCHAR(100) DEFAULT NULL,
  `currency_code` VARCHAR(10) NOT NULL DEFAULT 'INR',
  `estimated_earnings_micros` BIGINT NOT NULL DEFAULT 0,
  `estimated_earnings` DECIMAL(16, 6) NOT NULL DEFAULT 0.000000,
  `impressions` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `clicks` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `ad_requests` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `matched_requests` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `ownership_scope` VARCHAR(40) NOT NULL DEFAULT 'COMPANY_100_PERCENT',
  `status` ENUM('staged_estimated', 'verified_finalized') NOT NULL DEFAULT 'staged_estimated',
  `sync_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `synced_by` VARCHAR(50) NOT NULL,
  `synced_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `verified_by` VARCHAR(50) DEFAULT NULL,
  `verified_at` DATETIME DEFAULT NULL,
  `verification_notes` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_admob_snapshot_pub_app_month` (`publisher_id`, `app_id`, `report_month`),
  KEY `idx_admob_snapshot_month` (`report_month`),
  KEY `idx_admob_snapshot_status` (`status`),
  KEY `idx_admob_snapshot_app` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
