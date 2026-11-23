-- ==============================================================================
-- FaceTube - Database Migration: Country-wise Video Tracking
-- Migration: 20261126_uploaded_videos_country.sql
-- Status: SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Historical Video Policy:
--   - Adds nullable `country_code VARCHAR(10) DEFAULT NULL` on `uploaded_videos`
--     without altering or guessing historical records.
--   - Pre-migration rows remain `NULL` and are grouped under `UNKNOWN`
--     ("Unknown / Unassigned") in Admin country analytics.
--   - New uploads store verified uppercase ISO 3166-1 alpha-2 codes or
--     `UNKNOWN` when no trusted server-side country source is available.
--
-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and Hostinger MariaDB 10.x/11.x.
-- ==============================================================================

SET @db := DATABASE();

SET @tbl_uploaded_videos_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
);

SET @col_country_code_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND COLUMN_NAME = 'country_code'
);

SET @sql_add_country_code := IF(
  @tbl_uploaded_videos_exists > 0 AND @col_country_code_exists = 0,
  'ALTER TABLE `uploaded_videos` ADD COLUMN `country_code` VARCHAR(10) DEFAULT NULL AFTER `visibility`',
  'SELECT ''Column country_code already exists or uploaded_videos missing'' AS migration_status'
);
PREPARE stmt_add_country_code FROM @sql_add_country_code;
EXECUTE stmt_add_country_code;
DEALLOCATE PREPARE stmt_add_country_code;

SET @idx_country_code_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND INDEX_NAME = 'idx_videos_country_code'
);

SET @sql_idx_country_code := IF(
  @tbl_uploaded_videos_exists > 0 AND @idx_country_code_exists = 0,
  'CREATE INDEX `idx_videos_country_code` ON `uploaded_videos` (`country_code`)',
  'SELECT ''Index idx_videos_country_code already exists'' AS migration_status'
);
PREPARE stmt_idx_country_code FROM @sql_idx_country_code;
EXECUTE stmt_idx_country_code;
DEALLOCATE PREPARE stmt_idx_country_code;
