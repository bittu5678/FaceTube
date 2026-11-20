-- ==============================================================================
-- FaceTube - Database Migration: Idempotent Channel Description Column on users
-- Migration: 20261120_users_channel_description.sql
-- Status: SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Purpose:
-- Safely adds missing `channel_description` column to the `users` table in
-- Hostinger production (`u363812516_FaceTube`) without modifying, dropping,
-- renaming, or recreating the table or any existing user records:
--   - `channel_description` TEXT NULL DEFAULT NULL
--
-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and Hostinger MariaDB 10.x/11.x.
-- ==============================================================================

-- Conditionally add `channel_description` TEXT NULL after `channel_banner_url`
SET @col_channel_description_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'channel_description'
);

SET @sql_add_channel_description := IF(
  @col_channel_description_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `channel_description` TEXT NULL DEFAULT NULL AFTER `channel_banner_url`',
  'SELECT ''Column channel_description already exists in users'' AS migration_status'
);

PREPARE stmt_add_channel_description FROM @sql_add_channel_description;
EXECUTE stmt_add_channel_description;
DEALLOCATE PREPARE stmt_add_channel_description;
