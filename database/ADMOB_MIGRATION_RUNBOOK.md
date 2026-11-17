# FaceTube AdMob Database Migration Runbook

## 1. Backup & Database Privileges (Mandatory Before Running)

1. **Create a full logical backup** before executing any migration:
   ```bash
   mysqldump --single-transaction --routines --triggers -u <DB_USER> -p <DB_NAME> > backup_before_admob_migrations_$(date +%F_%H%M%S).sql
   ```
2. **Required MySQL privileges** on `<DB_NAME>`:
   - `CREATE`, `ALTER`, `INDEX`, `SELECT`, `INSERT` (plus standard `INFORMATION_SCHEMA` read access).
   - Target compatibility: Oracle MySQL 5.7 / 8.0 / 8.4 LTS or MariaDB.

---

## 2. Required Existing Tables & Columns (Prerequisites)

Confirm these baseline tables/columns already exist before applying the AdMob migrations:

- `users` (`user_id`, `role`) and `sessions` (`token`, `user_id`, `expires_at`) from baseline schema.
- `income_ledger` with `income_type` ENUM already including `adsense_income`, `ad_boost_income`, `affiliate_income`, and `marketing_income` (applied by `20261031_income_sources_and_platform_settings.sql` and `20261102_affiliate_marketing_foundation.sql`) so `20261108` does not narrow existing ENUM values.
- `wallet_balances` containing `adsense_income` (required because `20261112` adds `admob_income` `AFTER adsense_income`).

_(If using AdMob OAuth credential storage, also ensure `20261109_admob_oauth_credentials.sql`, `20261110_admob_oauth_states.sql`, and `20261111_admob_oauth_states_admin_session_hash.sql` are applied.)_

---

## 3. Exact Execution Order & Dependency Rationale

Apply the AdMob income migrations in **strict chronological order**:

1. `database/migrations/20261108_admob_income_foundation.sql`
   - Expands `income_ledger.income_type` ENUM to include `'admob_income'`.
   - Creates `admob_monthly_statements` with `app_id VARCHAR(100) DEFAULT NULL`, `UNIQUE KEY uniq_admob_statement_user_month (user_id, report_month)`, and `UNIQUE KEY uniq_admob_statement_id (statement_id)`.
2. `database/migrations/20261112_wallet_balances_admob_income.sql`
   - Idempotently adds `wallet_balances.admob_income DECIMAL(14, 2) NOT NULL DEFAULT 0.00 AFTER adsense_income` using `INFORMATION_SCHEMA.COLUMNS`.
3. `database/migrations/20261113_admob_statements_remove_test_app_id_default.sql`
   - **Why `20261113` depends on `20261108`:** `20261113` inspects `INFORMATION_SCHEMA.TABLES` and `INFORMATION_SCHEMA.COLUMNS` for `admob_monthly_statements.app_id` (created by `20261108`) and alters it to `VARCHAR(100) DEFAULT NULL` if an earlier draft left it `NOT NULL`, defaulted, or referencing the test ID `3940256099942544`. If `20261113` were executed before `20261108`, `@tbl_exists` would be `0` and the check would silently no-op.

---

## 4. Verification Queries (Run After Each Migration)

### After `20261108_admob_income_foundation.sql`

```sql
SHOW COLUMNS FROM income_ledger LIKE 'income_type';
SHOW CREATE TABLE admob_monthly_statements;
```

Confirm `'admob_income'` appears in `income_type`, `app_id` is `varchar(100) DEFAULT NULL`, and unique keys `uniq_admob_statement_user_month` and `uniq_admob_statement_id` exist.

### After `20261112_wallet_balances_admob_income.sql`

```sql
SHOW COLUMNS FROM wallet_balances LIKE 'admob_income';
```

Confirm `admob_income` is `decimal(14,2)`, `Null = NO`, `Default = 0.00`.

### After `20261113_admob_statements_remove_test_app_id_default.sql`

```sql
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'admob_monthly_statements'
  AND COLUMN_NAME = 'app_id';
```

Confirm `IS_NULLABLE = 'YES'` and `COLUMN_DEFAULT IS NULL`.
