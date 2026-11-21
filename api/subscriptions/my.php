<?php
/**
 * FaceTube - User Subscriptions & History API (Hostinger / cPanel PHP Production)
 * GET /api/subscriptions/my.php
 * Authenticated endpoint for retrieving the authenticated user's active subscription
 * and previous expired subscription history.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isMissingOptionalTable = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)$e->getCode();
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S02' || $driverCode === 1146;
};

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
        error_log('[subscriptions/my.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[subscriptions/my.php][AUTH] Database error: ' . $e->getMessage());
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

// Strictly enforce ownership from the authenticated session - never trust client input
$userId = (string)$authUser['user_id'];

$planNames = [
    'member-monthly' => 'Creator Member',
    'member-vip-monthly' => 'VIP Supporter',
    'member-annual' => 'All-Access Annual',
];

// Fetch plan names from subscriber_plans if table exists; never swallow connection/runtime errors
try {
    $stmtPlans = $pdo->query('SELECT plan_id, name FROM subscriber_plans');
    if ($stmtPlans === false) {
        throw new RuntimeException('Failed to query subscriber_plans.');
    }
    while ($pRow = $stmtPlans->fetch(PDO::FETCH_ASSOC)) {
        if (!empty($pRow['plan_id']) && !empty($pRow['name'])) {
            $planNames[(string)$pRow['plan_id']] = (string)$pRow['name'];
        }
    }
} catch (Throwable $e) {
    if (!$isMissingOptionalTable($e)) {
        $safeRollback($pdo);
        error_log('[subscriptions/my.php][PLANS] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse([
                'success' => false,
                'error' => 'Database connection unavailable while loading subscription plans.'
            ], 503);
        }
        jsonResponse([
            'success' => false,
            'error' => 'Failed to load subscription status due to a server error.'
        ], 500);
    }
}

$activeSubscription = null;
$history = [];
$allSubscriptions = [];
$now = time();

try {
    $stmt = $pdo->prepare('
        SELECT subscription_id, user_id, plan_id, order_id, payment_id, amount, currency, status, starts_at, expires_at, created_at
        FROM user_subscriptions
        WHERE UPPER(user_id) = UPPER(?)
        ORDER BY created_at DESC
    ');
    if ($stmt === false) {
        throw new RuntimeException('Failed to prepare subscription status query.');
    }
    if ($stmt->execute([$userId]) === false) {
        throw new RuntimeException('Failed to execute subscription status query.');
    }
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if ($rows === false) {
        throw new RuntimeException('Failed to fetch subscription status rows.');
    }

    foreach ($rows as $row) {
        $rawStatus = (string)($row['status'] ?? '');
        $expiresAtRaw = (string)($row['expires_at'] ?? '');
        $expiresTime = strtotime($expiresAtRaw);
        $isExpired = ($rawStatus !== 'active') || ($expiresTime <= $now);
        $remainingDays = $isExpired ? 0 : max(0, (int)ceil(($expiresTime - $now) / 86400));
        $effectiveStatus = ($isExpired && $rawStatus === 'active') ? 'expired' : $rawStatus;
        $planId = (string)($row['plan_id'] ?? '');
        $planName = $planNames[$planId] ?? $planId;

        $item = [
            'subscriptionId' => (string)($row['subscription_id'] ?? ''),
            'userId' => (string)($row['user_id'] ?? ''),
            'planId' => $planId,
            'planName' => (string)$planName,
            'orderId' => (string)($row['order_id'] ?? ''),
            'paymentId' => (string)($row['payment_id'] ?? ''),
            'amount' => (float)($row['amount'] ?? 0),
            'currency' => (string)(!empty($row['currency']) ? $row['currency'] : 'INR'),
            'status' => (string)$effectiveStatus,
            'isExpired' => (bool)$isExpired,
            'remainingDays' => (int)$remainingDays,
            'startsAt' => (string)($row['starts_at'] ?? ''),
            'expiresAt' => $expiresAtRaw,
            'createdAt' => (string)($row['created_at'] ?? ''),
        ];

        $allSubscriptions[] = $item;

        if (!$isExpired && $rawStatus === 'active' && $activeSubscription === null) {
            $activeSubscription = $item;
        } else {
            $history[] = $item;
        }
    }
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[subscriptions/my.php] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while loading subscription status.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to load subscription status due to a server error.'
    ], 500);
}

jsonResponse([
    'success' => true,
    'hasActiveSubscription' => ($activeSubscription !== null),
    'subscription' => $activeSubscription,
    'activeSubscription' => $activeSubscription,
    'history' => $history,
    'subscriptions' => $allSubscriptions,
]);
