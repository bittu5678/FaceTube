-- ==============================================================================
-- FaceTube - Database Migration: Seed Company-Requested Video Categories
-- Migration: 20261103_seed_requested_categories.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Target Categories: Music, Gaming, Travel, AI, Education
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Collation & Duplicate-Name Safety:
-- 1. Database table `categories` uses `utf8mb4_unicode_ci` (case-insensitive).
-- 2. Unique keys `uniq_categories_name` and `uniq_categories_slug` prevent duplicate
--    entries at the schema level.
-- 3. `INSERT IGNORE` ensures this script is completely idempotent and safe to run
--    or re-run without risking failure or modifying existing categories.
-- ------------------------------------------------------------------------------

INSERT IGNORE INTO `categories` (`name`, `slug`, `created_by`) VALUES
  ('Music', 'music', 'SYSTEM'),
  ('Gaming', 'gaming', 'SYSTEM'),
  ('Travel', 'travel', 'SYSTEM'),
  ('AI', 'ai', 'SYSTEM'),
  ('Education', 'education', 'SYSTEM');
