-- ==============================================================================
-- FaceTube - Database Migration: Paid User Subscriptions & Activations
-- Migration: 20261104_paid_subscriptions_orders_and_activation.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: user_subscriptions
-- Stores verified user subscriptions, validity periods, order/payment links,
-- and membership tier states.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_subscriptions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subscription_id` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `plan_id` VARCHAR(50) NOT NULL,
  `order_id` VARCHAR(100) NOT NULL,
  `payment_id` VARCHAR(100) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'INR',
  `status` ENUM('active', 'expired', 'cancelled', 'refunded') NOT NULL DEFAULT 'active',
  `starts_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user_subscriptions_sub_id` (`subscription_id`),
  UNIQUE KEY `uniq_user_subscriptions_payment_id` (`payment_id`),
  UNIQUE KEY `uniq_user_subscriptions_order_id` (`order_id`),
  KEY `idx_user_subscriptions_user_status` (`user_id`, `status`),
  KEY `idx_user_subscriptions_plan_id` (`plan_id`),
  KEY `idx_user_subscriptions_expires_at` (`expires_at`),
  KEY `idx_user_subscriptions_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
