-- ==============================================================================
-- FaceTube - Database Migration: Uploaded Video Asset Ownership & Order Binding
-- Migration: 20261128_uploaded_video_assets_and_order_binding.sql
-- Purpose:
--   1. Create `uploaded_video_assets` table to persist authenticated creator
--      ownership of uploaded video files on server storage (`/uploads/videos/*`),
--      preventing cross-user asset theft or unauthorized binding during payment
--      recovery (`/api/payments/recover-captured`).
--   2. Add optional `video_url` column on `payment_orders` so Sponsor video
--      orders can bind to the exact uploaded video asset path.
--   3. Non-destructive and fully idempotent for MySQL 5.7+ / 8.0+ / MariaDB.
-- ==============================================================================

SET @db := DATABASE();

-- 1. Table: uploaded_video_assets
CREATE TABLE IF NOT EXISTS `uploaded_video_assets` (
  `id` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `relative_path` VARCHAR(255) NOT NULL,
  `public_url` VARCHAR(500) NOT NULL,
  `video_id` VARCHAR(64) DEFAULT NULL,
  `order_id` VARCHAR(100) DEFAULT NULL,
  `size_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `format` VARCHAR(20) NOT NULL DEFAULT 'mp4',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_uva_relative_path` (`relative_path`),
  KEY `idx_uva_user_id` (`user_id`),
  KEY `idx_uva_video_id` (`video_id`),
  KEY `idx_uva_order_id` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. payment_orders.video_url
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_orders' AND COLUMN_NAME = 'video_url'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_orders` ADD COLUMN `video_url` VARCHAR(500) DEFAULT NULL AFTER `video_id`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
