<?php
/**
 * FaceTube - User Subscription Refund Requests List API
 * GET /api/subscriptions/refund-requests.php
 * Authenticated endpoint returning logged-in user's refund request history.
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

$premiumFile = __DIR__ . '/../../data/premium_transactions.json';
$userRequests = [];

if (file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!empty($pContent['refundRequests'])) {
        foreach ($pContent['refundRequests'] as $r) {
            if (strtoupper($r['userId'] ?? '') === strtoupper($authUser['user_id'])) {
                $userRequests[] = $r;
            }
        }
    }
}

usort($userRequests, function ($a, $b) {
    return strtotime($b['createdAt'] ?? 'now') - strtotime($a['createdAt'] ?? 'now');
});

jsonResponse([
    'success' => true,
    'requests' => $userRequests
]);
