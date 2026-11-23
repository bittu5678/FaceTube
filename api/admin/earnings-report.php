<?php
/**
 * FaceTube - Admin User-Wise Earnings & Payouts Report API
 * GET /api/admin/earnings-report.php
 *
 * Provides a comprehensive, paginated user-wise earnings and withdrawal report
 * strictly restricted to authenticated administrators.
 *
 * Query Parameters:
 * - search / q: Search string for user_id, name, email, referral_code
 * - start_date: Filter from date (YYYY-MM-DD)
 * - end_date: Filter to date (YYYY-MM-DD)
 * - date_mode: 'joined' (default) | 'activity'
 * - page: 1-indexed page number (default: 1)
 * - limit: Number of users per page (default: 20, max: 100)
 * - export: 'csv' for raw CSV file download
 * - action: 'withdrawals' (user-specific withdrawal transaction history drill-down)
 * - user_id / userId: Target user ID when action='withdrawals'
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

if (strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Only verified administrators can access the earnings report.'
    ], 403);
}

$action = trim(strtolower($_GET['action'] ?? ''));

// -----------------------------------------------------------------------------
// Sub-Action: Specific User Withdrawal Transaction History Drill-Down
// -----------------------------------------------------------------------------
if ($action === 'withdrawals') {
    $targetUserId = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));
    if (empty($targetUserId)) {
        jsonResponse(['success' => false, 'error' => 'user_id is required for withdrawal history'], 400);
    }

    $startDate = trim($_GET['start_date'] ?? ($_GET['startDate'] ?? ''));
    $endDate = trim($_GET['end_date'] ?? ($_GET['endDate'] ?? ''));

    $sql = "
        SELECT id, transaction_id, user_id, amount, status, description, created_at
        FROM income_ledger
        WHERE UPPER(user_id) = UPPER(?) AND income_type = 'withdrawal'
    ";
    $params = [$targetUserId];

    if (!empty($startDate) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate)) {
        $sql .= " AND created_at >= ?";
        $params[] = $startDate . ' 00:00:00';
    }
    if (!empty($endDate) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate)) {
        $sql .= " AND created_at <= ?";
        $params[] = $endDate . ' 23:59:59';
    }

    $sql .= " ORDER BY created_at DESC LIMIT 200";

    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        $mapped = array_map(function ($tx) {
            return [
                'id' => $tx['id'],
                'transactionId' => $tx['transaction_id'],
                'userId' => $tx['user_id'],
                'amount' => floatval($tx['amount']),
                'status' => $tx['status'],
                'description' => $tx['description'],
                'createdAt' => $tx['created_at'],
            ];
        }, $rows);

        $totalAmount = array_reduce($mapped, function ($sum, $item) {
            return $sum + $item['amount'];
        }, 0.0);

        jsonResponse([
            'success' => true,
            'userId' => $targetUserId,
            'total' => count($mapped),
            'totalAmount' => $totalAmount,
            'withdrawals' => $mapped,
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
    }
}

// -----------------------------------------------------------------------------
// Main Report Query: Filtered & Paginated User Earnings
// -----------------------------------------------------------------------------
$search = trim($_GET['search'] ?? ($_GET['q'] ?? ''));
$startDate = trim($_GET['start_date'] ?? ($_GET['startDate'] ?? ''));
$endDate = trim($_GET['end_date'] ?? ($_GET['endDate'] ?? ''));
$dateMode = trim(strtolower($_GET['date_mode'] ?? 'joined'));
$export = trim(strtolower($_GET['export'] ?? ($_GET['format'] ?? '')));

$page = max(1, intval($_GET['page'] ?? 1));
$limit = max(1, min(100, intval($_GET['limit'] ?? 20)));
if ($export === 'csv') {
    $limit = 5000;
    $page = 1;
}
$offset = ($page - 1) * $limit;

$whereClauses = [];
$params = [];

if (!empty($search)) {
    $whereClauses[] = "(u.user_id LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.referral_code LIKE ?)";
    $like = '%' . $search . '%';
    $params[] = $like;
    $params[] = $like;
    $params[] = $like;
    $params[] = $like;
}

$hasStartDate = !empty($startDate) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate);
$hasEndDate = !empty($endDate) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate);
$isActivityDateFiltered = ($dateMode === 'activity') && ($hasStartDate || $hasEndDate);

$ledgerDateClauses = [];
$ledgerDateParams = [];
if ($isActivityDateFiltered) {
    if ($hasStartDate) {
        $ledgerDateClauses[] = "created_at >= ?";
        $ledgerDateParams[] = $startDate . ' 00:00:00';
    }
    if ($hasEndDate) {
        $ledgerDateClauses[] = "created_at <= ?";
        $ledgerDateParams[] = $endDate . ' 23:59:59';
    }
}
$ledgerDateSql = !empty($ledgerDateClauses) ? (' AND ' . implode(' AND ', $ledgerDateClauses)) : '';

if ($dateMode === 'activity') {
    // Filter users who had settled income or withdrawal ledger activity within the date window
    if ($hasStartDate && $hasEndDate) {
        $whereClauses[] = "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE status = 'settled' AND created_at >= ? AND created_at <= ?)";
        $params[] = $startDate . ' 00:00:00';
        $params[] = $endDate . ' 23:59:59';
    } elseif ($hasStartDate) {
        $whereClauses[] = "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE status = 'settled' AND created_at >= ?)";
        $params[] = $startDate . ' 00:00:00';
    } elseif ($hasEndDate) {
        $whereClauses[] = "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE status = 'settled' AND created_at <= ?)";
        $params[] = $endDate . ' 23:59:59';
    }
} else {
    // Default: Filter by user registration / joined date
    if ($hasStartDate) {
        $whereClauses[] = "u.created_at >= ?";
        $params[] = $startDate . ' 00:00:00';
    }
    if ($hasEndDate) {
        $whereClauses[] = "u.created_at <= ?";
        $params[] = $endDate . ' 23:59:59';
    }
}

$whereSql = !empty($whereClauses) ? ('WHERE ' . implode(' AND ', $whereClauses)) : '';

try {
    // 0. Inspect AdMob & Ad Boost schema availability so pre-migration schemas never crash or fabricate data
    $hasWalletAdmobCol = true;
    $hasWalletAdBoostCol = false;
    $hasLedgerAdmobType = true;
    try {
        $schemaStmt = $pdo->query("
            SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND (
                TABLE_NAME = 'wallet_balances'
                OR (TABLE_NAME = 'income_ledger' AND COLUMN_NAME = 'income_type')
              )
        ");
        $schemaRows = $schemaStmt ? $schemaStmt->fetchAll(PDO::FETCH_ASSOC) : [];
        if (!empty($schemaRows)) {
            $hasWalletAdmobCol = false;
            $hasWalletAdBoostCol = false;
            $hasLedgerAdmobType = false;
            foreach ($schemaRows as $sRow) {
                $tName = strtolower(trim((string)($sRow['TABLE_NAME'] ?? $sRow['table_name'] ?? '')));
                $cName = strtolower(trim((string)($sRow['COLUMN_NAME'] ?? $sRow['column_name'] ?? '')));
                $cType = strtolower(trim((string)($sRow['COLUMN_TYPE'] ?? $sRow['column_type'] ?? '')));
                if ($tName === 'wallet_balances' && $cName === 'admob_income') {
                    $hasWalletAdmobCol = true;
                }
                if ($tName === 'wallet_balances' && $cName === 'ad_boost_income') {
                    $hasWalletAdBoostCol = true;
                }
                if ($tName === 'income_ledger' && $cName === 'income_type' && str_contains($cType, 'admob_income')) {
                    $hasLedgerAdmobType = true;
                }
            }
        }
    } catch (Throwable $_schemaErr) {
        $hasWalletAdmobCol = true;
        $hasWalletAdBoostCol = false;
        $hasLedgerAdmobType = true;
    }

    $admobAvailable = $hasWalletAdmobCol || $hasLedgerAdmobType;
    $admobStatus = $admobAvailable ? 'available' : 'unavailable';

    $ledgerAdmobExpr = $hasLedgerAdmobType
        ? "SUM(CASE WHEN income_type = 'admob_income' THEN amount ELSE 0 END)"
        : "0";

    if ($isActivityDateFiltered) {
        // Activity date window: compute period-scoped metrics strictly from settled income_ledger rows in range
        $summaryTotalEarnedExpr = "COALESCE(SUM(COALESCE(lt.ledger_total_earned, 0)), 0)";
        $summaryTotalWithdrawnExpr = "COALESCE(SUM(COALESCE(lt.ledger_total_withdrawn, 0)), 0)";
        $summaryReferralExpr = "COALESCE(SUM(COALESCE(lt.ledger_referral_income, 0)), 0)";
        $summaryAdBoostExpr = "COALESCE(SUM(COALESCE(lt.ledger_ad_boost_income, 0)), 0)";
        $summaryGlobalExpr = "COALESCE(SUM(COALESCE(lt.ledger_global_income, 0)), 0)";
        $summaryAdsenseExpr = "COALESCE(SUM(COALESCE(lt.ledger_adsense_income, 0)), 0)";
        $summaryAdmobExpr = "COALESCE(SUM(COALESCE(lt.ledger_admob_income, 0)), 0)";
        $summaryAffiliateExpr = "COALESCE(SUM(COALESCE(lt.ledger_affiliate_income, 0)), 0)";

        $rowTotalEarnedExpr = "COALESCE(lt.ledger_total_earned, 0.00)";
        $rowTotalWithdrawnExpr = "COALESCE(lt.ledger_total_withdrawn, 0.00)";
        $rowReferralExpr = "COALESCE(lt.ledger_referral_income, 0.00)";
        $rowAdBoostExpr = "COALESCE(lt.ledger_ad_boost_income, 0.00)";
        $rowGlobalExpr = "COALESCE(lt.ledger_global_income, 0.00)";
        $rowAdsenseExpr = "COALESCE(lt.ledger_adsense_income, 0.00)";
        $rowAdmobExpr = "COALESCE(lt.ledger_admob_income, 0.00)";
        $rowAffiliateExpr = "COALESCE(lt.ledger_affiliate_income, 0.00)";
    } else {
        $summaryTotalEarnedExpr = "COALESCE(SUM(COALESCE(wb.total_earned, lt.ledger_total_earned, 0)), 0)";
        $summaryTotalWithdrawnExpr = "COALESCE(SUM(COALESCE(wb.total_withdrawn, lt.ledger_total_withdrawn, 0)), 0)";
        $summaryReferralExpr = "COALESCE(SUM(COALESCE(lt.ledger_referral_income, wb.referral_income, 0)), 0)";
        $summaryAdBoostExpr = $hasWalletAdBoostCol
            ? "COALESCE(SUM(COALESCE(lt.ledger_ad_boost_income, wb.ad_boost_income, 0)), 0)"
            : "COALESCE(SUM(COALESCE(lt.ledger_ad_boost_income, 0)), 0)";
        $summaryGlobalExpr = "COALESCE(SUM(COALESCE(lt.ledger_global_income, wb.global_income, 0)), 0)";
        $summaryAdsenseExpr = "COALESCE(SUM(COALESCE(lt.ledger_adsense_income, wb.adsense_income, 0)), 0)";
        $summaryAdmobExpr = $hasWalletAdmobCol
            ? "COALESCE(SUM(COALESCE(lt.ledger_admob_income, wb.admob_income, 0)), 0)"
            : "COALESCE(SUM(COALESCE(lt.ledger_admob_income, 0)), 0)";
        $summaryAffiliateExpr = "COALESCE(SUM(COALESCE(lt.ledger_affiliate_income, wb.affiliate_income, 0)), 0)";

        $rowTotalEarnedExpr = "COALESCE(wb.total_earned, lt.ledger_total_earned, 0.00)";
        $rowTotalWithdrawnExpr = "COALESCE(wb.total_withdrawn, lt.ledger_total_withdrawn, 0.00)";
        $rowReferralExpr = "COALESCE(lt.ledger_referral_income, wb.referral_income, 0.00)";
        $rowAdBoostExpr = $hasWalletAdBoostCol
            ? "COALESCE(lt.ledger_ad_boost_income, wb.ad_boost_income, 0.00)"
            : "COALESCE(lt.ledger_ad_boost_income, 0.00)";
        $rowGlobalExpr = "COALESCE(lt.ledger_global_income, wb.global_income, 0.00)";
        $rowAdsenseExpr = "COALESCE(lt.ledger_adsense_income, wb.adsense_income, 0.00)";
        $rowAdmobExpr = $hasWalletAdmobCol
            ? "COALESCE(lt.ledger_admob_income, wb.admob_income, 0.00)"
            : "COALESCE(lt.ledger_admob_income, 0.00)";
        $rowAffiliateExpr = "COALESCE(lt.ledger_affiliate_income, wb.affiliate_income, 0.00)";
    }

    // 1. Count total matching users
    $countSql = "SELECT COUNT(*) FROM users u {$whereSql}";
    $stmtCount = $pdo->prepare($countSql);
    $stmtCount->execute($params);
    $totalUsers = intval($stmtCount->fetchColumn() ?: 0);

    // 2. Compute aggregate summary metrics across all matching users
    $summarySql = "
        SELECT 
            COUNT(u.id) AS total_count,
            COALESCE(SUM(wb.balance), 0) AS total_wallet_balance,
            {$summaryTotalEarnedExpr} AS total_earned,
            {$summaryTotalWithdrawnExpr} AS total_withdrawn,
            {$summaryReferralExpr} AS total_referral_income,
            {$summaryAdBoostExpr} AS total_ad_boost_income,
            {$summaryGlobalExpr} AS total_global_income,
            {$summaryAdsenseExpr} AS total_adsense_income,
            {$summaryAdmobExpr} AS total_admob_income,
            {$summaryAffiliateExpr} AS total_affiliate_income
        FROM users u
        LEFT JOIN wallet_balances wb ON UPPER(TRIM(wb.user_id)) = UPPER(TRIM(u.user_id))
        LEFT JOIN (
            SELECT 
                UPPER(TRIM(user_id)) AS user_id,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('referral_income', 'direct_commission')
                          AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
                          AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
                          AND UPPER(COALESCE(special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         THEN amount ELSE 0 END) AS ledger_referral_income,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('ad_boost_income', 'marketing_ads')
                          OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                          OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         THEN amount ELSE 0 END) AS ledger_ad_boost_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'global_income' THEN amount ELSE 0 END) AS ledger_global_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'adsense_income' THEN amount ELSE 0 END) AS ledger_adsense_income,
                {$ledgerAdmobExpr} AS ledger_admob_income,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('affiliate_income', 'marketing_income') THEN amount ELSE 0 END) AS ledger_affiliate_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_withdrawn,
                SUM(CASE WHEN COALESCE(income_type, '') != 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_earned
            FROM income_ledger
            WHERE status = 'settled'{$ledgerDateSql}
            GROUP BY UPPER(TRIM(user_id))
        ) lt ON UPPER(TRIM(lt.user_id)) = UPPER(TRIM(u.user_id))
        {$whereSql}
    ";
    $stmtSummary = $pdo->prepare($summarySql);
    $stmtSummary->execute(array_merge($ledgerDateParams, $params));
    $summaryRow = $stmtSummary->fetch() ?: [];

    $summaryAdsense = round(floatval($summaryRow['total_adsense_income'] ?? 0), 2);
    $summaryAdmob = $admobAvailable ? round(floatval($summaryRow['total_admob_income'] ?? 0), 2) : 0.0;
    $summaryTotalAdEarnings = round($summaryAdsense + $summaryAdmob, 2);

    $summary = [
        'totalUsers' => intval($summaryRow['total_count'] ?? $totalUsers),
        'totalWalletBalance' => round(floatval($summaryRow['total_wallet_balance'] ?? 0), 2),
        'totalEarned' => round(floatval($summaryRow['total_earned'] ?? 0), 2),
        'totalWithdrawn' => round(floatval($summaryRow['total_withdrawn'] ?? 0), 2),
        'totalReferralIncome' => round(floatval($summaryRow['total_referral_income'] ?? 0), 2),
        'totalAdBoostIncome' => round(floatval($summaryRow['total_ad_boost_income'] ?? 0), 2),
        'totalGlobalIncome' => round(floatval($summaryRow['total_global_income'] ?? 0), 2),
        'totalAdsenseIncome' => $summaryAdsense,
        'totalAdmobIncome' => $summaryAdmob,
        'totalAdEarnings' => $summaryTotalAdEarnings,
        'totalAffiliateIncome' => round(floatval($summaryRow['total_affiliate_income'] ?? 0), 2),
        'admobAvailable' => $admobAvailable,
        'admobStatus' => $admobStatus,
    ];

    // 3. Fetch paginated user records using actual income_ledger aggregates
    $dataSql = "
        SELECT 
            u.id,
            u.user_id,
            u.name,
            u.email,
            u.role,
            u.referral_code,
            u.created_at,
            COALESCE(wb.balance, 0.00) AS balance,
            {$rowTotalEarnedExpr} AS total_earned,
            {$rowTotalWithdrawnExpr} AS total_withdrawn,
            {$rowReferralExpr} AS referral_income,
            {$rowAdBoostExpr} AS ad_boost_income,
            {$rowGlobalExpr} AS global_income,
            {$rowAdsenseExpr} AS adsense_income,
            {$rowAdmobExpr} AS admob_income,
            {$rowAffiliateExpr} AS affiliate_income
        FROM users u
        LEFT JOIN wallet_balances wb ON UPPER(TRIM(wb.user_id)) = UPPER(TRIM(u.user_id))
        LEFT JOIN (
            SELECT 
                UPPER(TRIM(user_id)) AS user_id,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('referral_income', 'direct_commission')
                          AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_REF|_PENDING|_%' ESCAPE '|'
                          AND UPPER(COALESCE(transaction_id, '')) NOT LIKE 'TX|_ADS|_L%' ESCAPE '|'
                          AND UPPER(COALESCE(special_tag, '')) NOT LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         THEN amount ELSE 0 END) AS ledger_referral_income,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('ad_boost_income', 'marketing_ads')
                          OR UPPER(COALESCE(transaction_id, '')) LIKE 'TX|_ADS|_L%' ESCAPE '|'
                          OR UPPER(COALESCE(special_tag, '')) LIKE 'ADS|_REF|_L%' ESCAPE '|'
                         THEN amount ELSE 0 END) AS ledger_ad_boost_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'global_income' THEN amount ELSE 0 END) AS ledger_global_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'adsense_income' THEN amount ELSE 0 END) AS ledger_adsense_income,
                {$ledgerAdmobExpr} AS ledger_admob_income,
                SUM(CASE WHEN COALESCE(income_type, '') IN ('affiliate_income', 'marketing_income') THEN amount ELSE 0 END) AS ledger_affiliate_income,
                SUM(CASE WHEN COALESCE(income_type, '') = 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_withdrawn,
                SUM(CASE WHEN COALESCE(income_type, '') != 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_earned
            FROM income_ledger
            WHERE status = 'settled'{$ledgerDateSql}
            GROUP BY UPPER(TRIM(user_id))
        ) lt ON UPPER(TRIM(lt.user_id)) = UPPER(TRIM(u.user_id))
        {$whereSql}
        ORDER BY u.created_at DESC
        LIMIT " . intval($limit) . " OFFSET " . intval($offset) . "
    ";
    $stmtData = $pdo->prepare($dataSql);
    $stmtData->execute(array_merge($ledgerDateParams, $params));
    $rows = $stmtData->fetchAll();

    // 4. Handle CSV Export
    if ($export === 'csv') {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="facetube_earnings_report_' . date('Y-m-d') . '.csv"');
        header('Pragma: no-cache');
        header('Expires: 0');

        $out = fopen('php://output', 'w');
        // Emit UTF-8 Byte Order Mark (BOM) for correct character display in Microsoft Excel
        fprintf($out, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($out, [
            'User ID',
            'Full Name',
            'Email Address',
            'Role',
            'Referral Code',
            'Available Balance (INR)',
            'Total Earned (INR)',
            'Referral Income (INR)',
            'Ad Boost Income (INR)',
            'Global Income (INR)',
            'AdSense Income (INR)',
            'AdMob Income (INR)',
            'Total Ad Earnings (INR)',
            'Affiliate Income (INR)',
            'Total Withdrawn (INR)',
            'Joined Date'
        ]);

        foreach ($rows as $r) {
            $adsenseVal = round(floatval($r['adsense_income']), 2);
            $admobVal = $admobAvailable ? round(floatval($r['admob_income']), 2) : 0.0;
            $totalAdVal = round($adsenseVal + $admobVal, 2);
            fputcsv($out, [
                $r['user_id'],
                $r['name'],
                $r['email'],
                $r['role'],
                $r['referral_code'] ?: 'N/A',
                number_format(floatval($r['balance']), 2, '.', ''),
                number_format(floatval($r['total_earned']), 2, '.', ''),
                number_format(floatval($r['referral_income']), 2, '.', ''),
                number_format(floatval($r['ad_boost_income'] ?? 0), 2, '.', ''),
                number_format(floatval($r['global_income']), 2, '.', ''),
                number_format($adsenseVal, 2, '.', ''),
                $admobAvailable ? number_format(floatval($r['admob_income']), 2, '.', '') : 'Unavailable',
                $admobAvailable ? number_format($totalAdVal, 2, '.', '') : 'Unavailable',
                number_format(floatval($r['affiliate_income']), 2, '.', ''),
                number_format(floatval($r['total_withdrawn']), 2, '.', ''),
                $r['created_at'],
            ]);
        }
        fclose($out);
        exit;
    }

    // 5. Build structured JSON response
    $users = array_map(function ($r) use ($admobAvailable) {
        $adsenseVal = round(floatval($r['adsense_income']), 2);
        $admobVal = $admobAvailable ? round(floatval($r['admob_income']), 2) : 0.0;
        return [
            'id' => $r['id'],
            'userId' => $r['user_id'],
            'name' => $r['name'],
            'email' => $r['email'],
            'role' => $r['role'],
            'referralCode' => $r['referral_code'],
            'createdAt' => $r['created_at'],
            'balance' => round(floatval($r['balance']), 2),
            'totalEarned' => round(floatval($r['total_earned']), 2),
            'totalWithdrawn' => round(floatval($r['total_withdrawn']), 2),
            'referralIncome' => round(floatval($r['referral_income']), 2),
            'adBoostIncome' => round(floatval($r['ad_boost_income'] ?? 0), 2),
            'globalIncome' => round(floatval($r['global_income']), 2),
            'adsenseIncome' => $adsenseVal,
            'admobIncome' => $admobVal,
            'totalAdEarnings' => round($adsenseVal + $admobVal, 2),
            'affiliateIncome' => round(floatval($r['affiliate_income']), 2),
        ];
    }, $rows);

    $totalPages = $totalUsers > 0 ? (int)ceil($totalUsers / $limit) : 1;

    jsonResponse([
        'success' => true,
        'users' => $users,
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $totalUsers,
            'totalPages' => $totalPages,
        ],
        'summary' => $summary,
    ]);
} catch (PDOException $e) {
    error_log('[admin/earnings-report.php] Database query error: ' . $e->getMessage());
    jsonResponse(['success' => false, 'error' => 'Database error while fetching earnings report.'], 500);
}
