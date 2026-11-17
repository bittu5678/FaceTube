-- ==============================================================================
-- FaceTube - Database Migration: Remove Test App ID Default on admob_monthly_statements
-- Migration: 20261113_admob_statements_remove_test_app_id_default.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and MariaDB
-- Safely modifies `admob_monthly_statements.app_id` to `VARCHAR(100) DEFAULT NULL`
-- only when the table exists and the column is NOT NULL, has any DEFAULT, or references the test App ID.
SET @tbl_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_monthly_statements'
);

SET @needs_modify := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'admob_monthly_statements'
    AND COLUMN_NAME = 'app_id'
    AND (
      IS_NULLABLE = 'NO'
      OR COLUMN_DEFAULT IS NOT NULL
      OR COALESCE(COLUMN_DEFAULT, '') LIKE '%3940256099942544%'
    )
);

SET @sql_fix_app_id := IF(
  @tbl_exists > 0 AND @needs_modify > 0,
  'ALTER TABLE `admob_monthly_statements` MODIFY COLUMN `app_id` VARCHAR(100) DEFAULT NULL',
  'SELECT ''No change needed for admob_monthly_statements.app_id'''
);

PREPARE stmt_fix_app_id FROM @sql_fix_app_id;
EXECUTE stmt_fix_app_id;
DEALLOCATE PREPARE stmt_fix_app_id;
