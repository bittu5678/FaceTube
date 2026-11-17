<?php
/**
 * FaceTube - Creator Affiliate Link Generator API
 * GET  /api/affiliate/create-link.php - Returns supported networks and domain whitelists
 * POST /api/affiliate/create-link.php - Generates a secure creator-attributed affiliate tracking URL
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';
require_once __DIR__ . '/click.php'; // Reuse validateSafeAffiliateUrl()

$supportedNetworks = [
    'amazon' => [
        'id' => 'amazon',
        'name' => 'Amazon Associates',
        'allowed_domains' => ['amazon.in', 'amazon.com', 'amzn.to', 'amzn.eu', 'amzn.asia'],
        'example_url' => 'https://www.amazon.in/dp/B08N5WRWNW',
        'description' => 'Earn commissions on physical and digital products across Amazon stores.',
    ],
    'impact' => [
        'id' => 'impact',
        'name' => 'Impact',
        'allowed_domains' => ['impact.com', 'sjv.io', 'ojrq.net', 'pxf.io', 'evyy.net'],
        'example_url' => 'https://brand.sjv.io/c/12345/67890/1234',
        'description' => 'Partner campaigns, SaaS tools, premium gear, and direct brand sponsorships.',
    ],
    'earnkaro' => [
        'id' => 'earnkaro',
        'name' => 'EarnKaro',
        'allowed_domains' => ['earnkaro.com', 'ekaro.in'],
        'example_url' => 'https://ekaro.in/enkr2026',
        'description' => 'Curated deals, fashion, electronics, and cashback affiliate links.',
    ],
];

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    jsonResponse([
        'success' => true,
        'networks' => array_values($supportedNetworks),
    ]);
}

if ($method !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

// 1. Enforce Server-Side Authentication (Never trust client-supplied creator ID)
$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please sign in to generate your creator affiliate link.'
    ], 401);
}

$creatorUserId = strtoupper(trim((string)($authUser['user_id'] ?? ($authUser['id'] ?? ''))));
if (empty($creatorUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Unable to resolve authenticated creator user ID.'
    ], 403);
}

// 2. Validate Input Payload
$input = getRequestPayload();
$network = strtolower(trim((string)($input['network'] ?? ($input['n'] ?? ''))));
$targetUrl = trim((string)($input['target_url'] ?? ($input['targetUrl'] ?? ($input['u'] ?? ''))));
$videoId = trim((string)($input['video_id'] ?? ($input['videoId'] ?? ($input['v'] ?? ''))));

if (empty($network)) {
    jsonResponse([
        'success' => false,
        'error' => 'Affiliate network is required. Supported networks: Amazon Associates (amazon), Impact (impact), EarnKaro (earnkaro).'
    ], 400);
}

if (!isset($supportedNetworks[$network])) {
    jsonResponse([
        'success' => false,
        'error' => "Unsupported affiliate network '{$network}'. Supported networks: Amazon Associates (amazon), Impact (impact), EarnKaro (earnkaro)."
    ], 400);
}

if (empty($targetUrl)) {
    jsonResponse([
        'success' => false,
        'error' => 'Product destination URL is required.'
    ], 400);
}

// 3. Resolve Allowed Domains for Network
$allowedDomains = $supportedNetworks[$network]['allowed_domains'];
try {
    $stmt = $pdo->prepare('SELECT allowed_domains FROM affiliate_networks_config WHERE id = ? LIMIT 1');
    $stmt->execute([$network]);
    $conf = $stmt->fetch();
    if ($conf && !empty($conf['allowed_domains'])) {
        $allowedDomains = array_map('trim', explode(',', $conf['allowed_domains']));
    }
} catch (Exception $e) {
    // Fall back to predefined whitelist
}

// 4. Validate Target URL Against Whitelist & SSRF Rules
$validation = validateSafeAffiliateUrl($targetUrl, $allowedDomains);
if (!$validation['valid']) {
    jsonResponse([
        'success' => false,
        'error' => $validation['error'],
        'allowed_domains' => $allowedDomains,
    ], 400);
}

// 5. Construct Canonical Tracking URL
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = $_SERVER['HTTP_HOST'] ?? 'facetube.online';
$baseTrackingPath = '/api/affiliate/click.php';

$queryParams = [
    'network' => $network,
    'creator_user_id' => $creatorUserId,
    'target_url' => $validation['url'],
    'redirect' => '1',
];

if (!empty($videoId)) {
    $queryParams['video_id'] = $videoId;
}

$queryString = http_build_query($queryParams);
$relativeTrackingPath = $baseTrackingPath . '?' . $queryString;
$absoluteTrackingUrl = $scheme . '://' . $host . $relativeTrackingPath;

jsonResponse([
    'success' => true,
    'network' => $network,
    'network_name' => $supportedNetworks[$network]['name'],
    'creator_user_id' => $creatorUserId,
    'target_url' => $validation['url'],
    'tracking_url' => $absoluteTrackingUrl,
    'relative_tracking_path' => $relativeTrackingPath,
    'allowed_domains' => $allowedDomains,
    'video_id' => !empty($videoId) ? $videoId : null,
], 201);
