-- ==============================================================================
-- FaceTube - Database Migration: Paid Subscriber Plans Foundation
-- Migration: 20261104_paid_subscriber_plans_and_refunds.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: subscriber_plans
-- Stores configurable subscription tiers for creators and channel memberships
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `subscriber_plans` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `plan_id` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `price` DECIMAL(10, 2) NOT NULL,
  `duration_days` INT UNSIGNED NOT NULL DEFAULT 30,
  `perks_json` TEXT DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_subscriber_plans_plan_id` (`plan_id`),
  KEY `idx_subscriber_plans_is_active` (`is_active`),
  KEY `idx_subscriber_plans_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 2. Idempotent baseline subscriber plans seeding
-- Uses INSERT IGNORE so re-running this migration is completely safe and non-destructive.
-- ------------------------------------------------------------------------------
INSERT IGNORE INTO `subscriber_plans` (`plan_id`, `name`, `price`, `duration_days`, `perks_json`, `is_active`) VALUES
  ('member-monthly', 'Creator Member', 49.00, 30, '["Custom channel member badge", "Early access to new videos", "Exclusive member-only live stream chat"]', 1),
  ('member-vip-monthly', 'VIP Supporter', 149.00, 30, '["All Creator Member perks", "Priority comment replies", "Exclusive behind-the-scenes content", "VIP live badge"]', 1),
  ('member-annual', 'All-Access Annual', 999.00, 365, '["Full VIP access for 1 full year", "16% savings vs monthly", "Special Gold Supporter badge on all videos"]', 1);
