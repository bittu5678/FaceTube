-- ==============================================================================
-- FaceTube - Database Migration: Global Pool Pending Reserve & Idempotent Settlement
-- Migration: 20261125_global_pool_reserve_and_settlement.sql (Phase 1.1)
-- Purpose:
--   1. Add explicit Global Pool breakdown columns on payment_transactions and
--      premium_transactions (global_pool_distributed, global_pool_reserve, global_pool_status)
--      so every ₹6.00 premium transaction strictly records:
--      Referral ₹1.00 + Admin ₹1.00 + GST ₹0.90 + PG ₹0.10 + Global Pool ₹3.00 = ₹6.00.
--   2. Create global_pool_reserves and global_pool_settlements tables to hold
--      unallocated ₹3.00 pools (when 0 eligible videos exist) and integer-paise
--      rounding residuals safely in pending reserve until an idempotent, locked,
--      auditable settlement batch distributes them when eligible videos exist.
--   3. Preserves all historical production rows and wallet/ledger balances untouched.
-- ==============================================================================

SET @db := DATABASE();

-- 1. payment_transactions.global_pool_distributed
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'global_pool_distributed'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `global_pool_distributed` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_allocation`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. payment_transactions.global_pool_reserve
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'global_pool_reserve'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `global_pool_reserve` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_distributed`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. payment_transactions.global_pool_status
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'payment_transactions' AND COLUMN_NAME = 'global_pool_status'
    ),
    'SELECT 1',
    'ALTER TABLE `payment_transactions` ADD COLUMN `global_pool_status` VARCHAR(32) NOT NULL DEFAULT ''not_applicable'' AFTER `global_pool_reserve`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. premium_transactions.global_pool_distributed
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'global_pool_distributed'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `global_pool_distributed` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_allocation`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. premium_transactions.global_pool_reserve
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'global_pool_reserve'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `global_pool_reserve` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER `global_pool_distributed`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. premium_transactions.global_pool_status
SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'premium_transactions' AND COLUMN_NAME = 'global_pool_status'
    ),
    'SELECT 1',
    'ALTER TABLE `premium_transactions` ADD COLUMN `global_pool_status` VARCHAR(32) NOT NULL DEFAULT ''not_applicable'' AFTER `global_pool_reserve`'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 7. Table: global_pool_reserves
-- Holds pending ₹3.00 pools (no eligible videos) and integer-paise rounding residuals.
CREATE TABLE IF NOT EXISTS `global_pool_reserves` (
  `id` VARCHAR(64) NOT NULL,
  `payment_id` VARCHAR(100) NOT NULL,
  `order_id` VARCHAR(100) DEFAULT NULL,
  `tx_number` BIGINT NOT NULL DEFAULT 0,
  `source_user_id` VARCHAR(50) NOT NULL,
  `source_video_id` VARCHAR(100) DEFAULT NULL,
  `reserve_amount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `reserve_paise` INT NOT NULL DEFAULT 0,
  `reserve_reason` ENUM('no_eligible_videos', 'rounding_residual') NOT NULL DEFAULT 'no_eligible_videos',
  `status` ENUM('pending', 'settled', 'cancelled') NOT NULL DEFAULT 'pending',
  `settled_batch_id` VARCHAR(64) DEFAULT NULL,
  `settled_at` DATETIME DEFAULT NULL,
  `settled_by` VARCHAR(50) DEFAULT NULL,
  `notes` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_gpr_payment_id` (`payment_id`),
  KEY `idx_gpr_status` (`status`),
  KEY `idx_gpr_tx_number` (`tx_number`),
  KEY `idx_gpr_settled_batch` (`settled_batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Table: global_pool_settlements
-- Immutable audit batches for idempotent settlement of pending Global Pool reserves.
CREATE TABLE IF NOT EXISTS `global_pool_settlements` (
  `id` VARCHAR(64) NOT NULL,
  `idempotency_key` VARCHAR(100) DEFAULT NULL,
  `total_reserve_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `distributed_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `carry_forward_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  `reserve_count` INT NOT NULL DEFAULT 0,
  `eligible_video_count` INT NOT NULL DEFAULT 0,
  `payout_count` INT NOT NULL DEFAULT 0,
  `settled_by` VARCHAR(50) NOT NULL,
  `notes` TEXT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_gps_idempotency` (`idempotency_key`),
  KEY `idx_gps_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
