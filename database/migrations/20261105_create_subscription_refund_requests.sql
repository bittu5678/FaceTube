-- ==============================================================================
-- FaceTube - Database Migration: Paid Subscription Refund Requests & Auditing
-- Migration: 20261105_create_subscription_refund_requests.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Table: subscription_refund_requests
-- Stores user-initiated refund requests on creator memberships, administrative
-- review audit trails, and Razorpay gateway refund reconciliation details.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `subscription_refund_requests` (
  `id` VARCHAR(64) NOT NULL COMMENT 'Unique refund request identifier (e.g. rfnd_timestamp_hex)',
  `subscription_id` VARCHAR(64) NOT NULL COMMENT 'Target user subscription identifier',
  `user_id` VARCHAR(50) NOT NULL COMMENT 'FaceTube User ID of the requesting subscriber',
  `user_name` VARCHAR(255) DEFAULT NULL COMMENT 'Cached display name of user at request time',
  `user_email` VARCHAR(255) DEFAULT NULL COMMENT 'Contact email of user',
  `plan_id` VARCHAR(50) NOT NULL COMMENT 'Membership tier identifier',
  `plan_name` VARCHAR(100) DEFAULT NULL COMMENT 'Readable membership plan title',
  `payment_id` VARCHAR(100) NOT NULL COMMENT 'Authoritative Razorpay payment_id',
  `order_id` VARCHAR(100) NOT NULL COMMENT 'Authoritative Razorpay order_id',
  `amount` DECIMAL(10, 2) NOT NULL COMMENT 'Original subscription payment amount in currency',
  `currency` VARCHAR(10) NOT NULL DEFAULT 'INR' COMMENT 'Currency ISO code',
  `reason` TEXT NOT NULL COMMENT 'User-submitted refund explanation (5-1000 chars)',
  `status` ENUM('pending', 'approved', 'rejected', 'processing', 'refunded') NOT NULL DEFAULT 'pending' COMMENT 'Refund lifecycle status',
  `gateway_status` VARCHAR(50) NOT NULL DEFAULT 'manual_review_only' COMMENT 'Gateway reconciliation status',
  `gateway_refund_id` VARCHAR(100) DEFAULT NULL COMMENT 'Razorpay refund entity ID (rfnd_...) upon successful capture',
  `admin_note` TEXT DEFAULT NULL COMMENT 'Administrative review rationale or rejection note',
  `reviewed_by` VARCHAR(50) DEFAULT NULL COMMENT 'FaceTube User ID of the reviewing administrator',
  `reviewed_at` DATETIME DEFAULT NULL COMMENT 'Timestamp when administrative decision was finalized',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Request submission timestamp',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_sub_refund_payment_id` (`payment_id`),
  KEY `idx_sub_refund_user_id` (`user_id`),
  KEY `idx_sub_refund_sub_id` (`subscription_id`),
  KEY `idx_sub_refund_status` (`status`),
  KEY `idx_sub_refund_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
