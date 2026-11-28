-- ==============================================================================
-- FaceTube - Database Migration: Real Watch Time Tracking System (Phase 1)
-- Migration: 20261129_watch_time_tracking.sql
-- Status: PENDING MANUAL PRODUCTION APPROVAL AND EXECUTION - DO NOT EXECUTE AUTOMATICALLY
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Target: Hostinger MySQL (MySQL 5.7+ / 8.0+ / MariaDB)
-- Purpose:
--   1. Create `watch_sessions` for authenticated viewer playback sessions,
--      server-verified creator/video attribution, session expiry, superseded
--      grace-flush control, and exactly-once qualified session tracking.
--   2. Create `watch_time_events` for idempotent, sequence-locked playback
--      heartbeat logs with UTC midnight boundary split auditing and global
--      viewer/video velocity rate-limit support.
--   3. Create `video_watch_daily` for atomic per-date creator & video
--      watch-time aggregates powering real Dashboard and Profile analytics
--      (Average View Duration = qualified_watched_seconds / qualified_sessions).
--   4. Strictly additive & idempotent. Does NOT alter or touch existing
--      users, uploaded_videos.views, payments, wallet_balances, or income_ledger.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: watch_sessions
-- Tracks each authenticated playback session with server-authoritative state.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `watch_sessions` (
  `id` VARCHAR(64) NOT NULL COMMENT 'Server-minted watch session ID (e.g. ws_uuid)',
  `viewer_user_id` VARCHAR(50) NOT NULL COMMENT 'Authenticated viewer FaceTube user_id resolved from session token',
  `video_id` VARCHAR(64) NOT NULL COMMENT 'Target video ID from uploaded_videos.id',
  `creator_user_id` VARCHAR(50) NOT NULL COMMENT 'Creator FaceTube user_id resolved server-side from uploaded_videos.user_id',
  `content_type` ENUM('short', 'long') NOT NULL DEFAULT 'long' COMMENT 'Video format resolved server-side',
  `video_duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Parsed media duration in seconds resolved server-side',
  `is_self_watch` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 when viewer_user_id matches creator_user_id (excluded from creator analytics)',
  `status` ENUM('active', 'ended') NOT NULL DEFAULT 'active' COMMENT 'Current session lifecycle state',
  `close_reason` ENUM('ended', 'unload', 'superseded', 'expired', 'cap_reached') DEFAULT NULL COMMENT 'Reason the session transitioned to ended',
  `superseded_grace_used` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 after one final pending chunk is accepted for a superseded session',
  `total_watched_seconds` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Cumulative server-validated playback seconds in this session',
  `is_qualified` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 once non-self session crosses MIN_QUALIFIED_WATCH_SECONDS (>= 3s)',
  `qualified_watch_date` DATE DEFAULT NULL COMMENT 'UTC date when this session first became qualified (incremented qualified_sessions once)',
  `last_seq` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last committed monotonic heartbeat sequence number',
  `last_position_seconds` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last reported playback position in seconds',
  `expires_at` DATETIME NOT NULL COMMENT 'Server-enforced UTC expiration timestamp for this session',
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_heartbeat_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ended_at` DATETIME DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ws_viewer_status_hb` (`viewer_user_id`, `status`, `last_heartbeat_at`),
  KEY `idx_ws_viewer_started` (`viewer_user_id`, `started_at`),
  KEY `idx_ws_viewer_video_started` (`viewer_user_id`, `video_id`, `started_at`),
  KEY `idx_ws_creator_started` (`creator_user_id`, `started_at`),
  KEY `idx_ws_video_started` (`video_id`, `started_at`),
  KEY `idx_ws_expires_at` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 2. Table: watch_time_events
-- Immutable, idempotent heartbeat log with sequence and midnight-split tracking.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `watch_time_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` VARCHAR(64) NOT NULL COMMENT 'References watch_sessions.id',
  `viewer_user_id` VARCHAR(50) NOT NULL COMMENT 'Server-verified viewer user_id for global velocity rate limits',
  `video_id` VARCHAR(64) NOT NULL COMMENT 'Server-verified video_id for per-video daily cap enforcement',
  `seq` INT UNSIGNED NOT NULL COMMENT 'Strictly increasing client sequence number within session',
  `idempotency_key` VARCHAR(100) NOT NULL COMMENT 'Unique client/chunk idempotency key preventing retry double-counting',
  `event_type` ENUM('heartbeat', 'pause', 'hidden', 'ended', 'unload') NOT NULL DEFAULT 'heartbeat',
  `watched_seconds` SMALLINT UNSIGNED NOT NULL COMMENT 'Server-validated positive seconds credited by this event',
  `position_seconds` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Player timestamp in seconds (untrusted metadata)',
  `client_event_at` DATETIME DEFAULT NULL COMMENT 'Clamped client event UTC timestamp for bounded offline retry auditing',
  `watch_date` DATE NOT NULL COMMENT 'Primary UTC date of segment end',
  `primary_date_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Seconds credited to watch_date',
  `split_prev_date` DATE DEFAULT NULL COMMENT 'Previous UTC date if playback crossed 00:00:00 UTC midnight',
  `split_prev_seconds` SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Seconds credited to split_prev_date',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_wte_session_seq` (`session_id`, `seq`),
  UNIQUE KEY `uniq_wte_idempotency` (`idempotency_key`),
  KEY `idx_wte_viewer_created` (`viewer_user_id`, `created_at`),
  KEY `idx_wte_viewer_video_date` (`viewer_user_id`, `video_id`, `watch_date`),
  KEY `idx_wte_created_at` (`created_at`),
  CONSTRAINT `fk_wte_session` FOREIGN KEY (`session_id`) REFERENCES `watch_sessions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 3. Table: video_watch_daily
-- Daily UTC rollup per video & creator for fast, accurate dashboard analytics.
-- Average View Duration = qualified_watched_seconds / qualified_sessions.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `video_watch_daily` (
  `watch_date` DATE NOT NULL COMMENT 'UTC calendar date',
  `creator_user_id` VARCHAR(50) NOT NULL COMMENT 'Video owner FaceTube user_id',
  `video_id` VARCHAR(64) NOT NULL COMMENT 'Target video ID from uploaded_videos.id',
  `total_watched_seconds` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Sum of all verified non-self playback seconds on watch_date',
  `qualified_watched_seconds` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Sum of verified non-self playback seconds belonging to qualified sessions (>= 3s)',
  `qualified_sessions` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Count of distinct non-self sessions crossing qualification threshold on watch_date',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`watch_date`, `video_id`),
  KEY `idx_vwd_creator_date` (`creator_user_id`, `watch_date`),
  KEY `idx_vwd_video_date` (`video_id`, `watch_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
