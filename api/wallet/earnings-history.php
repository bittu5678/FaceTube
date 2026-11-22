<?php
/**
 * FaceTube - Earnings Time-Series History API
 * GET /api/wallet/earnings-history.php
 * Returns daily or monthly aggregated income ledger events for the creator growth charts.
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

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[wallet/earnings-history.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[wallet/earnings-history.php][AUTH] Database error: ' . $e->getMessage());
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

$rawRequestedUserId = $readStringField($_GET['user_id'] ?? ($_GET['userId'] ?? ''));
$authPublicId = trim((string)$authUser['user_id']);
$authInternalId = trim((string)($authUser['id'] ?? ''));

if ($rawRequestedUserId === '') {
    $requestedUserId = $authPublicId;
} elseif (
    strcasecmp($rawRequestedUserId, $authPublicId) === 0 ||
    ($authInternalId !== '' && strcasecmp($rawRequestedUserId, $authInternalId) === 0)
) {
    $requestedUserId = $authPublicId;
} else {
    $isAdmin = isset($authUser['role']) && strtolower(trim((string)$authUser['role'])) === 'admin';
    if (!$isAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Unauthorized: Cross-user earnings history access is restricted to verified administrators.'
        ], 403);
    }
    $requestedUserId = $rawRequestedUserId;
}

$rawPeriod = strtoupper($readStringField($_GET['period'] ?? ''));
$rawDays = intval($_GET['days'] ?? 0);

$period = '30D';
$days = 30;

if ($rawPeriod === '7D' || $rawDays === 7) {
    $period = '7D';
    $days = 7;
} elseif ($rawPeriod === '30D' || $rawDays === 30) {
    $period = '30D';
    $days = 30;
} elseif ($rawPeriod === '90D' || $rawDays === 90) {
    $period = '90D';
    $days = 90;
} elseif ($rawPeriod === '12M' || $rawDays >= 365) {
    $period = '12M';
    $days = 365;
} elseif ($rawDays > 0) {
    $days = max(7, min(365, $rawDays));
    $period = $days <= 7 ? '7D' : ($days <= 30 ? '30D' : ($days <= 90 ? '90D' : '12M'));
}

try {
    $timeline = [];
    $summary = [
        'total_revenue' => 0.0,
        'referral' => 0.0,
        'global' => 0.0,
        'adsense' => 0.0,
        'admob' => 0.0,
        'affiliate' => 0.0,
        'ad_boost' => 0.0,
    ];

    if ($period === '12M') {
        $stmt = $pdo->prepare('
            SELECT DATE_FORMAT(created_at, "%Y-%m") as period_key,
                   income_type,
                   SUM(amount) as total_amount,
                   COUNT(*) as tx_count
            FROM income_ledger
            WHERE UPPER(user_id) = UPPER(?)
              AND income_type != "withdrawal"
              AND status = "settled"
              AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), "%Y-%m-01"), INTERVAL 11 MONTH)
            GROUP BY DATE_FORMAT(created_at, "%Y-%m"), income_type
            ORDER BY period_key ASC
        ');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare 12M earnings history query.');
        }
        if ($stmt->execute([$requestedUserId]) === false) {
            throw new RuntimeException('Failed to execute 12M earnings history query.');
        }
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $now = new DateTime('first day of this month');
        for ($i = 11; $i >= 0; $i--) {
            $dtObj = (clone $now)->modify("-{$i} months");
            $key = $dtObj->format('Y-m');
            $label = $dtObj->format('M y');
            $timeline[$key] = [
                'date' => $key,
                'day' => $label,
                'revenue' => 0.0,
                'referral' => 0.0,
                'global' => 0.0,
                'adsense' => 0.0,
                'admob' => 0.0,
                'affiliate' => 0.0,
                'ad_boost' => 0.0,
                'referral_income' => 0.0,
                'global_income' => 0.0,
                'adsense_income' => 0.0,
                'admob_income' => 0.0,
                'affiliate_income' => 0.0,
                'ad_boost_income' => 0.0,
                'tx_count' => 0,
            ];
        }
    } else {
        $stmt = $pdo->prepare('
            SELECT DATE(created_at) as period_key,
                   income_type,
                   SUM(amount) as total_amount,
                   COUNT(*) as tx_count
            FROM income_ledger
            WHERE UPPER(user_id) = UPPER(?)
              AND income_type != "withdrawal"
              AND status = "settled"
              AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY DATE(created_at), income_type
            ORDER BY period_key ASC
        ');
        if ($stmt === false) {
            throw new RuntimeException('Failed to prepare earnings history query.');
        }
        if ($stmt->execute([$requestedUserId, $days]) === false) {
            throw new RuntimeException('Failed to execute earnings history query.');
        }
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $today = new DateTime();
        for ($i = $days - 1; $i >= 0; $i--) {
            $dtObj = (clone $today)->modify("-{$i} days");
            $key = $dtObj->format('Y-m-d');
            $label = $dtObj->format('D');
            $timeline[$key] = [
                'date' => $key,
                'day' => $label,
                'revenue' => 0.0,
                'referral' => 0.0,
                'global' => 0.0,
                'adsense' => 0.0,
                'admob' => 0.0,
                'affiliate' => 0.0,
                'ad_boost' => 0.0,
                'referral_income' => 0.0,
                'global_income' => 0.0,
                'adsense_income' => 0.0,
                'admob_income' => 0.0,
                'affiliate_income' => 0.0,
                'ad_boost_income' => 0.0,
                'tx_count' => 0,
            ];
        }
    }

    foreach ($rows as $r) {
        $k = $r['period_key'];
        if (isset($timeline[$k])) {
            $amt = round(floatval($r['total_amount']), 2);
            $count = intval($r['tx_count']);
            $type = strval($r['income_type'] ?? '');

            $category = null;
            if ($type === 'global_income') {
                $category = 'global';
            } elseif ($type === 'adsense_income') {
                $category = 'adsense';
            } elseif ($type === 'admob_income') {
                $category = 'admob';
            } elseif ($type === 'affiliate_income' || $type === 'marketing_income') {
                $category = 'affiliate';
            } elseif ($type === 'ad_boost_income' || $type === 'marketing_ads') {
                $category = 'ad_boost';
            } elseif ($type === 'referral_income' || $type === 'direct_commission') {
                $category = 'referral';
            }

            if ($category === null) {
                continue;
            }

            $timeline[$k][$category] = round($timeline[$k][$category] + $amt, 2);
            $timeline[$k][$category . '_income'] = $timeline[$k][$category];
            $timeline[$k]['revenue'] = round($timeline[$k]['revenue'] + $amt, 2);
            $timeline[$k]['tx_count'] += $count;

            $summary[$category] = round($summary[$category] + $amt, 2);
            $summary['total_revenue'] = round($summary['total_revenue'] + $amt, 2);
        }
    }

    jsonResponse([
        'success' => true,
        'user_id' => $requestedUserId,
        'period' => $period,
        'days' => $days,
        'summary' => $summary,
        'history' => array_values($timeline),
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[wallet/earnings-history.php] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while loading earnings history.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to load earnings history due to a server error.'
    ], 500);
}
