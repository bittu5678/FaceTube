-- ==============================================================================
-- FaceTube - Database Migration: Add admob_income Column to wallet_balances
-- Migration: 20261112_wallet_balances_admob_income.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and MariaDB
-- Conditionally add `admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 if not present
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'wallet_balances'
    AND COLUMN_NAME = 'admob_income'
);

SET @sql_add_col := IF(
  @col_exists = 0,
  'ALTER TABLE `wallet_balances` ADD COLUMN `admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 AFTER `adsense_income`',
  'SELECT \'Column admob_income already exists in wallet_balances\''
);

PREPARE stmt_add_col FROM @sql_add_col;
EXECUTE stmt_add_col;
DEALLOCATE PREPARE stmt_add_col;
