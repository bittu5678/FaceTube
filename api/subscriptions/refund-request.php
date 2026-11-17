<?php
/**
 * FaceTube - User Subscription Refund Request API
 * POST /api/subscriptions/refund-request.php
 * Authenticated endpoint for requesting a refund on a paid subscription.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
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

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    $input = $_POST;
}

$subscriptionId = trim($input['subscriptionId'] ?? $input['subscription_id'] ?? '');
$reason = trim($input['reason'] ?? '');

if (empty($subscriptionId)) {
    jsonResponse(['success' => false, 'error' => 'Subscription ID is required.'], 400);
}

if (strlen($reason) < 5) {
    jsonResponse(['success' => false, 'error' => 'Please provide a detailed reason for the refund request (minimum 5 characters).'], 400);
}

if (strlen($reason) > 1000) {
    jsonResponse(['success' => false, 'error' => 'Reason must not exceed 1000 characters.'], 400);
}

// 1. Locate subscription and enforce user ownership
$sub = null;
if ($pdo) {
    try {
        $stmt = $pdo->prepare("SELECT * FROM user_subscriptions WHERE subscription_id = ? OR payment_id = ? OR order_id = ? LIMIT 1");
        $stmt->execute([$subscriptionId, $subscriptionId, $subscriptionId]);
        $sub = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        // Fallback to local store
    }
}

$storeFile = __DIR__ . '/../../data/facetube_store.json';
$premiumFile = __DIR__ . '/../../data/premium_transactions.json';

if (!$sub && file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!empty($pContent['userSubscriptions'])) {
        foreach ($pContent['userSubscriptions'] as $s) {
            if (($s['subscriptionId'] ?? '') === $subscriptionId || ($s['paymentId'] ?? '') === $subscriptionId || ($s['orderId'] ?? '') === $subscriptionId) {
                $sub = $s;
                break;
            }
        }
    }
}

if (!$sub && file_exists($storeFile)) {
    $sContent = json_decode(file_get_contents($storeFile), true);
    if (!empty($sContent['userSubscriptions'])) {
        foreach ($sContent['userSubscriptions'] as $s) {
            if (($s['subscription_id'] ?? '') === $subscriptionId || ($s['payment_id'] ?? '') === $subscriptionId || ($s['order_id'] ?? '') === $subscriptionId) {
                $sub = $s;
                break;
            }
        }
    }
}

if (!$sub) {
    jsonResponse(['success' => false, 'error' => 'Subscription record not found.'], 404);
}

$subUserId = $sub['user_id'] ?? $sub['userId'] ?? '';
if (strtoupper($subUserId) !== strtoupper($authUser['user_id'])) {
    jsonResponse(['success' => false, 'error' => 'Unauthorized: You can only submit refund requests for your own subscriptions.'], 403);
}

$subStatus = $sub['status'] ?? 'active';
if ($subStatus === 'refunded') {
    jsonResponse(['success' => false, 'error' => 'This subscription has already been refunded.'], 400);
}

$paymentId = $sub['payment_id'] ?? $sub['paymentId'] ?? '';
$orderId = $sub['order_id'] ?? $sub['orderId'] ?? '';
$amount = floatval($sub['amount'] ?? 0);
$planId = $sub['plan_id'] ?? $sub['planId'] ?? '';
$subId = $sub['subscription_id'] ?? $sub['subscriptionId'] ?? $subscriptionId;

if (empty($paymentId) || $amount <= 0) {
    jsonResponse(['success' => false, 'error' => 'No verified captured payment record found for this subscription.'], 400);
}

// 2. Check duplicate refund request
$existingRequests = [];
if (file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!empty($pContent['refundRequests'])) {
        $existingRequests = $pContent['refundRequests'];
    }
}

foreach ($existingRequests as $r) {
    if ((($r['subscriptionId'] ?? '') === $subId || ($r['paymentId'] ?? '') === $paymentId) &&
        in_array($r['status'] ?? '', ['pending', 'approved', 'processing', 'refunded'])) {
        jsonResponse([
            'success' => false,
            'error' => "A refund request for this subscription payment has already been submitted and is currently " . $r['status'] . ". Duplicate refund requests are not permitted.",
            'request' => $r
        ], 409);
    }
}

$newReq = [
    'id' => 'rfnd_' . time() . '_' . bin2hex(random_bytes(4)),
    'subscriptionId' => $subId,
    'userId' => $authUser['user_id'],
    'userName' => $authUser['name'] ?? 'Member',
    'userEmail' => $authUser['email'] ?? '',
    'planId' => $planId,
    'planName' => $planId,
    'paymentId' => $paymentId,
    'orderId' => $orderId,
    'amount' => $amount,
    'currency' => $sub['currency'] ?? 'INR',
    'reason' => $reason,
    'status' => 'pending',
    'gatewayStatus' => 'manual_review_only',
    'gatewayRefundId' => null,
    'adminNote' => null,
    'reviewedBy' => null,
    'reviewedAt' => null,
    'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
    'updatedAt' => gmdate('Y-m-d\TH:i:s\Z')
];

// Persist
if (file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!isset($pContent['refundRequests'])) {
        $pContent['refundRequests'] = [];
    }
    array_unshift($pContent['refundRequests'], $newReq);
    file_put_contents($premiumFile, json_encode($pContent, JSON_PRETTY_PRINT));
}

jsonResponse([
    'success' => true,
    'message' => 'Refund request submitted successfully. It will be reviewed by an administrator.',
    'request' => $newReq
], 201);
