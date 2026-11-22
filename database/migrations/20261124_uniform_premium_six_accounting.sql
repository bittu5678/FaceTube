-- ==============================================================================
-- FaceTube - Database Migration: Uniform ₹6 Premium Transaction Accounting
-- Migration: 20261124_uniform_premium_six_accounting.sql
-- Purpose:
--   Add explicit accounting columns for GST (₹0.90), Payment Gateway Fee (₹0.10),
--   and referral allocation status ('not_applicable', 'credited', 'unassigned_pending')
--   on payment_transactions and premium_transactions without altering historical rows
--   or historical wallet/ledger balances.
-- ==============================================================================

SET @db := DATABASE();

-- 1. payment_transactions.gst_amount
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'gst_amount'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `gst_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_allocation`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. payment_transactions.pg_fee
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'pg_fee'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `pg_fee` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `gst_amount`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. payment_transactions.referral_status
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'referral_status'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `referral_status` VARCHAR(32) NOT NULL DEFAULT ''not_applicable'' AFTER `pg_fee`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. premium_transactions.gst_amount
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'gst_amount'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `gst_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_allocation`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. premium_transactions.pg_fee
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'pg_fee'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `pg_fee` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `gst_amount`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. premium_transactions.referral_status
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'referral_status'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `referral_status` VARCHAR(32) NOT NULL DEFAULT ''not_applicable'' AFTER `pg_fee`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==============================================================================
-- Business Handling Note for Missing / Invalid Referrer:
-- When a ₹6.00 premium_video_upload transaction has no valid referrer,
-- referral_commission = 1.00 and referral_status = 'unassigned_pending'.
-- A pending income_ledger record is created under user_id = 'UNASSIGNED_REFERRAL'
-- with special_tag = 'REFERRAL_UNASSIGNED_PENDING' and status = 'pending',
-- without silently transferring ₹1.00 to Admin or altering Admin's ₹1.00 base share.
-- ==============================================================================
