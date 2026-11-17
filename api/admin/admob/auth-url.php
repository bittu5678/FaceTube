<?php
/**
 * FaceTube - Admin AdMob OAuth Authorization URL Generator
 * GET /api/admin/admob/auth-url.php
 *
 * Strictly restricted to verified Administrators.
 * Generates an official Google OAuth 2.0 authorization URL with least-privilege
 * AdMob scopes and a cryptographically signed state parameter to prevent CSRF.
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
        'error' => 'Admin authorization required. Only administrators can connect Google AdMob.'
    ], 403);
}

$config = getAdmobOAuthConfig();

if (!$config['isConfigured']) {
    jsonResponse([
        'success' => false,
        'configured' => false,
        'error' => 'Google AdMob OAuth credentials are not configured. Please define ADMOB_OAUTH_CLIENT_ID and ADMOB_OAUTH_CLIENT_SECRET in your server environment.'
    ], 200);
}

$secretKey = getAdmobEncryptionKey();
if (empty($secretKey)) {
    jsonResponse([
        'success' => false,
        'configured' => false,
        'error' => 'Google AdMob encryption key is not configured. Please define ADMOB_ENCRYPTION_KEY in your server environment.'
    ], 200);
}

// 1. Generate cryptographically random 32-byte binding secret for this attempt
// Store SHA-256(binding_secret) in session_hash and SHA-256(initiating Admin session token) in admin_session_hash
// NEVER put the raw session token in the cookie
$bindingSecret = bin2hex(random_bytes(32));
$sessionHash = hash('sha256', $bindingSecret);
$adminToken = getBearerToken() ?: '';
$adminSessionHash = !empty($adminToken) ? hash('sha256', $adminToken) : '';
$nonce = bin2hex(random_bytes(16));
$userId = $authUser['user_id'] ?? 'ADMIN';

$state = generateOAuthState($userId, $nonce, $secretKey);
$stateHash = hash('sha256', $state);
$expiresAt = date('Y-m-d H:i:s', time() + 600);

// Fix A: Persist state to server-side store bound to admin user, binding secret hash, and admin session hash
// No runtime DDL: if table does not exist, fail safely with sanitized database error
try {
    $stmtState = $pdo->prepare('
        INSERT INTO admob_oauth_states (nonce, user_id, session_hash, admin_session_hash, state_hash, is_consumed, expires_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
    ');
    $stmtState->execute([$nonce, $userId, $sessionHash, $adminSessionHash, $stateHash, $expiresAt]);
} catch (PDOException $e) {
    jsonResponse([
        'success' => false,
        'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
    ], 500);
}

// Set secure HttpOnly session binding cookie carrying ONLY the random binding_secret
// Never puts the raw Admin session token in this cookie
setcookie('facetube_admob_oauth_binding', $bindingSecret, [
    'expires' => time() + 600,
    'path' => '/',
    'httponly' => true,
    'samesite' => 'Lax',
    'secure' => isAdmobHttpsRequest(),
]);

$scopes = [
    'https://www.googleapis.com/auth/admob.readonly',
    'https://www.googleapis.com/auth/admob.report',
];

$authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
    'client_id' => $config['clientId'],
    'redirect_uri' => $config['redirectUri'],
    'response_type' => 'code',
    'scope' => implode(' ', $scopes),
    'access_type' => 'offline',
    'prompt' => 'consent',
    'state' => $state,
]);

jsonResponse([
    'success' => true,
    'configured' => true,
    'auth_url' => $authUrl,
    'redirect_uri' => $config['redirectUri'],
    'expires_in' => 600, // State valid for 10 minutes
]);
