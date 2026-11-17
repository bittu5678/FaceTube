-- ==============================================================================
-- FaceTube - Database Migration: AdMob Income Foundation & Monthly Statements
-- Migration: 20261108_admob_income_foundation.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Modify income_ledger: Add 'admob_income' to income_type ENUM
-- Supports verified Google AdMob earnings credits from Android native app
-- ------------------------------------------------------------------------------
ALTER TABLE `income_ledger`
  MODIFY COLUMN `income_type` ENUM(
    'referral_income',
    'direct_commission',
    'global_income',
    'admin_allocation',
    'withdrawal',
    'ads_promotion_fee',
    'adsense_income',
    'admob_income',
    'ad_boost_income',
    'affiliate_income',
    'marketing_income'
  ) NOT NULL;

-- ------------------------------------------------------------------------------
-- 2. Table: admob_monthly_statements
-- Idempotent monthly finalized statement recording for Android Google AdMob.
-- Strictly prevents duplicate statement credits for the same creator and month.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admob_monthly_statements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `statement_id` VARCHAR(100) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `report_month` VARCHAR(7) NOT NULL, -- Format: YYYY-MM (e.g. 2026-10)
  `gross_amount` DECIMAL(14, 4) NOT NULL DEFAULT 0.0000,
  `net_amount` DECIMAL(14, 4) NOT NULL DEFAULT 0.0000,
  `impressions` INT UNSIGNED NOT NULL DEFAULT 0,
  `ecpm` DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
  `app_id` VARCHAR(100) DEFAULT NULL,
  `ledger_id` VARCHAR(64) DEFAULT NULL,
  `transaction_id` VARCHAR(100) DEFAULT NULL,
  `verified_by` VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
  `status` ENUM('finalized', 'audited', 'adjusted') NOT NULL DEFAULT 'finalized',
  `notes` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_admob_statement_user_month` (`user_id`, `report_month`),
  UNIQUE KEY `uniq_admob_statement_id` (`statement_id`),
  KEY `idx_admob_report_month` (`report_month`),
  KEY `idx_admob_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
