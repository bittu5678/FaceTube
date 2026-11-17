<?php
/**
 * FaceTube - Admin Affiliate Networks Configuration API
 * GET  /api/admin/affiliate/settings.php - List all affiliate network configurations (secrets masked)
 * POST /api/admin/affiliate/settings.php - Update network parameters (strictly restricted to Admin)
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

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
        'error' => 'Admin authorization required. Access restricted to verified administrators.'
    ], 403);
}

// -----------------------------------------------------------------------------
// GET: Fetch All Affiliate Network Settings
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query('
            SELECT 
                id,
                name,
                is_active,
                creator_share_percentage,
                holding_period_days,
                allowed_domains,
                publisher_id,
                CASE WHEN webhook_secret IS NOT NULL AND webhook_secret != "" THEN 1 ELSE 0 END AS has_webhook_secret,
                CASE WHEN api_key_encrypted IS NOT NULL AND api_key_encrypted != "" THEN 1 ELSE 0 END AS has_api_key,
                settings_json,
                updated_by,
                created_at,
                updated_at
            FROM affiliate_networks_config
            ORDER BY id ASC
        ');
        $rows = $stmt->fetchAll();

        $networks = [];
        foreach ($rows as $r) {
            $networks[] = [
                'id' => $r['id'],
                'name' => $r['name'],
                'isActive' => (int)$r['is_active'] === 1,
                'creatorSharePercentage' => floatval($r['creator_share_percentage']),
                'holdingPeriodDays' => (int)$r['holding_period_days'],
                'allowedDomains' => $r['allowed_domains'],
                'publisherId' => $r['publisher_id'],
                'hasWebhookSecret' => (int)$r['has_webhook_secret'] === 1,
                'hasApiKey' => (int)$r['has_api_key'] === 1,
                'updatedBy' => $r['updated_by'],
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }

        jsonResponse([
            'success' => true,
            'networks' => $networks
        ]);
    } catch (Exception $e) {
        // Table may not exist yet if migration pending
        jsonResponse([
            'success' => true,
            'networks' => [
                [
                    'id' => 'amazon',
                    'name' => 'Amazon Associates',
                    'isActive' => false,
                    'creatorSharePercentage' => 0.0,
                    'holdingPeriodDays' => 0,
                    'allowedDomains' => 'amazon.in,amazon.com,amzn.to',
                    'publisherId' => null,
                    'hasWebhookSecret' => false,
                    'hasApiKey' => false
                ],
                [
                    'id' => 'impact',
                    'name' => 'Impact Radius',
                    'isActive' => false,
                    'creatorSharePercentage' => 0.0,
                    'holdingPeriodDays' => 0,
                    'allowedDomains' => 'impact.com,sjv.io,ojrq.net',
                    'publisherId' => null,
                    'hasWebhookSecret' => false,
                    'hasApiKey' => false
                ],
                [
                    'id' => 'earnkaro',
                    'name' => 'EarnKaro',
                    'isActive' => false,
                    'creatorSharePercentage' => 0.0,
                    'holdingPeriodDays' => 0,
                    'allowedDomains' => 'earnkaro.com,ekaro.in',
                    'publisherId' => null,
                    'hasWebhookSecret' => false,
                    'hasApiKey' => false
                ]
            ]
        ]);
    }
}

// -----------------------------------------------------------------------------
// POST: Update Affiliate Network Settings
// -----------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = getRequestPayload();
    $networkId = strtolower(trim((string)($payload['network_id'] ?? ($payload['id'] ?? ''))));

    if (empty($networkId) || !in_array($networkId, ['amazon', 'impact', 'earnkaro'], true)) {
        jsonResponse(['success' => false, 'error' => "Valid network_id is required ('amazon', 'impact', 'earnkaro')."], 400);
    }

    $isActive = isset($payload['is_active']) ? (bool)$payload['is_active'] : null;
    $creatorShare = isset($payload['creator_share_percentage']) ? floatval($payload['creator_share_percentage']) : null;
    $holdingDays = isset($payload['holding_period_days']) ? intval($payload['holding_period_days']) : null;
    $allowedDomains = isset($payload['allowed_domains']) ? trim((string)$payload['allowed_domains']) : null;
    $publisherId = isset($payload['publisher_id']) ? trim((string)$payload['publisher_id']) : null;
    $webhookSecret = isset($payload['webhook_secret']) ? trim((string)$payload['webhook_secret']) : null;

    if ($creatorShare !== null && ($creatorShare < 0 || $creatorShare > 100)) {
        jsonResponse(['success' => false, 'error' => 'Creator share percentage must be between 0.00 and 100.00%.'], 400);
    }

    if ($holdingDays !== null && $holdingDays < 0) {
        jsonResponse(['success' => false, 'error' => 'Holding period days cannot be negative.'], 400);
    }

    try {
        $fields = [];
        $params = [];

        if ($isActive !== null) {
            $fields[] = 'is_active = ?';
            $params[] = $isActive ? 1 : 0;
        }
        if ($creatorShare !== null) {
            $fields[] = 'creator_share_percentage = ?';
            $params[] = $creatorShare;
        }
        if ($holdingDays !== null) {
            $fields[] = 'holding_period_days = ?';
            $params[] = $holdingDays;
        }
        if ($allowedDomains !== null) {
            $fields[] = 'allowed_domains = ?';
            $params[] = $allowedDomains;
        }
        if ($publisherId !== null) {
            $fields[] = 'publisher_id = ?';
            $params[] = !empty($publisherId) ? $publisherId : null;
        }
        if ($webhookSecret !== null && $webhookSecret !== '') {
            $fields[] = 'webhook_secret = ?';
            $params[] = $webhookSecret;
        }

        if (empty($fields)) {
            jsonResponse(['success' => false, 'error' => 'No configuration fields supplied to update.'], 400);
        }

        $fields[] = 'updated_by = ?';
        $params[] = $authUser['user_id'];
        $fields[] = 'updated_at = NOW()';
        $params[] = $networkId;

        $sql = "UPDATE affiliate_networks_config SET " . implode(', ', $fields) . " WHERE id = ?";
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        jsonResponse([
            'success' => true,
            'message' => "Successfully updated affiliate configuration for {$networkId}.",
            'network_id' => $networkId
        ]);
    } catch (Exception $e) {
        jsonResponse(['success' => false, 'error' => 'Database error updating network config: ' . $e->getMessage()], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
