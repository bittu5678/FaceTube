<?php
/**
 * FaceTube - Admin AdMob OAuth Connection Status API
 * GET /api/admin/admob/status.php
 *
 * Strictly restricted to verified Administrators.
 * Returns public connection metadata (status, publisher ID, currency code).
 * Strict Zero-Exposure: Tokens and keys are NEVER returned in the response.
 */

require_once __DIR__ . '/admob-crypto.php';

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
        'error' => 'Admin authorization required.'
    ], 403);
}

try {
    $stmt = $pdo->query('
        SELECT publisher_id, account_name, currency_code, is_active, connected_by, created_at, updated_at
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    ');
    $row = $stmt ? $stmt->fetch() : null;

    if ($row) {
        jsonResponse([
            'success' => true,
            'connected' => true,
            'publisher_id' => $row['publisher_id'],
            'account_name' => $row['account_name'],
            'currency_code' => $row['currency_code'],
            'connected_by' => $row['connected_by'],
            'connected_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
            'has_refresh_token' => true,
        ]);
    }
} catch (PDOException $e) {
    // Return disconnected on database or table uninitialized state
}

jsonResponse([
    'success' => true,
    'connected' => false,
    'publisher_id' => null,
    'account_name' => null,
    'currency_code' => null,
    'has_refresh_token' => false,
]);
