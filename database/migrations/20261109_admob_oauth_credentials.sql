-- ==============================================================================
-- FaceTube - Database Migration: Secure Google AdMob OAuth Credentials Storage
-- Migration: 20261109_admob_oauth_credentials.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Security Model:
-- - Refresh tokens are stored strictly AES-256-GCM encrypted (never plaintext)
-- - Initialization Vector (IV) and Authentication Tag (GCM) stored alongside ciphertext
-- - No secrets, tokens, or credentials are ever exposed to the frontend or Android client
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `admob_oauth_credentials` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `publisher_id` VARCHAR(100) NOT NULL, -- Format: pub-XXXXXXXXXXXXXXXX
  `account_name` VARCHAR(150) DEFAULT NULL,
  `currency_code` VARCHAR(10) NOT NULL DEFAULT 'INR',
  `encrypted_refresh_token` TEXT NOT NULL,
  `refresh_token_iv` VARCHAR(64) NOT NULL,
  `refresh_token_tag` VARCHAR(64) NOT NULL,
  `token_expiry` DATETIME DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `connected_by` VARCHAR(50) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_admob_publisher` (`publisher_id`),
  KEY `idx_admob_is_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
