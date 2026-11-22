-- ==============================================================================
-- FaceTube - Database Migration: Idempotent music_json Column on uploaded_images
-- Migration: 20261121_uploaded_images_music_json.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Purpose:
-- Safely adds missing `music_json` column to the `uploaded_images` table in
-- Hostinger production (`u363812516_FaceTube`) without modifying, dropping,
-- renaming, or recreating the table or any existing image records:
--   - `music_json` TEXT DEFAULT NULL
--
-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and Hostinger MariaDB 10.x/11.x.
-- ==============================================================================

-- 1. Check whether `uploaded_images` table exists in the active schema
SET @tbl_uploaded_images_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'uploaded_images'
);

-- 2. Check whether `music_json` column already exists on `uploaded_images`
SET @col_music_json_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'uploaded_images'
    AND COLUMN_NAME = 'music_json'
);

-- 3. Check whether `category` column exists to preserve schema.sql column order
SET @col_category_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'uploaded_images'
    AND COLUMN_NAME = 'category'
);

-- 4. Conditionally add `music_json` TEXT DEFAULT NULL only if missing
SET @sql_add_music_json := IF(
  @tbl_uploaded_images_exists > 0 AND @col_music_json_exists = 0,
  IF(
    @col_category_exists > 0,
    'ALTER TABLE `uploaded_images` ADD COLUMN `music_json` TEXT DEFAULT NULL AFTER `category`',
    'ALTER TABLE `uploaded_images` ADD COLUMN `music_json` TEXT DEFAULT NULL'
  ),
  IF(
    @tbl_uploaded_images_exists = 0,
    'SELECT ''Table uploaded_images does not exist yet; skipping music_json migration'' AS migration_status',
    'SELECT ''Column music_json already exists in uploaded_images'' AS migration_status'
  )
);

PREPARE stmt_add_music_json FROM @sql_add_music_json;
EXECUTE stmt_add_music_json;
DEALLOCATE PREPARE stmt_add_music_json;
