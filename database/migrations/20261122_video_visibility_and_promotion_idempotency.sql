-- ==============================================================================
-- FaceTube - Database Migration: Video Visibility & Promotion Idempotency
-- Migration: 20261122_video_visibility_and_promotion_idempotency.sql
-- Status: SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Historical Visibility Documentation:
--   Prior to this migration, `uploaded_videos` did not persist a `visibility`
--   column, even though the Bulk Upload UI allowed creators to select `public`,
--   `unlisted`, or `private`. Those historical `private`/`unlisted` selections
--   cannot be recovered from stored records.
--
-- Backfill Policy (Privacy-First Option A):
--   - Adds `visibility ENUM('public', 'unlisted', 'private') NOT NULL DEFAULT 'public'`
--     so all new uploads persist their explicit selection (defaulting to 'public').
--   - Backfills all pre-migration user-uploaded rows in `uploaded_videos` to
--     'private' so no unrecoverable private/unlisted video is exposed across users.
--   - Preserves 'public' ONLY for verified system demo rows (`vid-seed-001`..
--     `vid-seed-008` belonging to demo accounts `FT483921` / `FT900431`).
--   - Does NOT delete, overwrite, or alter any video URLs, ownership, views,
--     likes, or payment records.
--
-- Compatible with Oracle MySQL 5.7, 8.0, 8.4 LTS and Hostinger MariaDB 10.x/11.x.
-- ==============================================================================

SET @db := DATABASE();

-- 1. Conditionally add `visibility` column on `uploaded_videos` and apply one-time backfill
SET @tbl_uploaded_videos_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
);

SET @col_visibility_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND COLUMN_NAME = 'visibility'
);

SET @sql_add_visibility := IF(
  @tbl_uploaded_videos_exists > 0 AND @col_visibility_exists = 0,
  'ALTER TABLE `uploaded_videos` ADD COLUMN `visibility` ENUM(''public'', ''unlisted'', ''private'') NOT NULL DEFAULT ''public'' AFTER `is_promoted`',
  'SELECT ''Column visibility already exists or uploaded_videos missing'' AS migration_status'
);
PREPARE stmt_add_visibility FROM @sql_add_visibility;
EXECUTE stmt_add_visibility;
DEALLOCATE PREPARE stmt_add_visibility;

-- Backfill pre-migration user rows to 'private' ONLY during initial column creation.
-- Preserves 'public' strictly for verified demo rows (`vid-seed-*` owned by FT483921/FT900431).
SET @sql_backfill_visibility := IF(
  @tbl_uploaded_videos_exists > 0 AND @col_visibility_exists = 0,
  'UPDATE `uploaded_videos` SET `visibility` = ''private'' WHERE NOT (`id` IN (''vid-seed-001'', ''vid-seed-002'', ''vid-seed-003'', ''vid-seed-004'', ''vid-seed-005'', ''vid-seed-006'', ''vid-seed-007'', ''vid-seed-008'') AND UPPER(`user_id`) IN (''FT483921'', ''FT900431''))',
  'SELECT ''Skipping visibility backfill (already migrated)'' AS migration_status'
);
PREPARE stmt_backfill_visibility FROM @sql_backfill_visibility;
EXECUTE stmt_backfill_visibility;
DEALLOCATE PREPARE stmt_backfill_visibility;

SET @idx_visibility_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND INDEX_NAME = 'idx_videos_visibility'
);
SET @sql_idx_visibility := IF(
  @tbl_uploaded_videos_exists > 0 AND @idx_visibility_exists = 0,
  'CREATE INDEX `idx_videos_visibility` ON `uploaded_videos` (`visibility`)',
  'SELECT ''Index idx_videos_visibility already exists'' AS migration_status'
);
PREPARE stmt_idx_visibility FROM @sql_idx_visibility;
EXECUTE stmt_idx_visibility;
DEALLOCATE PREPARE stmt_idx_visibility;

-- 2. Conditionally add `promotion_payment_id` column on `uploaded_videos`
SET @col_promo_payment_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND COLUMN_NAME = 'promotion_payment_id'
);
SET @sql_add_promo_payment := IF(
  @tbl_uploaded_videos_exists > 0 AND @col_promo_payment_exists = 0,
  'ALTER TABLE `uploaded_videos` ADD COLUMN `promotion_payment_id` VARCHAR(100) DEFAULT NULL AFTER `promotion_expires_at`',
  'SELECT ''Column promotion_payment_id already exists or uploaded_videos missing'' AS migration_status'
);
PREPARE stmt_add_promo_payment FROM @sql_add_promo_payment;
EXECUTE stmt_add_promo_payment;
DEALLOCATE PREPARE stmt_add_promo_payment;

SET @idx_promo_payment_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND INDEX_NAME = 'idx_videos_promotion_payment_id'
);
SET @sql_idx_promo_payment := IF(
  @tbl_uploaded_videos_exists > 0 AND @idx_promo_payment_exists = 0,
  'CREATE INDEX `idx_videos_promotion_payment_id` ON `uploaded_videos` (`promotion_payment_id`)',
  'SELECT ''Index idx_videos_promotion_payment_id already exists'' AS migration_status'
);
PREPARE stmt_idx_promo_payment FROM @sql_idx_promo_payment;
EXECUTE stmt_idx_promo_payment;
DEALLOCATE PREPARE stmt_idx_promo_payment;

-- 3. Conditionally add `promotion_applied_at` and `idx_po_payment_id` on `payment_orders`
SET @tbl_payment_orders_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'payment_orders'
);

SET @col_promo_applied_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'payment_orders'
    AND COLUMN_NAME = 'promotion_applied_at'
);
SET @sql_add_promo_applied := IF(
  @tbl_payment_orders_exists > 0 AND @col_promo_applied_exists = 0,
  'ALTER TABLE `payment_orders` ADD COLUMN `promotion_applied_at` DATETIME DEFAULT NULL AFTER `payment_id`',
  'SELECT ''Column promotion_applied_at already exists or payment_orders missing'' AS migration_status'
);
PREPARE stmt_add_promo_applied FROM @sql_add_promo_applied;
EXECUTE stmt_add_promo_applied;
DEALLOCATE PREPARE stmt_add_promo_applied;

SET @idx_po_payment_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'payment_orders'
    AND INDEX_NAME = 'idx_po_payment_id'
);
SET @sql_idx_po_payment := IF(
  @tbl_payment_orders_exists > 0 AND @idx_po_payment_exists = 0,
  'CREATE INDEX `idx_po_payment_id` ON `payment_orders` (`payment_id`)',
  'SELECT ''Index idx_po_payment_id already exists'' AS migration_status'
);
PREPARE stmt_idx_po_payment FROM @sql_idx_po_payment;
EXECUTE stmt_idx_po_payment;
DEALLOCATE PREPARE stmt_idx_po_payment;
