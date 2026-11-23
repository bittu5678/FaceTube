-- ==============================================================================
-- FaceTube - Database Migration: Seed Health, Sports & Drama Video Categories
-- Migration: 20261127_seed_health_sports_drama_categories.sql
-- Status: PENDING USER APPROVAL - DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Target Categories: Health, Sports, Drama
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Collation & Duplicate-Name Safety:
-- 1. Database table `categories` uses `utf8mb4_unicode_ci` (case-insensitive).
-- 2. Unique keys `uniq_categories_name` and `uniq_categories_slug` prevent duplicate
--    entries at the schema level.
-- 3. `INSERT IGNORE` ensures this script is completely idempotent and preserves
--    existing category IDs and records without risking failure.
-- ------------------------------------------------------------------------------

INSERT IGNORE INTO `categories` (`name`, `slug`, `created_by`) VALUES
  ('Health', 'health', 'SYSTEM'),
  ('Sports', 'sports', 'SYSTEM'),
  ('Drama', 'drama', 'SYSTEM');
