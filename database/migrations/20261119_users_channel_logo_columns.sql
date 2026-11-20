-- ==============================================================================
-- FaceTube - Database Migration: Idempotent Channel Logo Columns on users
-- Migration: 20261119_users_channel_logo_columns.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Purpose:
-- Safely adds missing channel identity columns to the `users` table in
-- Hostinger production (`u363812516_FaceTube`) without modifying, dropping,
-- renaming, or recreating the table or any existing user records:
--   - `channel_name` VARCHAR(255) NULL
--   - `channel_logo_url` VARCHAR(500) NULL
--   - `channel_banner_url` VARCHAR(500) NULL
--
-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and Hostinger MariaDB 10.x/11.x.
-- ==============================================================================

-- 1. Conditionally add `channel_name` VARCHAR(255) NULL after `name`
SET @col_channel_name_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'channel_name'
);

SET @sql_add_channel_name := IF(
  @col_channel_name_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `channel_name` VARCHAR(255) NULL DEFAULT NULL AFTER `name`',
  'SELECT ''Column channel_name already exists in users'' AS migration_status'
);

PREPARE stmt_add_channel_name FROM @sql_add_channel_name;
EXECUTE stmt_add_channel_name;
DEALLOCATE PREPARE stmt_add_channel_name;

-- 2. Conditionally add `channel_logo_url` VARCHAR(500) NULL after `avatar_url`
SET @col_channel_logo_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'channel_logo_url'
);

SET @sql_add_channel_logo := IF(
  @col_channel_logo_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `channel_logo_url` VARCHAR(500) NULL DEFAULT NULL AFTER `avatar_url`',
  'SELECT ''Column channel_logo_url already exists in users'' AS migration_status'
);

PREPARE stmt_add_channel_logo FROM @sql_add_channel_logo;
EXECUTE stmt_add_channel_logo;
DEALLOCATE PREPARE stmt_add_channel_logo;

-- 3. Conditionally add `channel_banner_url` VARCHAR(500) NULL after `channel_logo_url`
SET @col_channel_banner_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'channel_banner_url'
);

SET @sql_add_channel_banner := IF(
  @col_channel_banner_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `channel_banner_url` VARCHAR(500) NULL DEFAULT NULL AFTER `channel_logo_url`',
  'SELECT ''Column channel_banner_url already exists in users'' AS migration_status'
);

PREPARE stmt_add_channel_banner FROM @sql_add_channel_banner;
EXECUTE stmt_add_channel_banner;
DEALLOCATE PREPARE stmt_add_channel_banner;
