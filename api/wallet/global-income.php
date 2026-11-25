<?php
/**
 * FaceTube - Authoritative Global Income Summary API
 * GET /api/wallet/global-income.php
 *
 * Strictly read-only, authenticated endpoint returning personal income totals
 * (wallet_balances authoritative with settled income_ledger cross-check/fallback)
 * and platform-level Sponsor Video accounting metrics verified against successful
 * payment records, immediate distributions, settlement batches, and reserves.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|max_user_connections|too many user connections|server shutdown in progress|host .* is blocked|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
};

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$roundMoney = static function ($val): float {
    if ($val === null || $val === '') {
        return 0.0;
    }
    $num = floatval($val);
    return is_finite($num) ? round($num, 2) : 0.0;
};

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    error_log('[wallet/global-income.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable during authentication check.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error during authentication check.'
    ], 500);
}

if (!$authUser || empty($authUser['user_id'])) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

$rawRequestedUserId = $readStringField($_GET['userId'] ?? ($_GET['user_id'] ?? ''));
$authPublicId = trim((string)$authUser['user_id']);
$authInternalId = trim((string)($authUser['id'] ?? ''));

if ($rawRequestedUserId === '') {
    $targetUserId = $authPublicId;
} elseif (
    strcasecmp($rawRequestedUserId, $authPublicId) === 0 ||
    ($authInternalId !== '' && strcasecmp($rawRequestedUserId, $authInternalId) === 0)
) {
    $targetUserId = $authPublicId;
} else {
    $isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
    if (!$isAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cross-user access is restricted to verified administrators.'
        ], 403);
    }
    $targetUserId = strtoupper($rawRequestedUserId);
}

try {
    // 1. INFORMATION_SCHEMA table guards
    $tableStmt = $pdo->query("
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (
              'payment_orders',
              'global_pool_reserves',
              'global_pool_settlements',
              'payment_transactions',
              'income_ledger',
              'wallet_balances',
              'uploaded_videos'
          )
    ");
    $existingTables = [];
    if ($tableStmt !== false) {
        foreach ($tableStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $tName = strtolower(trim((string)($row['TABLE_NAME'] ?? '')));
            if ($tName !== '') {
                $existingTables[$tName] = true;
            }
        }
    }

    $hasPaymentOrdersTable = isset($existingTables['payment_orders']);
    $hasReservesTable = isset($existingTables['global_pool_reserves']);
    $hasSettlementsTable = isset($existingTables['global_pool_settlements']);
    $hasPaymentTransactionsTable = isset($existingTables['payment_transactions']);
    $hasIncomeLedgerTable = isset($existingTables['income_ledger']);
    $hasWalletBalancesTable = isset($existingTables['wallet_balances']);
    $hasUploadedVideosTable = isset($existingTables['uploaded_videos']);

    // 2. INFORMATION_SCHEMA column guards
    $colStmt = $pdo->query("
        SELECT TABLE_NAME, COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
              (TABLE_NAME = 'payment_transactions' AND COLUMN_NAME IN ('status', 'gst_amount', 'pg_fee', 'global_pool_distributed', 'global_pool_status'))
              OR (TABLE_NAME = 'uploaded_videos' AND COLUMN_NAME = 'is_blocked')
          )
    ");
    $ptCols = [];
    $uvCols = [];
    if ($colStmt !== false) {
        foreach ($colStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $tbl = strtolower(trim((string)($row['TABLE_NAME'] ?? '')));
            $col = strtolower(trim((string)($row['COLUMN_NAME'] ?? '')));
            if ($tbl === 'payment_transactions' && $col !== '') {
                $ptCols[$col] = true;
            } elseif ($tbl === 'uploaded_videos' && $col !== '') {
                $uvCols[$col] = true;
            }
        }
    }

    $hasPtStatusCol = isset($ptCols['status']);
    $hasPtTaxCols = isset($ptCols['gst_amount']) && isset($ptCols['pg_fee']);
    $hasPtPoolCols = isset($ptCols['global_pool_distributed']) && isset($ptCols['global_pool_status']);
    $hasVideoBlockedCol = isset($uvCols['is_blocked']);

    // 3. Personal income aggregation (read-only)
    $hasWalletRow = false;
    $walletTotalEarned = 0.0;
    $walletGlobalIncome = 0.0;
    $balance = 0.0;
    $totalWithdrawn = 0.0;

    if ($hasWalletBalancesTable) {
        $wStmt = $pdo->prepare("
            SELECT user_id, balance, total_earned, total_withdrawn, global_income
            FROM wallet_balances
            WHERE UPPER(user_id) = UPPER(?)
            LIMIT 1
        ");
        $wStmt->execute([$targetUserId]);
        $walletRow = $wStmt->fetch(PDO::FETCH_ASSOC);
        if ($walletRow) {
            $hasWalletRow = true;
            $balance = $roundMoney($walletRow['balance'] ?? 0);
            $walletTotalEarned = $roundMoney($walletRow['total_earned'] ?? 0);
            $totalWithdrawn = $roundMoney($walletRow['total_withdrawn'] ?? 0);
            $walletGlobalIncome = $roundMoney($walletRow['global_income'] ?? 0);
        }
    }

    $ledgerTotalEarned = 0.0;
    $ledgerGlobalIncome = 0.0;
    $globalTxCount = 0;

    if ($hasIncomeLedgerTable) {
        $lStmt = $pdo->prepare("
            SELECT
                ROUND(COALESCE(SUM(CASE
                    WHEN COALESCE(income_type, '') NOT IN ('withdrawal', 'ads_promotion_fee')
                    THEN amount ELSE 0 END), 0), 2) AS ledger_total_earned,
                ROUND(COALESCE(SUM(CASE
                    WHEN income_type = 'global_income'
                    THEN amount ELSE 0 END), 0), 2) AS ledger_global_income,
                COUNT(CASE
                    WHEN income_type = 'global_income'
                    THEN 1 ELSE NULL END) AS global_tx_count
            FROM income_ledger
            WHERE UPPER(user_id) = UPPER(?)
              AND status = 'settled'
        ");
        $lStmt->execute([$targetUserId]);
        $lRow = $lStmt->fetch(PDO::FETCH_ASSOC);
        if ($lRow) {
            $ledgerTotalEarned = $roundMoney($lRow['ledger_total_earned'] ?? 0);
            $ledgerGlobalIncome = $roundMoney($lRow['ledger_global_income'] ?? 0);
            $globalTxCount = intval($lRow['global_tx_count'] ?? 0);
        }
    }

    if ($hasWalletRow) {
        $personalTotalIncome = $walletTotalEarned;
        $personalGlobalIncome = $walletGlobalIncome;
        $personalSource = 'wallet_balances';
        $walletVsLedgerDiff = round($walletTotalEarned - $ledgerTotalEarned, 2);
    } else {
        $personalTotalIncome = $ledgerTotalEarned;
        $personalGlobalIncome = $ledgerGlobalIncome;
        $personalSource = 'income_ledger_fallback';
        $walletVsLedgerDiff = 0.0;
    }

    // 4. Platform Sponsor Video transaction summary (strict successful-payment verification + deduplication)
    $totalPremiumTransactions = 0;
    $totalTransactionAmount = 0.0;
    $referralAllocationTotal = 0.0;
    $adminAllocationTotal = 0.0;
    $gstTotal = 0.0;
    $pgFeeTotal = 0.0;
    $globalPoolAllocationTotal = 0.0;
    $immediateGlobalPoolDistributedTotal = 0.0;

    if ($hasPaymentTransactionsTable) {
        $caseJoinSql = '';
        $caseWhereSql = '';

        if ($hasPaymentOrdersTable) {
            // Case A: payment_orders exists -> require paid order matching order_id, purpose, and payment_id (when set on order)
            $caseJoinSql = "
                INNER JOIN payment_orders po
                    ON pt_in.order_id IS NOT NULL
                   AND TRIM(pt_in.order_id) != ''
                   AND po.order_id = pt_in.order_id
                   AND LOWER(TRIM(po.status)) = 'paid'
                   AND po.purpose = 'premium_video_upload'
                   AND (po.payment_id IS NULL OR TRIM(po.payment_id) = '' OR TRIM(po.payment_id) = TRIM(pt_in.payment_id))
            ";
            if ($hasPtStatusCol) {
                $caseWhereSql = " AND LOWER(TRIM(COALESCE(pt_in.status, ''))) IN ('paid', 'settled', 'captured', 'completed', 'success')";
            }
        } elseif ($hasPtStatusCol) {
            // Case B1: payment_orders absent, payment_transactions.status exists
            $caseWhereSql = " AND LOWER(TRIM(COALESCE(pt_in.status, ''))) IN ('paid', 'settled', 'captured', 'completed', 'success')";
        } else {
            // Case B2: neither payment_orders nor payment_transactions.status exists -> require settled ledger or paid uploaded_videos proof
            $proofClauses = [];
            if ($hasIncomeLedgerTable) {
                $proofClauses[] = "EXISTS (
                    SELECT 1 FROM income_ledger il
                    WHERE il.status = 'settled'
                      AND il.amount > 0
                      AND (
                          il.transaction_id = CONCAT('TX_ADM_', TRIM(pt_in.payment_id))
                          OR il.transaction_id = CONCAT('TX_REF_', TRIM(pt_in.payment_id))
                          OR LEFT(il.transaction_id, CHAR_LENGTH(CONCAT('TX_GLB_', TRIM(pt_in.payment_id), '_'))) = CONCAT('TX_GLB_', TRIM(pt_in.payment_id), '_')
                      )
                )";
            }
            if ($hasUploadedVideosTable) {
                $proofClauses[] = "EXISTS (
                    SELECT 1 FROM uploaded_videos uv
                    WHERE uv.payment_id IS NOT NULL
                      AND TRIM(uv.payment_id) = TRIM(pt_in.payment_id)
                      AND LOWER(TRIM(uv.payment_status)) = 'paid'
                )";
            }
            if (count($proofClauses) > 0) {
                $caseWhereSql = ' AND (' . implode(' OR ', $proofClauses) . ')';
            } else {
                $caseWhereSql = ' AND 1 = 0';
            }
        }

        $historical6FallbackCondition = "
            ABS(COALESCE(pt.amount, 0.00) - 6.00) <= 0.005
            AND ABS((COALESCE(pt.amount, 0.00) - (COALESCE(pt.referral_commission, 0.00) + COALESCE(pt.admin_allocation, 0.00) + COALESCE(pt.global_pool_allocation, 0.00))) - 1.00) <= 0.005
        ";

        if ($hasPtTaxCols) {
            $gstExpr = "
                CASE
                    WHEN COALESCE(pt.gst_amount, 0.00) > 0 OR COALESCE(pt.pg_fee, 0.00) > 0
                        THEN COALESCE(pt.gst_amount, 0.00)
                    WHEN {$historical6FallbackCondition}
                        THEN 0.90
                    ELSE 0.00
                END
            ";
            $pgExpr = "
                CASE
                    WHEN COALESCE(pt.gst_amount, 0.00) > 0 OR COALESCE(pt.pg_fee, 0.00) > 0
                        THEN COALESCE(pt.pg_fee, 0.00)
                    WHEN {$historical6FallbackCondition}
                        THEN 0.10
                    ELSE 0.00
                END
            ";
        } else {
            $gstExpr = "
                CASE
                    WHEN {$historical6FallbackCondition}
                        THEN 0.90
                    ELSE 0.00
                END
            ";
            $pgExpr = "
                CASE
                    WHEN {$historical6FallbackCondition}
                        THEN 0.10
                    ELSE 0.00
                END
            ";
        }

        if ($hasPtPoolCols) {
            $immediatePoolExpr = "
                CASE
                    WHEN COALESCE(NULLIF(TRIM(pt.global_pool_status), ''), 'not_applicable') = 'not_applicable'
                        THEN COALESCE(pt.global_pool_allocation, 0.00)
                    ELSE COALESCE(pt.global_pool_distributed, 0.00)
                END
            ";
        } else {
            $immediatePoolExpr = "COALESCE(pt.global_pool_allocation, 0.00)";
        }

        $ptSql = "
            SELECT
                COUNT(*) AS total_premium_transactions,
                ROUND(COALESCE(SUM(COALESCE(pt.amount, 0.00)), 0), 2) AS total_transaction_amount,
                ROUND(COALESCE(SUM(COALESCE(pt.referral_commission, 0.00)), 0), 2) AS referral_allocation_total,
                ROUND(COALESCE(SUM(COALESCE(pt.admin_allocation, 0.00)), 0), 2) AS admin_allocation_total,
                ROUND(COALESCE(SUM({$gstExpr}), 0), 2) AS gst_total,
                ROUND(COALESCE(SUM({$pgExpr}), 0), 2) AS pg_fee_total,
                ROUND(COALESCE(SUM(COALESCE(pt.global_pool_allocation, 0.00)), 0), 2) AS global_pool_allocation_total,
                ROUND(COALESCE(SUM({$immediatePoolExpr}), 0), 2) AS immediate_global_pool_distributed_total
            FROM payment_transactions pt
            INNER JOIN (
                SELECT MIN(pt_in.id) AS first_id
                FROM payment_transactions pt_in
                {$caseJoinSql}
                WHERE pt_in.purpose = 'premium_video_upload'
                  AND pt_in.payment_id IS NOT NULL
                  AND TRIM(pt_in.payment_id) != ''
                  AND COALESCE(pt_in.amount, 0.00) > 0
                  {$caseWhereSql}
                GROUP BY TRIM(pt_in.payment_id)
            ) uniq_tx ON pt.id = uniq_tx.first_id
        ";
        $ptStmt = $pdo->query($ptSql);
        $ptRow = $ptStmt ? $ptStmt->fetch(PDO::FETCH_ASSOC) : null;
        if ($ptRow) {
            $totalPremiumTransactions = intval($ptRow['total_premium_transactions'] ?? 0);
            $totalTransactionAmount = $roundMoney($ptRow['total_transaction_amount'] ?? 0);
            $referralAllocationTotal = $roundMoney($ptRow['referral_allocation_total'] ?? 0);
            $adminAllocationTotal = $roundMoney($ptRow['admin_allocation_total'] ?? 0);
            $gstTotal = $roundMoney($ptRow['gst_total'] ?? 0);
            $pgFeeTotal = $roundMoney($ptRow['pg_fee_total'] ?? 0);
            $globalPoolAllocationTotal = $roundMoney($ptRow['global_pool_allocation_total'] ?? 0);
            $immediateGlobalPoolDistributedTotal = $roundMoney($ptRow['immediate_global_pool_distributed_total'] ?? 0);
        }
    }

    // 5. Settlement distribution summary (unique batch deduplicated, standalone from reserves)
    $settlementBatchCount = 0;
    $settlementDistributedTotal = 0.0;

    if ($hasSettlementsTable) {
        $settleStmt = $pdo->query("
            SELECT
                COUNT(*) AS settlement_batch_count,
                ROUND(COALESCE(SUM(uniq_batch.distributed_amount), 0), 2) AS settlement_distributed_total
            FROM (
                SELECT
                    COALESCE(NULLIF(TRIM(idempotency_key), ''), id) AS batch_key,
                    MAX(COALESCE(distributed_amount, 0.00)) AS distributed_amount
                FROM global_pool_settlements
                GROUP BY COALESCE(NULLIF(TRIM(idempotency_key), ''), id)
            ) uniq_batch
        ");
        $settleRow = $settleStmt ? $settleStmt->fetch(PDO::FETCH_ASSOC) : null;
        if ($settleRow) {
            $settlementBatchCount = intval($settleRow['settlement_batch_count'] ?? 0);
            $settlementDistributedTotal = $roundMoney($settleRow['settlement_distributed_total'] ?? 0);
        }
    }

    $globalPoolDistributedTotal = round($immediateGlobalPoolDistributedTotal + $settlementDistributedTotal, 2);

    // 6. Global Pool reserve breakdown (pending, settled, cancelled kept strictly separate)
    $pendingReserveCount = 0;
    $pendingReserveTotal = 0.0;
    $settledReserveCount = 0;
    $settledReserveTotal = 0.0;
    $cancelledReserveCount = 0;
    $cancelledReserveTotal = 0.0;

    if ($hasReservesTable) {
        $resStmt = $pdo->query("
            SELECT
                COUNT(CASE WHEN LOWER(TRIM(gpr.status)) = 'pending' THEN 1 ELSE NULL END) AS pending_reserve_count,
                ROUND(COALESCE(SUM(CASE WHEN LOWER(TRIM(gpr.status)) = 'pending' THEN COALESCE(gpr.reserve_amount, 0.00) ELSE 0.00 END), 0), 2) AS pending_reserve_total,
                COUNT(CASE WHEN LOWER(TRIM(gpr.status)) = 'settled' THEN 1 ELSE NULL END) AS settled_reserve_count,
                ROUND(COALESCE(SUM(CASE WHEN LOWER(TRIM(gpr.status)) = 'settled' THEN COALESCE(gpr.reserve_amount, 0.00) ELSE 0.00 END), 0), 2) AS settled_reserve_total,
                COUNT(CASE WHEN LOWER(TRIM(gpr.status)) = 'cancelled' THEN 1 ELSE NULL END) AS cancelled_reserve_count,
                ROUND(COALESCE(SUM(CASE WHEN LOWER(TRIM(gpr.status)) = 'cancelled' THEN COALESCE(gpr.reserve_amount, 0.00) ELSE 0.00 END), 0), 2) AS cancelled_reserve_total
            FROM global_pool_reserves gpr
            INNER JOIN (
                SELECT MIN(id) AS first_id
                FROM global_pool_reserves
                GROUP BY COALESCE(NULLIF(TRIM(payment_id), ''), id)
            ) uniq_res ON gpr.id = uniq_res.first_id
        ");
        $resRow = $resStmt ? $resStmt->fetch(PDO::FETCH_ASSOC) : null;
        if ($resRow) {
            $pendingReserveCount = intval($resRow['pending_reserve_count'] ?? 0);
            $pendingReserveTotal = $roundMoney($resRow['pending_reserve_total'] ?? 0);
            $settledReserveCount = intval($resRow['settled_reserve_count'] ?? 0);
            $settledReserveTotal = $roundMoney($resRow['settled_reserve_total'] ?? 0);
            $cancelledReserveCount = intval($resRow['cancelled_reserve_count'] ?? 0);
            $cancelledReserveTotal = $roundMoney($resRow['cancelled_reserve_total'] ?? 0);
        }
    }

    // 7. Eligible creator & video counts
    $eligibleCreatorCount = 0;
    $eligibleVideoCount = 0;

    if ($hasUploadedVideosTable) {
        $blockedClause = $hasVideoBlockedCol ? 'AND (is_blocked = 0 OR is_blocked IS NULL)' : '';
        $eligStmt = $pdo->query("
            SELECT
                COUNT(DISTINCT UPPER(TRIM(user_id))) AS eligible_creator_count,
                COUNT(*) AS eligible_video_count
            FROM uploaded_videos
            WHERE (video_type = 'premium' OR payment_status = 'paid')
              {$blockedClause}
        ");
        $eligRow = $eligStmt ? $eligStmt->fetch(PDO::FETCH_ASSOC) : null;
        if ($eligRow) {
            $eligibleCreatorCount = intval($eligRow['eligible_creator_count'] ?? 0);
            $eligibleVideoCount = intval($eligRow['eligible_video_count'] ?? 0);
        }
    }

    jsonResponse([
        'success' => true,
        'personal' => [
            'userId' => $targetUserId,
            'hasWalletRow' => $hasWalletRow,
            'totalIncome' => $personalTotalIncome,
            'globalIncome' => $personalGlobalIncome,
            'balance' => $balance,
            'totalWithdrawn' => $totalWithdrawn,
            'walletTotalEarned' => $walletTotalEarned,
            'walletGlobalIncome' => $walletGlobalIncome,
            'ledgerTotalEarned' => $ledgerTotalEarned,
            'ledgerGlobalIncome' => $ledgerGlobalIncome,
            'walletVsLedgerDiff' => $walletVsLedgerDiff,
            'globalTxCount' => $globalTxCount,
            'source' => $personalSource,
        ],
        'platform' => [
            'totalPremiumTransactions' => $totalPremiumTransactions,
            'totalTransactionAmount' => $totalTransactionAmount,
            'referralAllocationTotal' => $referralAllocationTotal,
            'adminAllocationTotal' => $adminAllocationTotal,
            'gstTotal' => $gstTotal,
            'pgFeeTotal' => $pgFeeTotal,
            'globalPoolAllocationTotal' => $globalPoolAllocationTotal,
            'immediateGlobalPoolDistributedTotal' => $immediateGlobalPoolDistributedTotal,
            'settlementBatchCount' => $settlementBatchCount,
            'settlementDistributedTotal' => $settlementDistributedTotal,
            'globalPoolDistributedTotal' => $globalPoolDistributedTotal,
            'pendingReserveCount' => $pendingReserveCount,
            'pendingReserveTotal' => $pendingReserveTotal,
            'settledReserveCount' => $settledReserveCount,
            'settledReserveTotal' => $settledReserveTotal,
            'cancelledReserveCount' => $cancelledReserveCount,
            'cancelledReserveTotal' => $cancelledReserveTotal,
            'eligibleCreatorCount' => $eligibleCreatorCount,
            'eligibleVideoCount' => $eligibleVideoCount,
        ],
    ]);
} catch (Throwable $e) {
    error_log('[wallet/global-income.php] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while loading global income summary.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to load global income summary due to a server error.'
    ], 500);
}
