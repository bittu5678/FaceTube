<?php
/**
 * FaceTube - Admin Subscription Refunds Management API (Hostinger / cPanel PHP Production)
 * GET /api/admin/subscription-refunds.php
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

$allRequests = [];
$seen = [];

// 1. Attempt reading from MySQL database if table exists
if ($pdo) {
    try {
        $stmt = $pdo->query('
            SELECT id, subscription_id, user_id, user_name, user_email, plan_id, plan_name,
                   payment_id, order_id, amount, currency, reason, status, gateway_status,
                   gateway_refund_id, admin_note, reviewed_by, reviewed_at, created_at, updated_at
            FROM subscription_refund_requests
            ORDER BY created_at DESC
        ');
        $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        if (is_array($rows)) {
            foreach ($rows as $row) {
                $id = (string)$row['id'];
                $seen[$id] = true;
                $allRequests[] = [
                    'id' => $id,
                    'subscriptionId' => (string)$row['subscription_id'],
                    'userId' => (string)$row['user_id'],
                    'userName' => (string)($row['user_name'] ?? 'Member'),
                    'userEmail' => (string)($row['user_email'] ?? ''),
                    'planId' => (string)$row['plan_id'],
                    'planName' => (string)($row['plan_name'] ?? $row['plan_id']),
                    'paymentId' => (string)$row['payment_id'],
                    'orderId' => (string)$row['order_id'],
                    'amount' => (float)$row['amount'],
                    'currency' => (string)($row['currency'] ?: 'INR'),
                    'reason' => (string)$row['reason'],
                    'status' => (string)$row['status'],
                    'gatewayStatus' => (string)($row['gateway_status'] ?? 'manual_review_only'),
                    'gatewayRefundId' => $row['gateway_refund_id'] ? (string)$row['gateway_refund_id'] : null,
                    'adminNote' => $row['admin_note'] ? (string)$row['admin_note'] : null,
                    'reviewedBy' => $row['reviewed_by'] ? (string)$row['reviewed_by'] : null,
                    'reviewedAt' => $row['reviewed_at'] ? (string)$row['reviewed_at'] : null,
                    'createdAt' => (string)$row['created_at'],
                    'updatedAt' => (string)$row['updated_at'],
                ];
            }
        }
    } catch (Exception $e) {
        // Table not yet migrated in MySQL; safely fall back to persistent JSON storage
    }
}

// 2. Load from premium_transactions.json
$premiumFile = __DIR__ . '/../../data/premium_transactions.json';
if (file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!empty($pContent['refundRequests']) && is_array($pContent['refundRequests'])) {
        foreach ($pContent['refundRequests'] as $r) {
            $id = (string)($r['id'] ?? '');
            if (!empty($id) && empty($seen[$id])) {
                $seen[$id] = true;
                $allRequests[] = [
                    'id' => $id,
                    'subscriptionId' => (string)($r['subscriptionId'] ?? $r['subscription_id'] ?? ''),
                    'userId' => (string)($r['userId'] ?? $r['user_id'] ?? ''),
                    'userName' => (string)($r['userName'] ?? $r['user_name'] ?? 'Member'),
                    'userEmail' => (string)($r['userEmail'] ?? $r['user_email'] ?? ''),
                    'planId' => (string)($r['planId'] ?? $r['plan_id'] ?? ''),
                    'planName' => (string)($r['planName'] ?? $r['plan_name'] ?? ($r['planId'] ?? '')),
                    'paymentId' => (string)($r['paymentId'] ?? $r['payment_id'] ?? ''),
                    'orderId' => (string)($r['orderId'] ?? $r['order_id'] ?? ''),
                    'amount' => (float)($r['amount'] ?? 0),
                    'currency' => (string)($r['currency'] ?? 'INR'),
                    'reason' => (string)($r['reason'] ?? ''),
                    'status' => (string)($r['status'] ?? 'pending'),
                    'gatewayStatus' => (string)($r['gatewayStatus'] ?? $r['gateway_status'] ?? 'manual_review_only'),
                    'gatewayRefundId' => !empty($r['gatewayRefundId']) ? (string)$r['gatewayRefundId'] : (!empty($r['gateway_refund_id']) ? (string)$r['gateway_refund_id'] : null),
                    'adminNote' => !empty($r['adminNote']) ? (string)$r['adminNote'] : (!empty($r['admin_note']) ? (string)$r['admin_note'] : null),
                    'reviewedBy' => !empty($r['reviewedBy']) ? (string)$r['reviewedBy'] : (!empty($r['reviewed_by']) ? (string)$r['reviewed_by'] : null),
                    'reviewedAt' => !empty($r['reviewedAt']) ? (string)$r['reviewedAt'] : (!empty($r['reviewed_at']) ? (string)$r['reviewed_at'] : null),
                    'createdAt' => (string)($r['createdAt'] ?? $r['created_at'] ?? gmdate('Y-m-d\TH:i:s\Z')),
                    'updatedAt' => (string)($r['updatedAt'] ?? $r['updated_at'] ?? gmdate('Y-m-d\TH:i:s\Z')),
                ];
            }
        }
    }
}

// 3. Load from facetube_store.json fallback
$storeFile = __DIR__ . '/../../data/facetube_store.json';
if (file_exists($storeFile)) {
    $sContent = json_decode(file_get_contents($storeFile), true);
    if (!empty($sContent['subscriptionRefundRequests']) && is_array($sContent['subscriptionRefundRequests'])) {
        foreach ($sContent['subscriptionRefundRequests'] as $r) {
            $id = (string)($r['id'] ?? '');
            if (!empty($id) && empty($seen[$id])) {
                $seen[$id] = true;
                $allRequests[] = [
                    'id' => $id,
                    'subscriptionId' => (string)($r['subscriptionId'] ?? $r['subscription_id'] ?? ''),
                    'userId' => (string)($r['userId'] ?? $r['user_id'] ?? ''),
                    'userName' => (string)($r['userName'] ?? $r['user_name'] ?? 'Member'),
                    'userEmail' => (string)($r['userEmail'] ?? $r['user_email'] ?? ''),
                    'planId' => (string)($r['planId'] ?? $r['plan_id'] ?? ''),
                    'planName' => (string)($r['planName'] ?? $r['plan_name'] ?? ($r['planId'] ?? '')),
                    'paymentId' => (string)($r['paymentId'] ?? $r['payment_id'] ?? ''),
                    'orderId' => (string)($r['orderId'] ?? $r['order_id'] ?? ''),
                    'amount' => (float)($r['amount'] ?? 0),
                    'currency' => (string)($r['currency'] ?? 'INR'),
                    'reason' => (string)($r['reason'] ?? ''),
                    'status' => (string)($r['status'] ?? 'pending'),
                    'gatewayStatus' => (string)($r['gatewayStatus'] ?? $r['gateway_status'] ?? 'manual_review_only'),
                    'gatewayRefundId' => !empty($r['gatewayRefundId']) ? (string)$r['gatewayRefundId'] : (!empty($r['gateway_refund_id']) ? (string)$r['gateway_refund_id'] : null),
                    'adminNote' => !empty($r['adminNote']) ? (string)$r['adminNote'] : (!empty($r['admin_note']) ? (string)$r['admin_note'] : null),
                    'reviewedBy' => !empty($r['reviewedBy']) ? (string)$r['reviewedBy'] : (!empty($r['reviewed_by']) ? (string)$r['reviewed_by'] : null),
                    'reviewedAt' => !empty($r['reviewedAt']) ? (string)$r['reviewedAt'] : (!empty($r['reviewed_at']) ? (string)$r['reviewed_at'] : null),
                    'createdAt' => (string)($r['createdAt'] ?? $r['created_at'] ?? gmdate('Y-m-d\TH:i:s\Z')),
                    'updatedAt' => (string)($r['updatedAt'] ?? $r['updated_at'] ?? gmdate('Y-m-d\TH:i:s\Z')),
                ];
            }
        }
    }
}

// Sort newest first
usort($allRequests, function ($a, $b) {
    return strtotime($b['createdAt'] ?? 'now') - strtotime($a['createdAt'] ?? 'now');
});

// Single item inspection
if (!empty($detailId)) {
    foreach ($allRequests as $item) {
        if ($item['id'] === $detailId || $item['subscriptionId'] === $detailId || $item['paymentId'] === $detailId || $item['orderId'] === $detailId) {
            jsonResponse(['success' => true, 'request' => $item]);
        }
    }
    jsonResponse(['success' => false, 'error' => 'Refund request record not found.'], 404);
}

// Compute statistics across all records
$total = count($allRequests);
$pending = 0;
$approved = 0;
$rejected = 0;
$refunded = 0;
$totalRefundAmount = 0.0;
$refundedAmount = 0.0;

foreach ($allRequests as $r) {
    $st = strtolower($r['status']);
    $amt = (float)$r['amount'];
    $totalRefundAmount += $amt;

    if ($st === 'pending') $pending++;
    elseif ($st === 'approved') $approved++;
    elseif ($st === 'rejected') $rejected++;
    elseif ($st === 'refunded') {
        $refunded++;
        $refundedAmount += $amt;
    }
}

// Apply status filter
$filtered = $allRequests;
if ($statusFilter !== 'all') {
    $filtered = array_values(array_filter($filtered, function ($r) use ($statusFilter) {
        return strtolower($r['status']) === $statusFilter;
    }));
}

// Apply search filter
if (!empty($search)) {
    $q = mb_strtolower($search, 'UTF-8');
    $filtered = array_values(array_filter($filtered, function ($r) use ($q) {
        return (
            str_contains(mb_strtolower($r['id'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['userId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['userName'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['userEmail'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['planId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['planName'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['paymentId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['orderId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['subscriptionId'], 'UTF-8'), $q) ||
            str_contains(mb_strtolower($r['reason'], 'UTF-8'), $q) ||
            (!empty($r['adminNote']) && str_contains(mb_strtolower($r['adminNote'], 'UTF-8'), $q))
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
        'pending' => $pending,
        'approved' => $approved,
        'rejected' => $rejected,
        'refunded' => $refunded,
        'totalRefundAmount' => $totalRefundAmount,
        'refundedAmount' => $refundedAmount,
    ],
    'pagination' => [
        'page' => $page,
        'limit' => $limit,
        'totalItems' => $totalItems,
        'totalPages' => $totalPages,
    ],
    'requests' => $paginated,
]);
