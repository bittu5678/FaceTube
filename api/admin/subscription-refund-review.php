<?php
/**
 * FaceTube - Admin Subscription Refund Review API (Hostinger / cPanel PHP Production)
 * POST /api/admin/subscription-refund-review.php
 * Strictly restricted to verified administrators.
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

if (strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Access denied.'
    ], 403);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    $input = $_POST;
}

$requestId = trim($input['requestId'] ?? $input['request_id'] ?? '');
$decision = strtolower(trim($input['decision'] ?? ''));
$adminNote = trim($input['adminNote'] ?? $input['admin_note'] ?? '');

if (empty($requestId)) {
    jsonResponse(['success' => false, 'error' => 'Request ID is required.'], 400);
}

if ($decision !== 'approved' && $decision !== 'rejected') {
    jsonResponse(['success' => false, 'error' => "Invalid decision. Must be either 'approved' or 'rejected'."], 400);
}

$target = null;
$premiumFile = __DIR__ . '/../../data/premium_transactions.json';
$storeFile = __DIR__ . '/../../data/facetube_store.json';

// 1. Locate request in MySQL database if table exists
if ($pdo) {
    try {
        $stmt = $pdo->prepare("SELECT * FROM subscription_refund_requests WHERE id = ? LIMIT 1");
        $stmt->execute([$requestId]);
        $target = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        // Table not yet migrated
    }
}

// 2. Locate request in JSON stores if not found
if (!$target && file_exists($premiumFile)) {
    $pContent = json_decode(file_get_contents($premiumFile), true);
    if (!empty($pContent['refundRequests'])) {
        foreach ($pContent['refundRequests'] as $r) {
            if (($r['id'] ?? '') === $requestId) {
                $target = $r;
                break;
            }
        }
    }
}

if (!$target && file_exists($storeFile)) {
    $sContent = json_decode(file_get_contents($storeFile), true);
    if (!empty($sContent['subscriptionRefundRequests'])) {
        foreach ($sContent['subscriptionRefundRequests'] as $r) {
            if (($r['id'] ?? '') === $requestId) {
                $target = $r;
                break;
            }
        }
    }
}

if (!$target) {
    jsonResponse(['success' => false, 'error' => 'Refund request record not found.'], 404);
}

// 3. State transition guard: prevent double review
$currStatus = strtolower($target['status'] ?? 'pending');
if ($currStatus !== 'pending') {
    $reviewer = $target['reviewedBy'] ?? $target['reviewed_by'] ?? 'administrator';
    jsonResponse([
        'success' => false,
        'error' => "Refund request has already been processed with status '{$currStatus}' by {$reviewer}. Cannot re-review."
    ], 400);
}

$nowIso = gmdate('Y-m-d\TH:i:s\Z');
$subId = $target['subscriptionId'] ?? $target['subscription_id'] ?? '';
$paymentId = $target['paymentId'] ?? $target['payment_id'] ?? '';
$amount = floatval($target['amount'] ?? 0);
$reason = $target['reason'] ?? '';

// Helper to persist updates to JSON and MySQL
function saveRefundUpdates($targetId, $updates, $pdo, $premiumFile, $storeFile, $subId, $paymentId) {
    // MySQL
    if ($pdo) {
        try {
            $stmt = $pdo->prepare('
                UPDATE subscription_refund_requests
                SET status = ?, gateway_status = ?, gateway_refund_id = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = NOW()
                WHERE id = ?
            ');
            $stmt->execute([
                $updates['status'],
                $updates['gatewayStatus'],
                $updates['gatewayRefundId'] ?? null,
                $updates['adminNote'] ?? null,
                $updates['reviewedBy'] ?? null,
                gmdate('Y-m-d H:i:s'),
                $targetId
            ]);

            if ($updates['status'] === 'refunded') {
                $subStmt = $pdo->prepare("UPDATE user_subscriptions SET status = 'refunded', updated_at = NOW() WHERE subscription_id = ? OR payment_id = ?");
                $subStmt->execute([$subId, $paymentId]);
            }
        } catch (Exception $e) {
            // Ignore
        }
    }

    // JSON: premium_transactions.json
    if (file_exists($premiumFile)) {
        $pContent = json_decode(file_get_contents($premiumFile), true);
        if (!empty($pContent['refundRequests'])) {
            foreach ($pContent['refundRequests'] as &$r) {
                if (($r['id'] ?? '') === $targetId) {
                    $r = array_merge($r, $updates);
                    break;
                }
            }
        }
        if ($updates['status'] === 'refunded' && !empty($pContent['userSubscriptions'])) {
            foreach ($pContent['userSubscriptions'] as &$s) {
                if (($s['subscriptionId'] ?? '') === $subId || ($s['paymentId'] ?? '') === $paymentId) {
                    $s['status'] = 'refunded';
                }
            }
        }
        file_put_contents($premiumFile, json_encode($pContent, JSON_PRETTY_PRINT));
    }

    // JSON: facetube_store.json
    if (file_exists($storeFile)) {
        $sContent = json_decode(file_get_contents($storeFile), true);
        if (!empty($sContent['subscriptionRefundRequests'])) {
            foreach ($sContent['subscriptionRefundRequests'] as &$r) {
                if (($r['id'] ?? '') === $targetId) {
                    $r = array_merge($r, $updates);
                    break;
                }
            }
        }
        if ($updates['status'] === 'refunded' && !empty($sContent['userSubscriptions'])) {
            foreach ($sContent['userSubscriptions'] as &$s) {
                if (($s['subscription_id'] ?? '') === $subId || ($s['payment_id'] ?? '') === $paymentId) {
                    $s['status'] = 'refunded';
                }
            }
        }
        file_put_contents($storeFile, json_encode($sContent, JSON_PRETTY_PRINT));
    }
}

if ($decision === 'rejected') {
    $note = !empty($adminNote) ? $adminNote : 'Refund request rejected by administrator.';
    $updates = [
        'status' => 'rejected',
        'gatewayStatus' => 'manual_review_only',
        'gatewayRefundId' => null,
        'adminNote' => $note,
        'reviewedBy' => $authUser['user_id'],
        'reviewedAt' => $nowIso,
        'updatedAt' => $nowIso
    ];
    $updatedRecord = array_merge($target, $updates);
    saveRefundUpdates($target['id'], $updates, $pdo, $premiumFile, $storeFile, $subId, $paymentId);

    jsonResponse([
        'success' => true,
        'message' => 'Refund request has been rejected.',
        'request' => $updatedRecord
    ]);
}

// Decision === 'approved'
$rzpConfig = getRazorpayConfig();
$rzpKey = $rzpConfig['keyId'];
$rzpSecret = $rzpConfig['keySecret'];
$skipRemote = (getenv('RAZORPAY_SKIP_REMOTE_CHECK') ?: ($_ENV['RAZORPAY_SKIP_REMOTE_CHECK'] ?? '')) === 'true';

$gatewaySuccess = false;
$gatewayRefundId = null;
$gatewayError = null;

if (!empty($rzpKey) && !empty($rzpSecret) && !$skipRemote && !empty($paymentId) && $amount > 0) {
    $amountPaise = (int)round($amount * 100);
    $ch = curl_init("https://api.razorpay.com/v1/payments/" . urlencode($paymentId) . "/refund");
    curl_setopt($ch, CURLOPT_USERPWD, "{$rzpKey}:{$rzpSecret}");
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'amount' => $amountPaise,
        'speed' => 'normal',
        'notes' => [
            'reason' => substr($reason, 0, 255),
            'refunded_at' => $nowIso
        ]
    ]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);

    $rawResponse = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode >= 200 && $httpCode < 300 && !empty($rawResponse)) {
        $resJson = json_decode($rawResponse, true);
        if (!empty($resJson['id'])) {
            $gatewaySuccess = true;
            $gatewayRefundId = $resJson['id'];
        }
    } else {
        $errJson = json_decode($rawResponse, true);
        $gatewayError = $errJson['error']['description'] ?? "Razorpay refund failed with HTTP {$httpCode}";
    }
}

if ($gatewaySuccess && !empty($gatewayRefundId)) {
    $note = !empty($adminNote) ? $adminNote : 'Refund approved and successfully processed via Razorpay gateway.';
    $updates = [
        'status' => 'refunded',
        'gatewayStatus' => 'gateway_refund_succeeded',
        'gatewayRefundId' => $gatewayRefundId,
        'adminNote' => $note,
        'reviewedBy' => $authUser['user_id'],
        'reviewedAt' => $nowIso,
        'updatedAt' => $nowIso
    ];
    $updatedRecord = array_merge($target, $updates);
    saveRefundUpdates($target['id'], $updates, $pdo, $premiumFile, $storeFile, $subId, $paymentId);

    jsonResponse([
        'success' => true,
        'message' => 'Refund approved and successfully processed via Razorpay gateway.',
        'request' => $updatedRecord,
        'gatewayAvailable' => true,
        'gatewayRefundId' => $gatewayRefundId
    ]);
}

// Credentials not configured, remote call skipped, or gateway error:
// Strictly adhere to Rule: Never simulate fake gateway refunds. Mark as approved in review mode only.
$gatewayStatus = empty($rzpKey) || empty($rzpSecret) ? 'gateway_not_configured' : ($skipRemote ? 'gateway_unavailable' : 'gateway_error');
$safeNote = !empty($adminNote)
    ? "{$adminNote} [Safe Review: Live gateway refund unavailable - " . ($gatewayError ?: "Credentials unconfigured") . "]"
    : "Approved in safe review workflow. Live Razorpay gateway credentials are not configured on server; actual gateway refund remains unavailable. No simulated refund was dispatched.";

$updates = [
    'status' => 'approved',
    'gatewayStatus' => $gatewayStatus,
    'gatewayRefundId' => null,
    'adminNote' => $safeNote,
    'reviewedBy' => $authUser['user_id'],
    'reviewedAt' => $nowIso,
    'updatedAt' => $nowIso
];
$updatedRecord = array_merge($target, $updates);
saveRefundUpdates($target['id'], $updates, $pdo, $premiumFile, $storeFile, $subId, $paymentId);

jsonResponse([
    'success' => true,
    'message' => 'Refund request approved by administrator. Note: Actual gateway refund remains unavailable without configured live gateway credentials.',
    'request' => $updatedRecord,
    'gatewayAvailable' => false,
    'gatewayStatus' => $gatewayStatus,
    'gatewayMessage' => $gatewayError ?: 'Live gateway credentials unconfigured or remote execution disabled.'
]);
