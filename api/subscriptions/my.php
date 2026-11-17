<?php
/**
 * FaceTube - User Subscriptions & History API (Hostinger / cPanel PHP Production)
 * GET /api/subscriptions/my.php
 * Authenticated endpoint for retrieving the authenticated user's active subscription
 * and previous expired subscription history.
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

// Strictly enforce ownership from the authenticated session - never trust client input
$userId = $authUser['user_id'];

$planNames = [
    'member-monthly' => 'Creator Member',
    'member-vip-monthly' => 'VIP Supporter',
    'member-annual' => 'All-Access Annual',
];

// Fetch plan names from subscriber_plans if available
try {
    $stmtPlans = $pdo->query('SELECT plan_id, name FROM subscriber_plans');
    if ($stmtPlans) {
        while ($pRow = $stmtPlans->fetch()) {
            if (!empty($pRow['plan_id']) && !empty($pRow['name'])) {
                $planNames[$pRow['plan_id']] = $pRow['name'];
            }
        }
    }
} catch (Exception $e) {
    // Ignore if table not present
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
    $stmt->execute([$userId]);
    $rows = $stmt->fetchAll();

    if ($rows !== false) {
        foreach ($rows as $row) {
            $expiresTime = strtotime($row['expires_at']);
            $isExpired = ($row['status'] !== 'active') || ($expiresTime <= $now);
            $remainingDays = $isExpired ? 0 : max(0, (int)ceil(($expiresTime - $now) / 86400));
            $effectiveStatus = ($isExpired && $row['status'] === 'active') ? 'expired' : $row['status'];
            $planId = $row['plan_id'];
            $planName = $planNames[$planId] ?? $planId;

            $item = [
                'subscriptionId' => (string)$row['subscription_id'],
                'userId' => (string)$row['user_id'],
                'planId' => (string)$planId,
                'planName' => (string)$planName,
                'orderId' => (string)$row['order_id'],
                'paymentId' => (string)$row['payment_id'],
                'amount' => (float)$row['amount'],
                'currency' => (string)($row['currency'] ?: 'INR'),
                'status' => (string)$effectiveStatus,
                'isExpired' => (bool)$isExpired,
                'remainingDays' => (int)$remainingDays,
                'startsAt' => (string)$row['starts_at'],
                'expiresAt' => (string)$row['expires_at'],
                'createdAt' => (string)$row['created_at'],
            ];

            $allSubscriptions[] = $item;

            if (!$isExpired && $row['status'] === 'active' && $activeSubscription === null) {
                $activeSubscription = $item;
            } else {
                $history[] = $item;
            }
        }
    }
} catch (PDOException $e) {
    // If user_subscriptions table unmigrated, gracefully return empty arrays
}

jsonResponse([
    'success' => true,
    'hasActiveSubscription' => ($activeSubscription !== null),
    'subscription' => $activeSubscription,
    'activeSubscription' => $activeSubscription,
    'history' => $history,
    'subscriptions' => $allSubscriptions,
]);
