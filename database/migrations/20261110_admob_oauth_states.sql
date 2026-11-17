-- ==============================================================================
-- FaceTube - Database Migration: AdMob OAuth State & Nonce Replay Protection
-- Migration: 20261110_admob_oauth_states.sql
-- Status: PENDING USER APPROVAL - SAFE, IDEMPOTENT & NON-DESTRUCTIVE
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
--
-- Security Model:
-- - Nonces are stored when authorization URLs are generated
-- - Bound to Admin user ID, initiating session hash, and expiration timestamp
-- - Single-use: atomically marked consumed on callback; replays are rejected with HTTP 403
-- - Does NOT store raw session tokens or sensitive secrets
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `admob_oauth_states` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `nonce` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `session_hash` VARCHAR(64) NOT NULL,
  `admin_session_hash` VARCHAR(64) NOT NULL DEFAULT '',
  `state_hash` VARCHAR(64) NOT NULL,
  `is_consumed` TINYINT(1) NOT NULL DEFAULT 0,
  `consumed_at` DATETIME DEFAULT NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_admob_state_nonce` (`nonce`),
  KEY `idx_admob_state_lookup` (`nonce`, `is_consumed`, `expires_at`),
  KEY `idx_admob_state_admin_session` (`admin_session_hash`),
  KEY `idx_admob_state_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
