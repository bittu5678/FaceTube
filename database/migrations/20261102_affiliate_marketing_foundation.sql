-- ==============================================================================
-- FaceTube - Database Migration: Secure Affiliate Marketing Backend Foundation
-- Migration: 20261102_affiliate_marketing_foundation.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================
--
-- PURPOSE:
-- 1. Establishes the secure Affiliate Marketing backend foundation for:
--    - Amazon Associates
--    - Impact (Impact Radius)
--    - EarnKaro
-- 2. Enforces click tracking with creator attribution (`creator_user_id`) and optional `video_id`.
-- 3. Enforces conversion idempotency: unique `(network, external_action_id)`.
-- 4. Multi-stage status lifecycle: `pending`, `approved`, `settled`, `rejected`, `reversed`.
-- 5. Wallet protection: NEVER credit wallet balances for pending/unverified conversions.
-- 6. Atomic settlement: credits `wallet_balances.affiliate_income` and `income_ledger`
--    only upon verified settlement, protected with row locks.
-- 7. Complete audit trail: logs every status transition, reversal, and ledger adjustment.
-- 8. All networks are INACTIVE by default (`is_active = 0`, `0.00%`, `0` days holding period)
--    until official corporate credentials and commission rates are approved.
--
-- ------------------------------------------------------------------------------
-- 1. Table: affiliate_networks_config
-- Stores platform-level affiliate provider credentials, status, and domain rules
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `affiliate_networks_config` (
  `id` VARCHAR(50) NOT NULL COMMENT 'Unique network slug: amazon, impact, earnkaro',
  `name` VARCHAR(100) NOT NULL COMMENT 'Display name of affiliate network',
  `is_active` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0 = Disabled/Inactive, 1 = Active for tracking',
  `creator_share_percentage` DECIMAL(5, 2) NOT NULL DEFAULT 0.00 COMMENT 'Configurable creator revenue share percentage',
  `holding_period_days` INT NOT NULL DEFAULT 0 COMMENT 'Holding/lock period in days before settlement is permitted',
  `allowed_domains` TEXT NOT NULL COMMENT 'Comma-separated list of whitelisted destination domains to prevent SSRF and open redirects',
  `publisher_id` VARCHAR(100) DEFAULT NULL COMMENT 'FaceTube corporate publisher/affiliate tag',
  `webhook_secret` VARCHAR(255) DEFAULT NULL COMMENT 'HMAC secret key or shared token for webhook verification',
  `api_key_encrypted` TEXT DEFAULT NULL COMMENT 'Encrypted API key for provider automated reconciliation',
  `settings_json` JSON DEFAULT NULL COMMENT 'Optional network-specific configurations',
  `updated_by` VARCHAR(50) DEFAULT NULL COMMENT 'Admin user_id who last modified config',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_aff_net_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 2. Table: affiliate_clicks
-- Tracks creator-attributed product clicks with SSRF protection and privacy hashing
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `affiliate_clicks` (
  `id` VARCHAR(64) NOT NULL COMMENT 'Unique click identifier (e.g. clk_uuid)',
  `network` VARCHAR(50) NOT NULL COMMENT 'Affiliate network slug matching affiliate_networks_config.id',
  `creator_user_id` VARCHAR(50) NOT NULL COMMENT 'Creator who shared or embedded the affiliate link',
  `video_id` VARCHAR(100) DEFAULT NULL COMMENT 'Optional video where click originated',
  `target_url` TEXT NOT NULL COMMENT 'Validated outbound destination URL',
  `ip_hash` VARCHAR(64) DEFAULT NULL COMMENT 'SHA-256 hashed client IP address for privacy-compliant fraud audit',
  `user_agent` VARCHAR(255) DEFAULT NULL COMMENT 'Truncated client user agent',
  `referrer` VARCHAR(255) DEFAULT NULL COMMENT 'HTTP referrer URL if present',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_aff_clk_creator` (`creator_user_id`),
  KEY `idx_aff_clk_network` (`network`),
  KEY `idx_aff_clk_video` (`video_id`),
  KEY `idx_aff_clk_created` (`created_at` DESC),
  CONSTRAINT `fk_aff_clk_network` FOREIGN KEY (`network`) REFERENCES `affiliate_networks_config` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 3. Table: affiliate_conversions
-- Stores verified purchases, commissions, and creator shares with idempotency
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `affiliate_conversions` (
  `id` VARCHAR(64) NOT NULL COMMENT 'Internal conversion UUID (e.g. conv_uuid)',
  `network` VARCHAR(50) NOT NULL COMMENT 'Affiliate network slug',
  `external_action_id` VARCHAR(128) NOT NULL COMMENT 'Network-provided unique order/action identifier',
  `click_id` VARCHAR(64) DEFAULT NULL COMMENT 'Optional link back to affiliate_clicks.id',
  `creator_user_id` VARCHAR(50) NOT NULL COMMENT 'Attributed creator receiving payout share',
  `video_id` VARCHAR(100) DEFAULT NULL COMMENT 'Optional video context',
  `order_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT 'Gross purchase value in currency',
  `total_commission` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT 'Gross commission received from affiliate platform',
  `creator_share_percentage` DECIMAL(5, 2) NOT NULL DEFAULT 0.00 COMMENT 'Creator share percentage applied at conversion time',
  `creator_payout` DECIMAL(14, 2) NOT NULL DEFAULT 0.00 COMMENT 'Calculated creator payout amount (total_commission * share %)',
  `currency` VARCHAR(10) NOT NULL DEFAULT 'INR' COMMENT 'Currency ISO code',
  `status` ENUM('pending', 'approved', 'settled', 'rejected', 'reversed') NOT NULL DEFAULT 'pending' COMMENT 'Conversion lifecycle status',
  `settlement_due_at` DATETIME DEFAULT NULL COMMENT 'Timestamp after which settlement is permissible',
  `settled_at` DATETIME DEFAULT NULL COMMENT 'Timestamp when wallet was credited and settled',
  `ledger_transaction_id` VARCHAR(100) DEFAULT NULL COMMENT 'Unique transaction_id recorded in income_ledger upon settlement',
  `notes` TEXT DEFAULT NULL COMMENT 'Administrative or network callback notes',
  `raw_payload_hash` VARCHAR(64) DEFAULT NULL COMMENT 'SHA-256 hash of incoming webhook payload for audit verification',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_aff_conv_network_action` (`network`, `external_action_id`),
  UNIQUE KEY `uniq_aff_conv_ledger_tx` (`ledger_transaction_id`),
  KEY `idx_aff_conv_creator_status` (`creator_user_id`, `status`),
  KEY `idx_aff_conv_network_status` (`network`, `status`),
  KEY `idx_aff_conv_settlement_due` (`status`, `settlement_due_at`),
  KEY `idx_aff_conv_click` (`click_id`),
  KEY `idx_aff_conv_created` (`created_at` DESC),
  CONSTRAINT `fk_aff_conv_network` FOREIGN KEY (`network`) REFERENCES `affiliate_networks_config` (`id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 4. Table: affiliate_audit_log
-- Immutable log of conversion status changes, manual reviews, and wallet reversals
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `affiliate_audit_log` (
  `id` VARCHAR(64) NOT NULL,
  `conversion_id` VARCHAR(64) NOT NULL,
  `action` ENUM('ingested', 'approved', 'settled', 'rejected', 'reversed', 'manual_adjustment') NOT NULL,
  `previous_status` VARCHAR(30) DEFAULT NULL,
  `new_status` VARCHAR(30) NOT NULL,
  `amount_adjusted` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `ledger_transaction_id` VARCHAR(100) DEFAULT NULL,
  `performed_by` VARCHAR(50) NOT NULL COMMENT 'Admin user_id or SYSTEM identifier',
  `notes` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_aff_audit_conversion` (`conversion_id`),
  KEY `idx_aff_audit_action` (`action`),
  KEY `idx_aff_audit_created` (`created_at` DESC),
  CONSTRAINT `fk_aff_audit_conversion` FOREIGN KEY (`conversion_id`) REFERENCES `affiliate_conversions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 5. Seed Inactive Baseline Configurations for Target Networks
-- All networks remain strictly disabled (is_active = 0, share = 0.00%, days = 0)
-- ------------------------------------------------------------------------------
INSERT INTO `affiliate_networks_config` (
  `id`, `name`, `is_active`, `creator_share_percentage`, `holding_period_days`,
  `allowed_domains`, `publisher_id`, `webhook_secret`, `settings_json`, `created_at`
) VALUES
(
  'amazon',
  'Amazon Associates',
  0,
  0.00,
  0,
  'amazon.in,amazon.com,amzn.to,amzn.eu,amzn.asia',
  NULL,
  NULL,
  JSON_OBJECT('region', 'IN', 'api_version', 'v5'),
  NOW()
),
(
  'impact',
  'Impact Radius',
  0,
  0.00,
  0,
  'impact.com,sjv.io,ojrq.net,pxf.io,evyy.net',
  NULL,
  NULL,
  JSON_OBJECT('auth_type', 'signature_hmac_sha256'),
  NOW()
),
(
  'earnkaro',
  'EarnKaro',
  0,
  0.00,
  0,
  'earnkaro.com,ekaro.in',
  NULL,
  NULL,
  JSON_OBJECT('auth_type', 'token'),
  NOW()
)
ON DUPLICATE KEY UPDATE
  `allowed_domains` = VALUES(`allowed_domains`),
  `updated_at` = NOW();
