-- ==============================================================================
-- FaceTube - Database Migration: Free Creator Channel Subscriptions
-- Migration: 20261107_create_channel_subscriptions_table.sql
-- Status: PENDING MANUAL PRODUCTION APPROVAL AND EXECUTION - DO NOT EXECUTE AUTOMATICALLY
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Target: Hostinger MySQL (phpMyAdmin 5.7+ / 8.0+ / MariaDB)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: channel_subscriptions
-- Real database-backed free channel subscriptions connecting subscribers to creators.
-- Enforces creator isolation, duplicate prevention, and zero-count accuracy.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `channel_subscriptions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `creator_user_id` VARCHAR(50) NOT NULL COMMENT 'FaceTube User ID of the creator/channel owner (e.g. FT483921)',
  `subscriber_user_id` VARCHAR(50) NOT NULL COMMENT 'FaceTube User ID of the subscribing user (e.g. FT102857)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_channel_creator_subscriber` (`creator_user_id`, `subscriber_user_id`),
  KEY `idx_channel_creator_user_id` (`creator_user_id`),
  KEY `idx_channel_subscriber_user_id` (`subscriber_user_id`),
  KEY `idx_channel_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
