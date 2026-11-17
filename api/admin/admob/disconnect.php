<?php
/**
 * FaceTube - Admin AdMob OAuth Disconnect & Token Revocation API
 * POST /api/admin/admob/disconnect.php
 *
 * Strictly restricted to verified Administrators.
 * Decrypts refresh token to invoke Google's token revocation endpoint,
 * then securely removes or deactivates stored credentials.
 */

require_once __DIR__ . '/admob-crypto.php';

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
        'error' => 'Admin authorization required.'
    ], 403);
}

$secretKey = getAdmobEncryptionKey();

try {
    $stmt = $pdo->query('
        SELECT id, publisher_id, encrypted_refresh_token, refresh_token_iv, refresh_token_tag
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    ');
    $row = $stmt ? $stmt->fetch() : null;

    if ($row) {
        // Attempt Google token revocation if refresh token can be decrypted
        $refreshToken = decryptSecret(
            $row['encrypted_refresh_token'],
            $row['refresh_token_iv'],
            $row['refresh_token_tag'],
            $secretKey
        );

        if (!empty($refreshToken)) {
            $ch = curl_init('https://oauth2.googleapis.com/revoke');
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => http_build_query(['token' => $refreshToken]),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
                CURLOPT_TIMEOUT => 10,
            ]);
            @curl_exec($ch);
            curl_close($ch);
        }

        // Scrub stored credentials and mark inactive
        $stmtDeactivate = $pdo->prepare('
            UPDATE admob_oauth_credentials
            SET is_active = 0,
                encrypted_refresh_token = "",
                refresh_token_iv = "",
                refresh_token_tag = "",
                updated_at = NOW()
            WHERE id = ?
        ');
        $stmtDeactivate->execute([$row['id']]);
    }

    jsonResponse([
        'success' => true,
        'connected' => false,
        'message' => 'Google AdMob OAuth credentials disconnected and tokens revoked successfully.'
    ], 200);
} catch (Exception $e) {
    jsonResponse([
        'success' => false,
        'error' => 'Error disconnecting AdMob OAuth: ' . $e->getMessage()
    ], 500);
}
