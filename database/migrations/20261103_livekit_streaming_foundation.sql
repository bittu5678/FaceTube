-- ==============================================================================
-- FaceTube - Database Migration: LiveKit Cloud Live Streaming Foundation
-- Migration: 20261103_livekit_streaming_foundation.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Compatible with Hostinger MariaDB (10.3+) & MySQL (5.7 / 8.0)
-- Matches existing live_streams.id (VARCHAR(64) utf8mb4_unicode_ci) exactly
-- ==============================================================================

-- 1. Extend live_streams table with room and broadcaster presence tracking
ALTER TABLE `live_streams`
  ADD COLUMN IF NOT EXISTS `livekit_room_name` VARCHAR(128) DEFAULT NULL AFTER `stream_key`,
  ADD COLUMN IF NOT EXISTS `broadcaster_last_ping_at` DATETIME DEFAULT NULL AFTER `started_at`,
  ADD COLUMN IF NOT EXISTS `total_unique_viewers` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `viewers_count`;

CREATE INDEX IF NOT EXISTS `idx_live_streams_room` ON `live_streams` (`livekit_room_name`);
CREATE INDEX IF NOT EXISTS `idx_live_streams_broadcaster_ping` ON `live_streams` (`status`, `broadcaster_last_ping_at`);

-- 2. Real-Time Active Viewer Presence Table
-- Exactly matches parent column live_streams.id (VARCHAR(64) NOT NULL utf8mb4_unicode_ci)
CREATE TABLE IF NOT EXISTS `live_stream_viewers` (
  `id` VARCHAR(64) NOT NULL,
  `stream_id` VARCHAR(64) NOT NULL,
  `viewer_identifier` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(50) DEFAULT NULL,
  `joined_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_ping_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_stream_viewer` (`stream_id`, `viewer_identifier`),
  KEY `idx_viewer_stream_ping` (`stream_id`, `last_ping_at`),
  CONSTRAINT `fk_viewer_stream` FOREIGN KEY (`stream_id`) REFERENCES `live_streams` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. LiveKit Webhook Event Idempotency Table
CREATE TABLE IF NOT EXISTS `livekit_webhook_events` (
  `event_id` VARCHAR(128) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `room_name` VARCHAR(128) NOT NULL,
  `payload_hash` VARCHAR(64) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_id`),
  KEY `idx_livekit_evt_room` (`room_name`),
  KEY `idx_livekit_evt_created` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
