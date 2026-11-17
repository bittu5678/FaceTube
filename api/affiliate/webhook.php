<?php
/**
 * FaceTube - Secure Affiliate Marketing Webhook / Postback Ingestion API
 * POST /api/affiliate/webhook.php?network=amazon|impact|earnkaro
 *
 * Enforces:
 * 1. Network active check (rejects with 503 if inactive/unconfigured)
 * 2. Webhook HMAC signature or bearer token verification (rejects unsigned callbacks with 401)
 * 3. Duplicate conversion idempotency check on (network, external_action_id)
 * 4. Ingests strictly as 'pending' - NEVER credits wallet or income_ledger on ingestion
 * 5. Logs ingestion event into affiliate_audit_log
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. Webhook callbacks require POST.'], 405);
}

$pdo = getDatabaseConnection();

$network = strtolower(trim((string)($_GET['network'] ?? ($_GET['n'] ?? ''))));
if (empty($network)) {
    // Fallback: check request payload for network
    $rawBody = file_get_contents('php://input');
    $parsed = json_decode($rawBody, true);
    $network = strtolower(trim((string)($parsed['network'] ?? '')));
}

if (!in_array($network, ['amazon', 'impact', 'earnkaro'], true)) {
    jsonResponse(['success' => false, 'error' => "Invalid or missing affiliate network parameter."], 400);
}

// 1. Fetch network configuration
$netConfig = null;
try {
    $stmt = $pdo->prepare('
        SELECT id, name, is_active, creator_share_percentage, holding_period_days, webhook_secret, settings_json
        FROM affiliate_networks_config
        WHERE id = ?
        LIMIT 1
    ');
    $stmt->execute([$network]);
    $netConfig = $stmt->fetch();
} catch (Exception $e) {
    jsonResponse(['success' => false, 'error' => 'Database error loading network config.'], 500);
}

if (!$netConfig) {
    jsonResponse(['success' => false, 'error' => "Affiliate network '{$network}' is not configured."], 404);
}

// 2. Reject inactive provider adapters
if (empty($netConfig['is_active']) || intval($netConfig['is_active']) !== 1) {
    jsonResponse([
        'success' => false,
        'error' => "Affiliate network '{$netConfig['name']}' is currently inactive. Ingestion is disabled pending corporate credentials and contract activation."
    ], 503);
}

// 3. Signature / Token verification
$rawPayload = file_get_contents('php://input');
$configuredSecret = trim((string)($netConfig['webhook_secret'] ?? ''));

if (empty($configuredSecret)) {
    jsonResponse([
        'success' => false,
        'error' => "Network webhook verification secret is not configured. Rejecting untrusted callback."
    ], 401);
}

// Check headers for signature
$providedSig = $_SERVER['HTTP_X_SIGNATURE'] 
    ?? ($_SERVER['HTTP_X_IMPACT_SIGNATURE'] 
    ?? ($_SERVER['HTTP_X_HUB_SIGNATURE_256'] 
    ?? ($_SERVER['HTTP_X_WEBHOOK_TOKEN'] ?? '')));

if (empty($providedSig)) {
    // Check Authorization header for Bearer or Token
    $authHeader = getBearerToken();
    if ($authHeader) {
        $providedSig = $authHeader;
    }
}

$isVerified = false;
if (!empty($providedSig)) {
    // 3a. Token direct match
    if (hash_equals($configuredSecret, $providedSig)) {
        $isVerified = true;
    } else {
        // 3b. HMAC-SHA256 signature verification
        $computedHmac = hash_hmac('sha256', $rawPayload, $configuredSecret);
        $cleanSig = preg_replace('/^sha256=/i', '', $providedSig);
        if (hash_equals($computedHmac, $cleanSig)) {
            $isVerified = true;
        }
    }
}

if (!$isVerified) {
    jsonResponse([
        'success' => false,
        'error' => "Invalid or missing webhook signature. Unauthorized."
    ], 401);
}

// 4. Parse incoming conversion data
$data = json_decode($rawPayload, true);
if (!is_array($data)) {
    parse_str($rawPayload, $data);
}

if (empty($data) || !is_array($data)) {
    jsonResponse(['success' => false, 'error' => 'Malformed or empty webhook payload.'], 400);
}

// Extract external action ID (order ID or transaction ID from provider)
$externalActionId = trim((string)(
    $data['external_action_id'] 
    ?? ($data['action_id'] 
    ?? ($data['order_id'] 
    ?? ($data['sub_id'] 
    ?? ($data['transaction_id'] ?? ''))))
));

if (empty($externalActionId)) {
    jsonResponse(['success' => false, 'error' => 'Missing external action or order ID in callback.'], 400);
}

// Extract creator user ID
$creatorUserId = strtoupper(trim((string)(
    $data['creator_user_id'] 
    ?? ($data['creatorUserId'] 
    ?? ($data['sub_id1'] 
    ?? ($data['custom_id'] 
    ?? ($data['user_id'] ?? ''))))
)));

// Optional click ID
$clickId = trim((string)($data['click_id'] ?? ($data['clickId'] ?? ($data['sub_id2'] ?? ''))));
$videoId = trim((string)($data['video_id'] ?? ($data['videoId'] ?? '')));

// Amounts
$orderAmount = floatval($data['order_amount'] ?? ($data['orderAmount'] ?? ($data['amount'] ?? 0.00)));
$totalCommission = floatval($data['commission'] ?? ($data['total_commission'] ?? ($data['payout'] ?? 0.00)));
$currency = strtoupper(trim((string)($data['currency'] ?? 'INR')));

if ($totalCommission < 0) {
    jsonResponse(['success' => false, 'error' => 'Commission amount cannot be negative.'], 400);
}

// If creator user ID not directly present, attempt resolution from click_id
if (empty($creatorUserId) && !empty($clickId)) {
    try {
        $clkStmt = $pdo->prepare('SELECT creator_user_id, video_id FROM affiliate_clicks WHERE id = ? LIMIT 1');
        $clkStmt->execute([$clickId]);
        $clkRow = $clkStmt->fetch();
        if ($clkRow) {
            $creatorUserId = $clkRow['creator_user_id'];
            if (empty($videoId) && !empty($clkRow['video_id'])) {
                $videoId = $clkRow['video_id'];
            }
        }
    } catch (Exception $e) {
        // Continue
    }
}

if (empty($creatorUserId)) {
    jsonResponse(['success' => false, 'error' => 'Attributed creator user ID could not be identified.'], 400);
}

// Verify creator user ID exists
try {
    $uStmt = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = ? LIMIT 1');
    $uStmt->execute([$creatorUserId]);
    $creator = $uStmt->fetch();
    if (!$creator) {
        jsonResponse(['success' => false, 'error' => "Creator user ID '{$creatorUserId}' not found in database."], 404);
    }
    $canonicalCreatorId = $creator['user_id'];
} catch (Exception $e) {
    $canonicalCreatorId = $creatorUserId;
}

// Calculate creator share and settlement due date based on platform settings
$creatorSharePct = floatval($netConfig['creator_share_percentage'] ?? 0.00);
$creatorPayout = round(($totalCommission * $creatorSharePct) / 100, 2);
$holdingDays = intval($netConfig['holding_period_days'] ?? 0);
$settlementDueAt = date('Y-m-d H:i:s', time() + ($holdingDays * 86400));
$payloadHash = hash('sha256', $rawPayload);
$conversionId = 'conv_' . bin2hex(random_bytes(16));

// 5. Ingest into affiliate_conversions with duplicate prevention
try {
    // Check if conversion already exists
    $dupStmt = $pdo->prepare('
        SELECT id, network, external_action_id, status, creator_payout, created_at
        FROM affiliate_conversions
        WHERE network = ? AND external_action_id = ?
        LIMIT 1
    ');
    $dupStmt->execute([$network, $externalActionId]);
    $existing = $dupStmt->fetch();

    if ($existing) {
        jsonResponse([
            'success' => true,
            'idempotent' => true,
            'message' => "Conversion already processed for network '{$network}' and action ID '{$externalActionId}'.",
            'conversion_id' => $existing['id'],
            'status' => $existing['status']
        ], 200);
    }

    $pdo->beginTransaction();

    $insStmt = $pdo->prepare('
        INSERT INTO affiliate_conversions (
            id, network, external_action_id, click_id, creator_user_id, video_id,
            order_amount, total_commission, creator_share_percentage, creator_payout,
            currency, status, settlement_due_at, raw_payload_hash, notes, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, "pending", ?, ?, ?, NOW()
        )
    ');

    $insStmt->execute([
        $conversionId,
        $network,
        $externalActionId,
        !empty($clickId) ? $clickId : null,
        $canonicalCreatorId,
        !empty($videoId) ? $videoId : null,
        $orderAmount,
        $totalCommission,
        $creatorSharePct,
        $creatorPayout,
        $currency,
        $settlementDueAt,
        $payloadHash,
        "Ingested via verified {$netConfig['name']} webhook callback"
    ]);

    // Audit log
    $auditId = 'aud_' . bin2hex(random_bytes(16));
    $auditStmt = $pdo->prepare('
        INSERT INTO affiliate_audit_log (
            id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at
        ) VALUES (?, ?, "ingested", NULL, "pending", 0.00, "SYSTEM_WEBHOOK", ?, NOW())
    ');
    $auditStmt->execute([
        $auditId,
        $conversionId,
        "Initial verified ingestion from {$network} webhook."
    ]);

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'message' => "Successfully ingested verified conversion in pending status.",
        'conversion_id' => $conversionId,
        'network' => $network,
        'external_action_id' => $externalActionId,
        'creator_user_id' => $canonicalCreatorId,
        'total_commission' => $totalCommission,
        'creator_payout' => $creatorPayout,
        'status' => 'pending',
        'settlement_due_at' => $settlementDueAt
    ], 201);
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    // Handle duplicate key error code 23000 / 1062
    if ($e->getCode() === '23000' || str_contains($e->getMessage(), 'Duplicate entry')) {
        jsonResponse([
            'success' => true,
            'idempotent' => true,
            'message' => "Duplicate conversion detected and safely ignored for action '{$externalActionId}'."
        ], 200);
    }
    jsonResponse(['success' => false, 'error' => 'Database error recording conversion: ' . $e->getMessage()], 500);
}
