-- ==============================================================================
-- FaceTube - Database Migration: AdSense Monthly Statement Idempotency & Zero-Data-Loss Backfill
-- Migration: 20261101_adsense_monthly_statements_idempotency.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- ==============================================================================
--
-- PURPOSE:
-- 1. Enforces strict production idempotency for NEW AdSense statements:
--    Exactly ONE monthly statement credit per creator per reporting month (YYYY-MM).
-- 2. Eliminates historical data-loss risk:
--    - Replaces blind `INSERT IGNORE` with a deterministic two-stage backfill.
--    - Every legitimate historical `income_ledger` record is 100% preserved.
--    - When multiple historical credits exist for the same creator and month,
--      the earliest baseline is registered in `adsense_monthly_statements`, and
--      ALL secondary/overlapping credits are captured in `adsense_historical_conflicts`.
--    - No financial amounts are altered, merged, or deleted automatically.
--
-- ------------------------------------------------------------------------------
-- 1. Diagnostic Checks for Historical Multi-Credit Records
-- ------------------------------------------------------------------------------
-- Run in phpMyAdmin before applying migration to view any affected user/months:
SELECT
  `user_id`,
  DATE_FORMAT(`created_at`, '%Y-%m') AS `report_month`,
  COUNT(*) AS `credit_count`,
  SUM(`amount`) AS `total_credited`,
  MIN(`created_at`) AS `earliest_credit_at`,
  MAX(`created_at`) AS `latest_credit_at`
FROM `income_ledger`
WHERE `income_type` = 'adsense_income'
GROUP BY `user_id`, DATE_FORMAT(`created_at`, '%Y-%m')
HAVING `credit_count` > 1;

-- Detailed transaction inspect for any multi-credit historical records:
SELECT
  l.`id` AS `ledger_id`,
  l.`transaction_id`,
  l.`user_id`,
  DATE_FORMAT(l.`created_at`, '%Y-%m') AS `report_month`,
  l.`amount`,
  l.`special_tag`,
  l.`description`,
  l.`created_at`
FROM `income_ledger` l
INNER JOIN (
  SELECT `user_id`, DATE_FORMAT(`created_at`, '%Y-%m') AS `rmonth`
  FROM `income_ledger`
  WHERE `income_type` = 'adsense_income'
  GROUP BY `user_id`, DATE_FORMAT(`created_at`, '%Y-%m')
  HAVING COUNT(*) > 1
) conflicts
  ON l.`user_id` = conflicts.`user_id`
 AND DATE_FORMAT(l.`created_at`, '%Y-%m') = conflicts.`rmonth`
WHERE l.`income_type` = 'adsense_income'
ORDER BY l.`user_id`, l.`created_at` ASC;

-- ------------------------------------------------------------------------------
-- 2. Dedicated Production Table: adsense_monthly_statements
-- ------------------------------------------------------------------------------
-- Enforces production idempotency: exactly one statement per creator per month.
CREATE TABLE IF NOT EXISTS `adsense_monthly_statements` (
  `id` VARCHAR(64) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `report_month` VARCHAR(7) NOT NULL, -- Format: YYYY-MM
  `amount` DECIMAL(14, 4) NOT NULL,
  `reference_id` VARCHAR(100) NOT NULL,
  `transaction_id` VARCHAR(100) NOT NULL,
  `recorded_by` VARCHAR(50) NOT NULL,
  `video_id` VARCHAR(100) DEFAULT NULL,
  `description` TEXT NOT NULL,
  `status` ENUM('settled', 'cancelled') NOT NULL DEFAULT 'settled',
  `has_conflicts` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_adsense_user_month` (`user_id`, `report_month`),
  UNIQUE KEY `uniq_adsense_statement_tx_id` (`transaction_id`),
  KEY `idx_adsense_user_id` (`user_id`),
  KEY `idx_adsense_report_month` (`report_month`),
  KEY `idx_adsense_has_conflicts` (`has_conflicts`),
  KEY `idx_adsense_created_at` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 3. Dedicated Audit & Reconciliation Table: adsense_historical_conflicts
-- ------------------------------------------------------------------------------
-- Preserves ALL secondary or overlapping historical AdSense credits without data loss.
CREATE TABLE IF NOT EXISTS `adsense_historical_conflicts` (
  `id` VARCHAR(64) NOT NULL,
  `ledger_id` VARCHAR(64) NOT NULL,
  `transaction_id` VARCHAR(100) NOT NULL,
  `user_id` VARCHAR(50) NOT NULL,
  `report_month` VARCHAR(7) NOT NULL, -- Format: YYYY-MM
  `amount` DECIMAL(14, 4) NOT NULL,
  `primary_statement_tx_id` VARCHAR(100) DEFAULT NULL,
  `conflict_type` ENUM('multi_credit_same_month', 'manual_adjustment', 'unmatched_statement_date') NOT NULL DEFAULT 'multi_credit_same_month',
  `conflict_reason` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `source_user_id` VARCHAR(50) DEFAULT NULL,
  `video_id` VARCHAR(100) DEFAULT NULL,
  `status` ENUM('flagged_for_review', 'reconciled_valid_split', 'confirmed_duplicate_reversed', 'approved_exception') NOT NULL DEFAULT 'flagged_for_review',
  `resolution_notes` TEXT DEFAULT NULL,
  `reviewed_by` VARCHAR(50) DEFAULT NULL,
  `reviewed_at` DATETIME DEFAULT NULL,
  `ledger_created_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ads_conflict_tx_id` (`transaction_id`),
  KEY `idx_ads_conflict_user_month` (`user_id`, `report_month`),
  KEY `idx_ads_conflict_status` (`status`),
  KEY `idx_ads_conflict_ledger_id` (`ledger_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------------
-- 4. Safe Two-Stage Backfill (Zero Data Loss, No INSERT IGNORE)
-- ------------------------------------------------------------------------------

-- Stage 4A: Backfill exactly ONE primary/earliest statement per (user_id, report_month).
-- Guaranteed unique by subquery grouping on (user_id, report_month).
INSERT INTO `adsense_monthly_statements` (
  `id`, `user_id`, `report_month`, `amount`, `reference_id`,
  `transaction_id`, `recorded_by`, `video_id`, `description`, `status`, `has_conflicts`, `created_at`
)
SELECT
  CONCAT('ads-mig-', SUBSTRING(MD5(l.`id`), 1, 16)),
  l.`user_id`,
  DATE_FORMAT(l.`created_at`, '%Y-%m') AS `report_month`,
  l.`amount`,
  CONCAT('ADS-', DATE_FORMAT(l.`created_at`, '%Y%m'), '-MIGRATED'),
  l.`transaction_id`,
  COALESCE(l.`source_user_id`, 'SYSTEM'),
  l.`video_id`,
  l.`description`,
  'settled',
  CASE WHEN conflicts.`cnt` > 1 THEN 1 ELSE 0 END AS `has_conflicts`,
  l.`created_at`
FROM `income_ledger` l
INNER JOIN (
  -- Deterministically pick the earliest record for each user & report month
  SELECT
    `user_id`,
    DATE_FORMAT(`created_at`, '%Y-%m') AS `rmonth`,
    MIN(`id`) AS `earliest_id`,
    COUNT(*) AS `cnt`
  FROM `income_ledger`
  WHERE `income_type` = 'adsense_income'
  GROUP BY `user_id`, DATE_FORMAT(`created_at`, '%Y-%m')
) conflicts
  ON l.`id` = conflicts.`earliest_id`
WHERE l.`income_type` = 'adsense_income'
ON DUPLICATE KEY UPDATE
  `transaction_id` = VALUES(`transaction_id`),
  `has_conflicts` = VALUES(`has_conflicts`);

-- Stage 4B: Capture EVERY secondary/overlapping historical record in adsense_historical_conflicts.
-- Zero records are discarded. All financial metadata, original IDs, and amounts are preserved.
INSERT INTO `adsense_historical_conflicts` (
  `id`, `ledger_id`, `transaction_id`, `user_id`, `report_month`,
  `amount`, `primary_statement_tx_id`, `conflict_type`, `conflict_reason`,
  `description`, `source_user_id`, `video_id`, `status`, `ledger_created_at`, `created_at`
)
SELECT
  CONCAT('ads-conf-', SUBSTRING(MD5(l.`id`), 1, 16)),
  l.`id`,
  l.`transaction_id`,
  l.`user_id`,
  DATE_FORMAT(l.`created_at`, '%Y-%m') AS `report_month`,
  l.`amount`,
  prim.`transaction_id` AS `primary_statement_tx_id`,
  'multi_credit_same_month',
  'Secondary historical credit detected for same creator and month; preserved without alteration for manual audit',
  l.`description`,
  l.`source_user_id`,
  l.`video_id`,
  'flagged_for_review',
  l.`created_at`,
  NOW()
FROM `income_ledger` l
INNER JOIN (
  -- Identify users and months that had more than one credit
  SELECT
    `user_id`,
    DATE_FORMAT(`created_at`, '%Y-%m') AS `rmonth`,
    MIN(`id`) AS `earliest_id`
  FROM `income_ledger`
  WHERE `income_type` = 'adsense_income'
  GROUP BY `user_id`, DATE_FORMAT(`created_at`, '%Y-%m')
  HAVING COUNT(*) > 1
) multi
  ON l.`user_id` = multi.`user_id`
 AND DATE_FORMAT(l.`created_at`, '%Y-%m') = multi.`rmonth`
 AND l.`id` != multi.`earliest_id`
LEFT JOIN `income_ledger` prim
  ON prim.`id` = multi.`earliest_id`
WHERE l.`income_type` = 'adsense_income'
ON DUPLICATE KEY UPDATE `status` = VALUES(`status`);

-- ------------------------------------------------------------------------------
-- 5. Post-Migration Audit & Reconciliation Query (Run in phpMyAdmin)
-- ------------------------------------------------------------------------------
-- Lists all flagged historical items requiring administrator verification:
SELECT
  c.`id` AS `conflict_record_id`,
  c.`user_id`,
  c.`report_month`,
  c.`transaction_id` AS `conflicting_tx_id`,
  c.`amount` AS `conflicting_amount`,
  c.`primary_statement_tx_id`,
  c.`status`,
  c.`conflict_reason`,
  c.`ledger_created_at`
FROM `adsense_historical_conflicts` c
WHERE c.`status` = 'flagged_for_review'
ORDER BY c.`user_id`, c.`report_month`, c.`ledger_created_at` ASC;

-- ------------------------------------------------------------------------------
-- 6. Safe Administrative Reconciliation Guide:
-- ------------------------------------------------------------------------------
-- To reconcile a flagged historical conflict:
-- Case A: Valid split or legitimate bonus payout:
--   UPDATE `adsense_historical_conflicts`
--   SET `status` = 'reconciled_valid_split',
--       `resolution_notes` = 'Verified legitimate separate payout by administrator',
--       `reviewed_by` = 'ADMIN_USER_ID',
--       `reviewed_at` = NOW()
--   WHERE `transaction_id` = 'TX_CONFLICT_ID';
--
-- Case B: Accidental historical duplicate requiring reversal:
--   Do NOT delete rows from income_ledger!
--   Create an explicit reversing ledger entry with income_type = 'adsense_income'
--   and negative or withdrawal amount, update wallet_balances accordingly, then:
--   UPDATE `adsense_historical_conflicts`
--   SET `status` = 'confirmed_duplicate_reversed',
--       `resolution_notes` = 'Duplicate confirmed and reversed via adjustment entry',
--       `reviewed_by` = 'ADMIN_USER_ID',
--       `reviewed_at` = NOW()
--   WHERE `transaction_id` = 'TX_CONFLICT_ID';
