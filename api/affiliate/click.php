<?php
/**
 * FaceTube - Affiliate Marketing Click Tracking API
 * POST /api/affiliate/click.php - Records an outbound affiliate click and returns tracking metadata
 * GET /api/affiliate/click.php  - Records click and issues safe HTTP 302 redirect to validated destination
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();

/**
 * Validates a target URL against open redirect and SSRF vulnerabilities.
 * 1. Protocol must be strictly http or https.
 * 2. No embedded userinfo (credentials in URL).
 * 3. Host must be non-empty and match one of the allowed domain suffixes.
 * 4. Resolves IP to ensure it does not route to private, loopback, or cloud-metadata addresses.
 */
function validateSafeAffiliateUrl($url, array $allowedDomains): array {
    $raw = trim((string)$url);
    if (empty($raw)) {
        return ['valid' => false, 'error' => 'Target URL cannot be empty.'];
    }

    $parts = parse_url($raw);
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) {
        return ['valid' => false, 'error' => 'Invalid URL structure. Must include scheme and hostname.'];
    }

    $scheme = strtolower($parts['scheme']);
    if ($scheme !== 'https' && $scheme !== 'http') {
        return ['valid' => false, 'error' => 'Disallowed scheme. Only HTTPS and HTTP destination URLs are permitted.'];
    }

    if (!empty($parts['user']) || !empty($parts['pass'])) {
        return ['valid' => false, 'error' => 'URLs containing embedded credentials are not allowed.'];
    }

    $host = strtolower($parts['host']);

    // Disallow loopback / localhost strings directly
    if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
        return ['valid' => false, 'error' => 'Destination host is a forbidden local loopback address.'];
    }

    // Check against allowed domains whitelist
    $isAllowed = false;
    foreach ($allowedDomains as $allowed) {
        $allowed = strtolower(trim($allowed));
        if (empty($allowed)) continue;
        if ($host === $allowed || str_ends_with($host, '.' . $allowed)) {
            $isAllowed = true;
            break;
        }
    }

    if (!$isAllowed) {
        return [
            'valid' => false,
            'error' => "Destination host '{$host}' is not in the approved affiliate network whitelist."
        ];
    }

    // SSRF IP validation (prevent private/internal network access)
    $ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : @gethostbyname($host);
    if ($ip && filter_var($ip, FILTER_VALIDATE_IP)) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return ['valid' => false, 'error' => 'Destination host resolves to a private or reserved network IP address.'];
        }
    }

    return ['valid' => true, 'url' => $raw, 'host' => $host];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$payload = ($method === 'POST') ? getRequestPayload() : $_GET;

$network = strtolower(trim((string)($payload['network'] ?? ($payload['n'] ?? ''))));
$creatorUserId = strtoupper(trim((string)($payload['creator_user_id'] ?? ($payload['creatorUserId'] ?? ($payload['c'] ?? '')))));
$targetUrl = trim((string)($payload['target_url'] ?? ($payload['targetUrl'] ?? ($payload['u'] ?? ''))));
$videoId = trim((string)($payload['video_id'] ?? ($payload['videoId'] ?? ($payload['v'] ?? ''))));
$shouldRedirect = isset($payload['redirect']) && ($payload['redirect'] === '1' || $payload['redirect'] === 'true');

if (empty($network)) {
    jsonResponse(['success' => false, 'error' => 'Affiliate network is required (e.g. amazon, impact, earnkaro).'], 400);
}

if (empty($creatorUserId)) {
    jsonResponse(['success' => false, 'error' => 'Creator user ID (creator_user_id) is required for attribution.'], 400);
}

if (empty($targetUrl)) {
    jsonResponse(['success' => false, 'error' => 'Target affiliate destination URL is required.'], 400);
}

// 1. Fetch network configuration and allowed domain whitelist from database
$allowedDomains = [];
$networkConfig = null;
try {
    $stmt = $pdo->prepare('SELECT id, name, is_active, allowed_domains, publisher_id FROM affiliate_networks_config WHERE id = ? LIMIT 1');
    $stmt->execute([$network]);
    $networkConfig = $stmt->fetch();
} catch (Exception $e) {
    // Table may not exist yet if migration pending; use safe default domain fallbacks
}

if ($networkConfig && !empty($networkConfig['allowed_domains'])) {
    $allowedDomains = array_map('trim', explode(',', $networkConfig['allowed_domains']));
} else {
    // Default fallback whitelists for supported networks
    if ($network === 'amazon') {
        $allowedDomains = ['amazon.in', 'amazon.com', 'amzn.to', 'amzn.eu', 'amzn.asia'];
    } elseif ($network === 'impact') {
        $allowedDomains = ['impact.com', 'sjv.io', 'ojrq.net', 'pxf.io', 'evyy.net'];
    } elseif ($network === 'earnkaro') {
        $allowedDomains = ['earnkaro.com', 'ekaro.in'];
    }
}

if (empty($allowedDomains)) {
    jsonResponse(['success' => false, 'error' => "Unsupported or unconfigured affiliate network: '{$network}'."], 400);
}

// 2. Validate URL against SSRF and open-redirect vulnerabilities
$validation = validateSafeAffiliateUrl($targetUrl, $allowedDomains);
if (!$validation['valid']) {
    jsonResponse(['success' => false, 'error' => $validation['error']], 400);
}

// 3. Verify creator exists
try {
    $uStmt = $pdo->prepare('SELECT user_id, name FROM users WHERE UPPER(user_id) = ? LIMIT 1');
    $uStmt->execute([$creatorUserId]);
    $creator = $uStmt->fetch();
    if (!$creator) {
        jsonResponse(['success' => false, 'error' => "Creator user ID '{$creatorUserId}' was not found."], 404);
    }
    $canonicalCreatorId = $creator['user_id'];
} catch (Exception $e) {
    $canonicalCreatorId = $creatorUserId;
}

// 4. Record click for attribution
$clickId = 'clk_' . bin2hex(random_bytes(16));
$clientIp = $_SERVER['REMOTE_ADDR'] ?? '';
$ipHash = !empty($clientIp) ? hash('sha256', $clientIp . (getenv('APP_KEY') ?: 'facetube_salt')) : null;
$userAgent = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255);
$referrer = substr($_SERVER['HTTP_REFERER'] ?? '', 0, 255);

try {
    $insStmt = $pdo->prepare('
        INSERT INTO affiliate_clicks (
            id, network, creator_user_id, video_id, target_url, ip_hash, user_agent, referrer, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ');
    $insStmt->execute([
        $clickId,
        $network,
        $canonicalCreatorId,
        !empty($videoId) ? $videoId : null,
        $validation['url'],
        $ipHash,
        $userAgent,
        $referrer
    ]);
} catch (Exception $e) {
    // Log error, continue to serve redirect/response if click table is pending
}

// 5. Respond with 302 redirect or JSON metadata
if ($method === 'GET' && $shouldRedirect) {
    header("Location: {$validation['url']}", true, 302);
    exit;
}

jsonResponse([
    'success' => true,
    'click_id' => $clickId,
    'network' => $network,
    'creator_user_id' => $canonicalCreatorId,
    'target_url' => $validation['url'],
    'video_id' => !empty($videoId) ? $videoId : null
]);
