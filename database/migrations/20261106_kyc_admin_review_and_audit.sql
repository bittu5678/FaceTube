-- ==============================================================================
-- FaceTube - Database Migration: Secure Admin KYC Review & Audit History
-- Migration: 20261106_kyc_admin_review_and_audit.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: personal_kyc - Review & Audit Columns
-- Add administrative reviewer identification, timestamps, and decision notes
-- ------------------------------------------------------------------------------
ALTER TABLE `personal_kyc`
  ADD COLUMN IF NOT EXISTS `reviewed_by` VARCHAR(50) DEFAULT NULL COMMENT 'FaceTube User ID of the reviewing administrator' AFTER `status`,
  ADD COLUMN IF NOT EXISTS `reviewed_at` DATETIME DEFAULT NULL COMMENT 'Timestamp when KYC decision was finalized' AFTER `reviewed_by`,
  ADD COLUMN IF NOT EXISTS `admin_note` TEXT DEFAULT NULL COMMENT 'Internal administrative note regarding the submission' AFTER `reviewed_at`,
  ADD COLUMN IF NOT EXISTS `rejection_reason` TEXT DEFAULT NULL COMMENT 'Mandatory explanation provided to creator if rejected' AFTER `admin_note`;

-- ------------------------------------------------------------------------------
-- 2. Table: bank_kyc - Review & Audit Columns
-- Add administrative reviewer identification, timestamps, and decision notes
-- ------------------------------------------------------------------------------
ALTER TABLE `bank_kyc`
  ADD COLUMN IF NOT EXISTS `reviewed_by` VARCHAR(50) DEFAULT NULL COMMENT 'FaceTube User ID of the reviewing administrator' AFTER `status`,
  ADD COLUMN IF NOT EXISTS `reviewed_at` DATETIME DEFAULT NULL COMMENT 'Timestamp when KYC decision was finalized' AFTER `reviewed_by`,
  ADD COLUMN IF NOT EXISTS `admin_note` TEXT DEFAULT NULL COMMENT 'Internal administrative note regarding the submission' AFTER `reviewed_at`,
  ADD COLUMN IF NOT EXISTS `rejection_reason` TEXT DEFAULT NULL COMMENT 'Mandatory explanation provided to creator if rejected' AFTER `admin_note`;

-- ------------------------------------------------------------------------------
-- 3. Table: kyc_audit_log
-- Immutable audit ledger logging all KYC status transitions, reviewer actions,
-- administrative notes, and timestamps.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `kyc_audit_log` (
  `id` VARCHAR(64) NOT NULL COMMENT 'Unique audit entry identifier (e.g. kyc_audit_timestamp_hex)',
  `kyc_type` ENUM('personal', 'bank') NOT NULL COMMENT 'Type of KYC submission under review',
  `kyc_id` VARCHAR(64) DEFAULT NULL COMMENT 'Primary key of personal_kyc or bank_kyc record',
  `user_id` VARCHAR(50) NOT NULL COMMENT 'FaceTube User ID of the creator whose KYC was reviewed',
  `action` ENUM('approved', 'rejected') NOT NULL COMMENT 'Administrative decision taken',
  `previous_status` VARCHAR(50) NOT NULL COMMENT 'Status before review (must be Submitted)',
  `new_status` VARCHAR(50) NOT NULL COMMENT 'Status after review (Verified or Rejected)',
  `admin_note` TEXT DEFAULT NULL COMMENT 'Administrative review note',
  `rejection_reason` TEXT DEFAULT NULL COMMENT 'Explanation provided if rejected',
  `reviewed_by` VARCHAR(50) NOT NULL COMMENT 'FaceTube User ID of the reviewing administrator',
  `reviewed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Timestamp of review action',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Log creation timestamp',
  PRIMARY KEY (`id`),
  KEY `idx_kyc_audit_user_id` (`user_id`),
  KEY `idx_kyc_audit_type` (`kyc_type`),
  KEY `idx_kyc_audit_action` (`action`),
  KEY `idx_kyc_audit_reviewed_by` (`reviewed_by`),
  KEY `idx_kyc_audit_created` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
