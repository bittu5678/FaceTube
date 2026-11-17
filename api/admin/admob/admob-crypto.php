<?php
/**
 * FaceTube - AdMob OAuth Cryptography & Token Protection Helper
 *
 * Implements:
 * 1. Cryptographically secure OAuth state generation & CSRF verification
 * 2. AES-256-GCM encryption & decryption for Google OAuth refresh tokens
 * 3. Configuration loaders for server-side OAuth credentials
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

/**
 * Returns the server master encryption key for AES-256-GCM.
 * Strictly reads ADMOB_ENCRYPTION_KEY and fails closed (returns null) if not set.
 * Never defaults to insecure fallbacks (APP_KEY, JWT_SECRET, or DB credentials).
 */
function getAdmobEncryptionKey() {
    $envKey = getenv('ADMOB_ENCRYPTION_KEY') ?: (
        $_ENV['ADMOB_ENCRYPTION_KEY'] ?? (
            $_SERVER['ADMOB_ENCRYPTION_KEY'] ?? null
        )
    );

    if (!empty($envKey)) {
        return (string)$envKey;
    }

    // Fail closed: No insecure fallbacks
    return null;
}

/**
 * Loads AdMob OAuth configuration strictly from server environment variables.
 */
function getAdmobOAuthConfig() {
    $clientId = getenv('ADMOB_OAUTH_CLIENT_ID') ?: ($_ENV['ADMOB_OAUTH_CLIENT_ID'] ?? ($_SERVER['ADMOB_OAUTH_CLIENT_ID'] ?? ''));
    $clientSecret = getenv('ADMOB_OAUTH_CLIENT_SECRET') ?: ($_ENV['ADMOB_OAUTH_CLIENT_SECRET'] ?? ($_SERVER['ADMOB_OAUTH_CLIENT_SECRET'] ?? ''));
    $redirectUri = getenv('ADMOB_OAUTH_REDIRECT_URI') ?: ($_ENV['ADMOB_OAUTH_REDIRECT_URI'] ?? ($_SERVER['ADMOB_OAUTH_REDIRECT_URI'] ?? ''));

    if (empty($redirectUri)) {
        $baseUrl = function_exists('getApiBaseUrl') ? getApiBaseUrl() : 'https://facetube.online';
        $redirectUri = rtrim($baseUrl, '/') . '/api/admin/admob/oauth-callback';
    }

    return [
        'clientId' => trim((string)$clientId),
        'clientSecret' => trim((string)$clientSecret),
        'redirectUri' => trim((string)$redirectUri),
        'isConfigured' => !empty($clientId) && !empty($clientSecret)
    ];
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns hexadecimal strings for ciphertext, IV (12 bytes), and GCM tag (16 bytes).
 */
function encryptSecret($plaintext, $secretKey) {
    if (empty($secretKey)) {
        throw new InvalidArgumentException('AdMob encryption key is required but missing.');
    }
    $key = hash('sha256', $secretKey, true); // exactly 32 bytes
    $iv = random_bytes(12); // Standard 12-byte IV for GCM
    $tag = '';
    $ciphertext = openssl_encrypt(
        $plaintext,
        'aes-256-gcm',
        $key,
        OPENSSL_RAW_DATA,
        $iv,
        $tag,
        '',
        16
    );

    if ($ciphertext === false) {
        throw new RuntimeException('AES-256-GCM encryption failed.');
    }

    return [
        'ciphertext' => bin2hex($ciphertext),
        'iv' => bin2hex($iv),
        'tag' => bin2hex($tag)
    ];
}

/**
 * Decrypts AES-256-GCM ciphertext using IV and authentication tag.
 * Returns decrypted plaintext or false if authentication fails or key is missing.
 */
function decryptSecret($ciphertextHex, $ivHex, $tagHex, $secretKey) {
    if (empty($secretKey)) {
        return false;
    }
    $key = hash('sha256', $secretKey, true);
    $ciphertext = hex2bin($ciphertextHex);
    $iv = hex2bin($ivHex);
    $tag = hex2bin($tagHex);

    if ($ciphertext === false || $iv === false || $tag === false) {
        return false;
    }

    return openssl_decrypt(
        $ciphertext,
        'aes-256-gcm',
        $key,
        OPENSSL_RAW_DATA,
        $iv,
        $tag
    );
}

function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64UrlDecode($data) {
    return base64_decode(strtr($data, '-_', '+/'));
}

/**
 * Generates a signed, tamper-proof OAuth state parameter with a 10-minute expiry.
 */
function generateOAuthState($userId, $nonce, $secretKey) {
    if (empty($secretKey)) {
        throw new InvalidArgumentException('AdMob encryption/signing key is required.');
    }
    $timestamp = time() * 1000;
    $payload = json_encode([
        'uid' => (string)$userId,
        'ts' => $timestamp,
        'n' => (string)$nonce
    ], JSON_UNESCAPED_SLASHES);

    $payloadB64 = base64UrlEncode($payload);
    $signature = base64UrlEncode(hash_hmac('sha256', $payloadB64, $secretKey, true));
    return "{$payloadB64}.{$signature}";
}

/**
 * Validates the OAuth state parameter against CSRF, expiration, and signature tampering.
 */
function verifyOAuthState($state, $secretKey) {
    if (empty($secretKey)) {
        return ['valid' => false, 'error' => 'Google AdMob encryption key is not configured.'];
    }
    if (empty($state) || !is_string($state) || strpos($state, '.') === false) {
        return ['valid' => false, 'error' => 'Malformed OAuth state parameter.'];
    }

    $parts = explode('.', $state, 2);
    $payloadB64 = $parts[0];
    $providedSig = $parts[1];

    $expectedSig = base64UrlEncode(hash_hmac('sha256', $payloadB64, $secretKey, true));
    if (!hash_equals($expectedSig, $providedSig)) {
        return ['valid' => false, 'error' => 'Invalid OAuth state signature (CSRF detection).'];
    }

    $raw = base64UrlDecode($payloadB64);
    $parsed = json_decode($raw, true);

    if (!is_array($parsed) || empty($parsed['uid']) || empty($parsed['ts']) || empty($parsed['n'])) {
        return ['valid' => false, 'error' => 'State payload missing required security claims.'];
    }

    $age = (time() * 1000) - intval($parsed['ts']);
    if ($age < 0 || $age > (10 * 60 * 1000)) { // 10 minutes maximum TTL
        return ['valid' => false, 'error' => 'OAuth state expired. Please re-initiate connection.'];
    }

    return [
        'valid' => true,
        'userId' => (string)$parsed['uid'],
        'nonce' => (string)$parsed['n'],
        'timestamp' => intval($parsed['ts'])
    ];
}

/**
 * Accurately detects whether the current request is over HTTPS.
 * Inspects native HTTPS flags and trusted reverse proxy headers.
 * Never blindly trusts X-Forwarded-Proto from untrusted public clients.
 */
function isAdmobHttpsRequest() {
    if (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (isset($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443) {
        return true;
    }
    // Reverse proxy detection: Only trust X-Forwarded-Proto if request came from trusted proxy
    $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
    $isTrustedProxy = in_array($remoteAddr, ['127.0.0.1', '::1'], true) ||
                      preg_match('/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/', $remoteAddr) ||
                      !empty($_SERVER['HTTP_CF_CONNECTING_IP']);
    if ($isTrustedProxy && !empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
        return strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https';
    }
    return false;
}
