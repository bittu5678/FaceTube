<?php
/**
 * FaceTube - Admin Subscription Management API (Hostinger / cPanel PHP Production)
 * GET /api/admin/subscriptions.php
 * Strictly restricted to verified administrators.
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
        'error' => 'Admin authorization required. Access denied.'
    ], 403);
}

$search = trim($_GET['search'] ?? '');
$statusFilter = strtolower(trim($_GET['status'] ?? 'all'));
$page = max(1, (int)($_GET['page'] ?? 1));
$limit = min(100, max(1, (int)($_GET['limit'] ?? 10)));
$detailId = trim($_GET['id'] ?? '');

$planNames = [
    'member-monthly' => 'Creator Member',
    'member-vip-monthly' => 'VIP Supporter',
    'member-annual' => 'All-Access Annual',
];

$planPerks = [];

try {
    $stmtPlans = $pdo->query('SELECT plan_id, name, perks_json FROM subscriber_plans');
    if ($stmtPlans) {
        while ($pRow = $stmtPlans->fetch()) {
            if (!empty($pRow['plan_id'])) {
                if (!empty($pRow['name'])) {
                    $planNames[$pRow['plan_id']] = $pRow['name'];
                }
                if (!empty($pRow['perks_json'])) {
                    $decoded = json_decode($pRow['perks_json'], true);
                    if (is_array($decoded)) {
                        $planPerks[$pRow['plan_id']] = $decoded;
                    }
                }
            }
        }
    }
} catch (Exception $e) {
    // Ignore
}

$now = time();
$allSubscriptions = [];

try {
    $stmt = $pdo->query('
        SELECT s.subscription_id, s.user_id, s.plan_id, s.order_id, s.payment_id, s.amount, s.currency, s.status, s.starts_at, s.expires_at, s.created_at,
               u.name AS user_name, u.email AS user_email
        FROM user_subscriptions s
        LEFT JOIN users u ON UPPER(s.user_id) = UPPER(u.user_id)
        ORDER BY s.created_at DESC
    ');
    $rows = $stmt ? $stmt->fetchAll() : [];

    if ($rows !== false && is_array($rows)) {
        foreach ($rows as $row) {
            $expiresTime = strtotime($row['expires_at']);
            $isExpired = ($row['status'] !== 'active') || ($expiresTime <= $now);
            $remainingDays = $isExpired ? 0 : max(0, (int)ceil(($expiresTime - $now) / 86400));
            $effectiveStatus = ($isExpired && $row['status'] === 'active') ? 'expired' : $row['status'];
            $planId = (string)$row['plan_id'];
            $planName = $planNames[$planId] ?? $planId;
            $perks = $planPerks[$planId] ?? [];

            $item = [
                'id' => (string)$row['subscription_id'],
                'subscriptionId' => (string)$row['subscription_id'],
                'userId' => (string)$row['user_id'],
                'userName' => (string)($row['user_name'] ?? 'Member'),
                'userEmail' => (string)($row['user_email'] ?? ''),
                'planId' => $planId,
                'planName' => (string)$planName,
                'amount' => (float)$row['amount'],
                'currency' => (string)($row['currency'] ?: 'INR'),
                'status' => (string)$effectiveStatus,
                'isExpired' => (bool)$isExpired,
                'remainingDays' => (int)$remainingDays,
                'orderId' => (string)$row['order_id'],
                'paymentId' => (string)$row['payment_id'],
                'startsAt' => (string)$row['starts_at'],
                'expiresAt' => (string)$row['expires_at'],
                'createdAt' => (string)$row['created_at'],
                'perks' => $perks,
            ];

            $allSubscriptions[] = $item;
        }
    }
} catch (PDOException $e) {
    // Gracefully handle unmigrated tables
}

// Single item lookup
if (!empty($detailId)) {
    foreach ($allSubscriptions as $s) {
        if ($s['subscriptionId'] === $detailId || $s['paymentId'] === $detailId || $s['orderId'] === $detailId) {
            jsonResponse(['success' => true, 'subscription' => $s]);
        }
    }
    jsonResponse(['success' => false, 'error' => 'Subscription record not found.'], 404);
}

// Compute statistics
$total = count($allSubscriptions);
$active = 0;
$expired = 0;
$totalRevenue = 0.0;

foreach ($allSubscriptions as $s) {
    if (!$s['isExpired'] && $s['status'] === 'active') {
        $active++;
    } else {
        $expired++;
    }
    $totalRevenue += (float)$s['amount'];
}

// Filter by status
$filtered = $allSubscriptions;
if ($statusFilter === 'active') {
    $filtered = array_values(array_filter($filtered, function ($s) {
        return !$s['isExpired'] && $s['status'] === 'active';
    }));
} elseif ($statusFilter === 'expired') {
    $filtered = array_values(array_filter($filtered, function ($s) {
        return $s['isExpired'] || $s['status'] === 'expired';
    }));
}

// Filter by search
if (!empty($search)) {
    $q = mb_strtolower($search, 'UTF-8');
    $filtered = array_values(array_filter($filtered, function ($s) use ($q) {
        return (
            str_contains(mb_strtolower($s['userId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['userName'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['userEmail'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['planId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['planName'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['paymentId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['orderId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($s['subscriptionId'], 'UTF-8'), $q)
        );
    }));
}

$totalItems = count($filtered);
$totalPages = max(1, (int)ceil($totalItems / $limit));
$offset = ($page - 1) * $limit;
$paginated = array_slice($filtered, $offset, $limit);

jsonResponse([
    'success' => true,
    'stats' => [
        'total' => $total,
        'active' => $active,
        'expired' => $expired,
        'totalRevenue' => $totalRevenue,
    ],
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'totalItems' => $totalItems,
        'totalPages' => $totalPages,
    ],
    'subscriptions' => $paginated,
]);
