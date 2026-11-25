<?php
/**
 * FaceTube - Orphaned Captured Sponsor Payment Recovery API
 * POST /api/payments/recover-captured.php
 *
 * Safely reconciles an already-captured ₹6 Sponsor Video payment (e.g. when payment was
 * captured on Razorpay before the video record or ledger settlement completed) WITHOUT
 * creating a new Razorpay order, initiating checkout, capturing again, or refunding.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/premium-settlement.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['recovered' => false, 'verified' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$input = getRequestPayload();

$orderId = trim((string)($input['orderId'] ?? ($input['order_id'] ?? '')));
$paymentId = trim((string)($input['paymentId'] ?? ($input['payment_id'] ?? '')));
$videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? '')));

if ($orderId === '' || $paymentId === '' || $videoId === '') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'error' => 'Invalid recovery request: orderId, paymentId, and videoId are required.',
    ], 400);
}

if (array_key_exists('purpose', $input) && trim((string)$input['purpose']) !== '') {
    if (strtolower(trim((string)$input['purpose'])) !== 'premium_video_upload') {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Recovery only supports Sponsor Video uploads (purpose: premium_video_upload).',
        ], 400);
    }
}

if (array_key_exists('currency', $input) && trim((string)$input['currency']) !== '') {
    if (strtoupper(trim((string)$input['currency'])) !== 'INR') {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Invalid currency: Sponsor video recovery requires INR.',
        ], 400);
    }
}

if (array_key_exists('amount', $input) && $input['amount'] !== '' && $input['amount'] !== null) {
    if (!is_numeric($input['amount']) || abs(floatval($input['amount']) - 6.00) > 0.01) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Invalid amount: Sponsor video recovery requires exact ₹6.00 INR (600 paise).',
        ], 400);
    }
}

// 1. Server-side Razorpay credential check (Fail-Closed, never exposed to client)
$rzpConfig = getRazorpayConfig();
$keyId = $rzpConfig['keyId'];
$secret = $rzpConfig['keySecret'];

if (empty($keyId) || empty($secret)) {
    error_log('[recover-captured.php] Razorpay server credentials missing.');
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Payment gateway verification is unavailable on server. RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured.',
    ], 500);
}

// 2. Strict session authentication check
try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[recover-captured.php] Auth DB error: ' . $authErr->getMessage());
    if (ftIsConnectionUnavailablePhp($authErr)) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Database connection unavailable during authentication. Please try again.',
        ], 503);
    }
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Authentication service error during payment recovery.',
    ], 500);
}

if (!$authUser) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Authentication required. Please log in to recover this payment.',
    ], 401);
}

$authUserId = (string)$authUser['user_id'];
$requestedUserId = trim((string)($input['userId'] ?? ($input['user_id'] ?? '')));
if ($requestedUserId !== '' && strcasecmp($requestedUserId, $authUserId) !== 0) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Unauthorized: Recovery request user does not match authenticated user.',
    ], 403);
}

// 3. Validate original payment order, ownership, amount, currency, purpose, and video mapping
try {
    $stmtPreOrder = $pdo->prepare('SELECT * FROM payment_orders WHERE order_id = ? LIMIT 1');
    $stmtPreOrder->execute([$orderId]);
    $preOrder = $stmtPreOrder->fetch(PDO::FETCH_ASSOC);
} catch (Throwable $preOrderErr) {
    error_log('[recover-captured.php] Order lookup error: ' . $preOrderErr->getMessage());
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => ftIsConnectionUnavailablePhp($preOrderErr)
            ? 'Database connection unavailable during order lookup.'
            : 'Database error looking up original payment order.',
    ], ftIsConnectionUnavailablePhp($preOrderErr) ? 503 : 500);
}

if (!$preOrder) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Original payment order not found.',
    ], 404);
}

$orderUserId = (string)($preOrder['user_id'] ?? '');
if (strcasecmp($orderUserId, $authUserId) !== 0) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Unauthorized: Authenticated user does not own the original payment order.',
    ], 403);
}

if (strtolower((string)($preOrder['purpose'] ?? '')) !== 'premium_video_upload') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid order purpose: recovery requires a premium_video_upload order.',
    ], 400);
}

if (strtoupper((string)($preOrder['currency'] ?? 'INR')) !== 'INR') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid order currency: expected INR.',
    ], 400);
}

if (abs(floatval($preOrder['amount'] ?? 0) - 6.00) > 0.01) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid order amount: Sponsor video recovery requires ₹6.00 INR (600 paise).',
    ], 400);
}

$orderVideoId = trim((string)($preOrder['video_id'] ?? ''));
if ($orderVideoId === '') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Original payment order is not linked to any video ID.',
    ], 400);
}

if ($orderVideoId !== $videoId) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => "Conflict: Original order is linked to video '{$orderVideoId}', not '{$videoId}'.",
    ], 409);
}

if (($preOrder['status'] ?? '') === 'paid' && !empty($preOrder['payment_id']) && (string)$preOrder['payment_id'] !== $paymentId) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Conflict: Payment order was already settled with a different payment ID.',
    ], 409);
}

// 4. Anti-reuse & existing video metadata inspection
$preExistingVideo = null;
try {
    $stmtReuseOrder = $pdo->prepare('SELECT order_id FROM payment_orders WHERE payment_id = ? AND order_id != ? LIMIT 1');
    $stmtReuseOrder->execute([$paymentId, $orderId]);
    if ($stmtReuseOrder->fetch()) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Payment ID is already linked to another payment order.',
        ], 409);
    }

    $stmtReuseVid = $pdo->prepare('SELECT id FROM uploaded_videos WHERE payment_id = ? AND id != ? LIMIT 1');
    $stmtReuseVid->execute([$paymentId, $videoId]);
    if ($stmtReuseVid->fetch()) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Payment ID is already linked to another video.',
        ], 409);
    }

    $stmtPreTx = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? LIMIT 1');
    $stmtPreTx->execute([$paymentId]);
    $preTx = $stmtPreTx->fetch(PDO::FETCH_ASSOC);
    if ($preTx) {
        $txOrderMismatch = !empty($preTx['order_id']) && (string)$preTx['order_id'] !== $orderId;
        $txUserMismatch = strcasecmp((string)$preTx['user_id'], $orderUserId) !== 0;
        $txVideo = trim((string)($preTx['video_id'] ?? ''));
        $txVideoMismatch = $txVideo !== '' && $txVideo !== $videoId;
        if ($txOrderMismatch || $txUserMismatch || $txVideoMismatch || (string)$preTx['purpose'] !== 'premium_video_upload') {
            jsonResponse([
                'recovered' => false,
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'videoId' => $videoId,
                'error' => 'Conflict: Payment ID has already been recorded for a different order, video, or user.',
            ], 409);
        }
    }

    $stmtPreVid = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1');
    $stmtPreVid->execute([$videoId]);
    $preExistingVideo = $stmtPreVid->fetch(PDO::FETCH_ASSOC) ?: null;
} catch (Throwable $preCheckErr) {
    error_log('[recover-captured.php] Pre-check error: ' . $preCheckErr->getMessage());
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => ftIsConnectionUnavailablePhp($preCheckErr)
            ? 'Database connection unavailable verifying payment/video records.'
            : 'Database error verifying payment/video records.',
    ], ftIsConnectionUnavailablePhp($preCheckErr) ? 503 : 500);
}

if ($preExistingVideo) {
    if (strcasecmp((string)$preExistingVideo['user_id'], $orderUserId) !== 0) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Unauthorized: Existing video record belongs to a different user.',
        ], 403);
    }
    if (strtolower((string)($preExistingVideo['video_type'] ?? '')) === 'free') {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Free video uploads cannot be recovered as ₹6 Sponsor videos.',
        ], 400);
    }
    if (!empty($preExistingVideo['payment_id']) && (string)$preExistingVideo['payment_id'] !== $paymentId) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Existing video is already linked to a different payment ID.',
        ], 409);
    }
}

// 5. Resolve video metadata & validate uploaded video asset BEFORE gateway lookup or DB writes
$title = trim((string)($input['title'] ?? ($preExistingVideo['title'] ?? '')));
if ($title === '') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'missingAsset' => 'title',
        'error' => 'Video title is required to publish the recovered Sponsor video.',
    ], 422);
}

$description = array_key_exists('description', $input)
    ? trim((string)$input['description'])
    : trim((string)($preExistingVideo['description'] ?? ''));

$rawVideoUrl = trim((string)($input['videoUrl'] ?? ($input['video_url'] ?? ($preExistingVideo['video_url'] ?? ''))));
$assetValidation = ftValidateUploadedVideoAssetPhp($rawVideoUrl);
if (empty($assetValidation['valid'])) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'missingAsset' => $assetValidation['missingAsset'] ?? 'video_url',
        'error' => $assetValidation['error'] ?? 'Original uploaded video asset is missing or invalid.',
    ], (int)($assetValidation['status'] ?? 422));
}
$resolvedVideoUrl = (string)$assetValidation['publicUrl'];

$rawContentType = trim((string)($input['contentType'] ?? ($input['content_type'] ?? ($preOrder['content_type'] ?? ($preExistingVideo['content_type'] ?? 'long')))));
$contentType = strtolower($rawContentType ?: 'long');
if (!in_array($contentType, ['short', 'long'], true)) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid contentType. Allowed values: short, long.',
    ], 400);
}

$category = trim((string)($input['category'] ?? ($preExistingVideo['category'] ?? 'General')));
if ($category === '') {
    $category = 'General';
}

$rawVisibility = $input['visibility'] ?? ($preExistingVideo['visibility'] ?? 'public');
$visibility = strtolower(trim((string)$rawVisibility));
if ($visibility === '') {
    $visibility = 'public';
}
if (!in_array($visibility, ['public', 'unlisted', 'private'], true)) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid visibility value. Allowed values: public, unlisted, private.',
    ], 400);
}

$duration = trim((string)($input['duration'] ?? ($preExistingVideo['duration'] ?? '')));
if ($duration === '') {
    $duration = ($contentType === 'short') ? '0:45' : '1:00';
}

$rawThumbnailUrl = trim((string)($input['thumbnailUrl'] ?? ($input['thumbnail_url'] ?? ($preExistingVideo['thumbnail_url'] ?? ''))));
$creatorName = trim((string)(
    $input['creatorName']
    ?? ($input['creator_name']
    ?? ($preExistingVideo['creator_name']
    ?? ($authUser['channel_name']
    ?? ($authUser['name'] ?? ($preOrder['user_name'] ?? 'FaceTube Creator')))))
));
if ($creatorName === '') {
    $creatorName = 'FaceTube Creator';
}

// 6. Verify Global Pool reserve schema readiness BEFORE fetching Razorpay or modifying DB
$reserveSchema = ftCheckGlobalPoolReserveSchemaReadyPhp($pdo);
if (empty($reserveSchema['ready'])) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => $reserveSchema['error'] ?? 'Global Pool reserve schema is not ready.',
    ], (int)($reserveSchema['status'] ?? 503));
}

// 7. Fetch original payment directly from Razorpay API (GET ONLY — NEVER capture/order/refund)
$ch = curl_init('https://api.razorpay.com/v1/payments/' . rawurlencode($paymentId));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_USERPWD => "{$keyId}:{$secret}",
    CURLOPT_TIMEOUT => 15,
]);
$pResp = curl_exec($ch);
$pCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$pErr = curl_error($ch);
curl_close($ch);

if ($pResp === false || $pCode < 200 || $pCode >= 300) {
    error_log('[recover-captured.php] Razorpay GET /payments failed (' . $pCode . '): ' . ($pErr ?: $pResp));
    $errStatus = ($pResp === false || $pCode >= 500 || $pCode === 0) ? 502 : 400;
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Razorpay payment lookup failed with gateway.',
    ], $errStatus);
}

$pData = json_decode($pResp, true);
if (empty($pData) || !is_array($pData)) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Invalid response structure from Razorpay gateway.',
    ], 400);
}

if (empty($pData['id']) || (string)$pData['id'] !== $paymentId) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Razorpay payment ID mismatch.',
    ], 400);
}

if (empty($pData['order_id']) || (string)$pData['order_id'] !== $orderId) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Razorpay payment does not belong to the exact original order ID.',
    ], 400);
}

$gatewayStatus = strtolower(trim((string)($pData['status'] ?? '')));
if ($gatewayStatus !== 'captured') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => "Only already-captured payments can be recovered (gateway status: " . ($pData['status'] ?? 'unknown') . '). Capture was intentionally not called.',
    ], 400);
}

$gatewayAmountPaise = (int)($pData['amount'] ?? 0);
if ($gatewayAmountPaise !== 600) {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Razorpay payment amount mismatch: expected 600 paise (₹6.00 INR).',
    ], 400);
}

if (strtoupper(trim((string)($pData['currency'] ?? ''))) !== 'INR') {
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Razorpay payment currency mismatch: expected INR.',
    ], 400);
}

if (!empty($pData['notes']) && is_array($pData['notes'])) {
    $noteVideoId = trim((string)($pData['notes']['videoId'] ?? ''));
    if ($noteVideoId !== '' && $noteVideoId !== $videoId) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Razorpay payment notes point to a different video ID.',
        ], 409);
    }
    $noteUserId = trim((string)($pData['notes']['userId'] ?? ''));
    if ($noteUserId !== '' && strcasecmp($noteUserId, $orderUserId) !== 0) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Unauthorized: Razorpay payment notes belong to a different user.',
        ], 403);
    }
    $notePurpose = trim((string)($pData['notes']['purpose'] ?? ''));
    if ($notePurpose !== '' && strtolower($notePurpose) !== 'premium_video_upload') {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Invalid Razorpay payment purpose in gateway notes.',
        ], 400);
    }
}

// 8. Inspect schema metadata and run transactional ACID recovery
$schema = ftInspectPremiumSchemaColumnsPhp($pdo, true);
$detectedCountryCode = ftResolveTrustedRequestCountryCode();
$userName = trim((string)($preOrder['user_name'] ?? ($authUser['name'] ?? $creatorName)));
if ($userName === '') {
    $userName = 'Creator';
}

try {
    $pdo->beginTransaction();

    $stmtOrder = $pdo->prepare('SELECT * FROM payment_orders WHERE order_id = ? FOR UPDATE');
    $stmtOrder->execute([$orderId]);
    $lockedOrder = $stmtOrder->fetch(PDO::FETCH_ASSOC);

    if (!$lockedOrder) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Original payment order not found.',
        ], 404);
    }

    if (strcasecmp((string)$lockedOrder['user_id'], $authUserId) !== 0) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Unauthorized: Authenticated user does not own the original payment order.',
        ], 403);
    }

    if (
        strtolower((string)($lockedOrder['purpose'] ?? '')) !== 'premium_video_upload'
        || strtoupper((string)($lockedOrder['currency'] ?? 'INR')) !== 'INR'
        || abs(floatval($lockedOrder['amount'] ?? 0) - 6.00) > 0.01
    ) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Original payment order metadata mismatch (expected ₹6 INR premium_video_upload).',
        ], 400);
    }

    $lockedOrderVideoId = trim((string)($lockedOrder['video_id'] ?? ''));
    if ($lockedOrderVideoId === '' || $lockedOrderVideoId !== $videoId) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Original payment order video mapping mismatch.',
        ], 409);
    }

    if (($lockedOrder['status'] ?? '') === 'paid' && !empty($lockedOrder['payment_id']) && (string)$lockedOrder['payment_id'] !== $paymentId) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Payment order was already settled with a different payment ID.',
        ], 409);
    }

    $stmtReuseLocked = $pdo->prepare('SELECT id FROM uploaded_videos WHERE payment_id = ? AND id != ? LIMIT 1 FOR UPDATE');
    $stmtReuseLocked->execute([$paymentId, $videoId]);
    if ($stmtReuseLocked->fetch()) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Payment ID is already linked to another video.',
        ], 409);
    }

    $stmtVidLock = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? FOR UPDATE');
    $stmtVidLock->execute([$videoId]);
    $lockedVideo = $stmtVidLock->fetch(PDO::FETCH_ASSOC) ?: null;

    if ($lockedVideo) {
        if (strcasecmp((string)$lockedVideo['user_id'], $orderUserId) !== 0) {
            ftSafeRollbackPhp($pdo);
            jsonResponse([
                'recovered' => false,
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'videoId' => $videoId,
                'error' => 'Unauthorized: Video record belongs to a different user.',
            ], 403);
        }
        if (strtolower((string)($lockedVideo['video_type'] ?? '')) === 'free') {
            ftSafeRollbackPhp($pdo);
            jsonResponse([
                'recovered' => false,
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'videoId' => $videoId,
                'error' => 'Free video uploads cannot be recovered as ₹6 Sponsor videos.',
            ], 400);
        }
        if (!empty($lockedVideo['payment_id']) && (string)$lockedVideo['payment_id'] !== $paymentId) {
            ftSafeRollbackPhp($pdo);
            jsonResponse([
                'recovered' => false,
                'verified' => false,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'videoId' => $videoId,
                'error' => 'Conflict: Video is already linked to a different payment ID.',
            ], 409);
        }
    }

    // Check if payment settlement already exists
    $stmtLockedTx = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? FOR UPDATE');
    $stmtLockedTx->execute([$paymentId]);
    $lockedExistingTx = $stmtLockedTx->fetch(PDO::FETCH_ASSOC) ?: null;

    if ($lockedExistingTx) {
        [$dupStatus, $dupResp] = ftBuildDuplicateVerifyResponsePhp(
            $pdo,
            $lockedExistingTx,
            $orderId,
            $paymentId,
            $orderUserId,
            $videoId,
            'premium_video_upload',
            'Payment already settled previously.'
        );
        if ($dupStatus !== 200) {
            ftSafeRollbackPhp($pdo);
            $dupResp['recovered'] = false;
            $dupResp['videoId'] = $videoId;
            jsonResponse($dupResp, $dupStatus);
        }

        $videoAlreadyPaidAndLinked = $lockedVideo
            && strtolower((string)($lockedVideo['payment_status'] ?? '')) === 'paid'
            && (string)($lockedVideo['payment_id'] ?? '') === $paymentId;
        $orderAlreadyPaid = (($lockedOrder['status'] ?? '') === 'paid')
            && (string)($lockedOrder['payment_id'] ?? '') === $paymentId;

        if ($videoAlreadyPaidAndLinked && $orderAlreadyPaid) {
            ftSafeRollbackPhp($pdo);
            jsonResponse(array_merge($dupResp, [
                'recovered' => true,
                'verified' => true,
                'duplicate' => true,
                'alreadyPublished' => true,
                'videoPublished' => false,
                'videoId' => $videoId,
                'currency' => 'INR',
                'assetPath' => $assetValidation['relativePath'],
                'video' => $lockedVideo,
                'message' => 'Captured payment and Sponsor video are already settled and published (idempotent duplicate).',
            ]), 200);
        }

        // Partial recovery: payment settlement already exists, so NEVER re-credit ledger/wallet/reserves.
        // Safely complete video publication and/or mark payment_orders paid.
        $publishedVideo = $lockedVideo;
        $videoPublishedNow = false;
        if (!$videoAlreadyPaidAndLinked) {
            $finalThumbnailUrl = ftResolveThumbnailUrlForRecoveryPhp($videoId, $category, $rawThumbnailUrl);
            $publishedVideo = ftUpsertRecoveredPremiumVideoMysqlPhp($pdo, $schema, [
                'videoId' => $videoId,
                'userId' => $orderUserId,
                'creatorName' => $creatorName,
                'title' => $title,
                'description' => $description,
                'videoUrl' => $resolvedVideoUrl,
                'thumbnailUrl' => $finalThumbnailUrl,
                'contentType' => $contentType,
                'category' => $category,
                'duration' => $duration,
                'visibility' => $visibility,
                'paymentId' => $paymentId,
                'existingVideo' => $lockedVideo,
                'detectedCountryCode' => $detectedCountryCode,
            ]);
            $videoPublishedNow = true;
        }

        if (!$orderAlreadyPaid) {
            $stmtPoUpdate = $pdo->prepare('UPDATE payment_orders SET status = "paid", payment_id = ?, updated_at = NOW() WHERE order_id = ?');
            $stmtPoUpdate->execute([$paymentId, $orderId]);
        }

        $pdo->commit();

        jsonResponse(array_merge($dupResp, [
            'recovered' => true,
            'verified' => true,
            'duplicate' => true,
            'alreadyPublished' => !$videoPublishedNow,
            'videoPublished' => $videoPublishedNow,
            'videoId' => $videoId,
            'currency' => 'INR',
            'assetPath' => $assetValidation['relativePath'],
            'video' => $publishedVideo,
            'message' => $videoPublishedNow
                ? 'Existing payment settlement verified without duplicate credits; missing Sponsor video record was recovered and published.'
                : 'Existing payment settlement verified and order status reconciled (idempotent duplicate).',
        ]), 200);
    }

    if (($lockedOrder['status'] ?? '') === 'paid') {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Payment order is marked paid without a matching verified payment transaction record.',
        ], 409);
    }

    // Fresh recovery: execute shared atomic ₹6 Phase 1.1 settlement + publish uploaded_videos + mark order paid
    $settlement = ftSettlePremiumVideoMysqlPhp($pdo, $schema, [
        'orderId' => $orderId,
        'paymentId' => $paymentId,
        'userId' => $orderUserId,
        'userName' => $userName,
        'videoId' => $videoId,
    ]);

    if (empty($settlement['settled'])) {
        ftSafeRollbackPhp($pdo);
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => $settlement['error'] ?? 'Failed to settle recovered payment.',
        ], (int)($settlement['status'] ?? 503));
    }

    $finalThumbnailUrl = ftResolveThumbnailUrlForRecoveryPhp($videoId, $category, $rawThumbnailUrl);
    $publishedVideo = ftUpsertRecoveredPremiumVideoMysqlPhp($pdo, $schema, [
        'videoId' => $videoId,
        'userId' => $orderUserId,
        'creatorName' => $creatorName,
        'title' => $title,
        'description' => $description,
        'videoUrl' => $resolvedVideoUrl,
        'thumbnailUrl' => $finalThumbnailUrl,
        'contentType' => $contentType,
        'category' => $category,
        'duration' => $duration,
        'visibility' => $visibility,
        'paymentId' => $paymentId,
        'existingVideo' => $lockedVideo,
        'detectedCountryCode' => $detectedCountryCode,
    ]);

    $stmtUpdatePo = $pdo->prepare('UPDATE payment_orders SET status = "paid", payment_id = ?, updated_at = NOW() WHERE order_id = ?');
    $stmtUpdatePo->execute([$paymentId, $orderId]);

    $pdo->commit();

    jsonResponse([
        'recovered' => true,
        'verified' => true,
        'duplicate' => false,
        'videoPublished' => true,
        'alreadyPublished' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'amount' => 6.0,
        'currency' => 'INR',
        'purpose' => 'premium_video_upload',
        'txNumber' => $settlement['txNumber'],
        'isSpecialTransaction' => $settlement['isSpecialTransaction'],
        'specialTag' => $settlement['specialTag'],
        'distribution' => $settlement['distribution'],
        'assetPath' => $assetValidation['relativePath'],
        'video' => $publishedVideo,
        'message' => 'Orphaned captured ₹6 Sponsor payment reconciled and video published safely.',
    ], 200);
} catch (Throwable $txErr) {
    ftSafeRollbackPhp($pdo);
    $sqlState = $txErr instanceof PDOException ? (string)$txErr->getCode() : '';
    $driverCode = ($txErr instanceof PDOException && isset($txErr->errorInfo[1])) ? (int)$txErr->errorInfo[1] : 0;

    if (!ftIsConnectionUnavailablePhp($txErr) && ($sqlState === '23000' || $driverCode === 1062)) {
        try {
            $stmtRace = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? LIMIT 1');
            $stmtRace->execute([$paymentId]);
            $raceTx = $stmtRace->fetch(PDO::FETCH_ASSOC);
            if ($raceTx) {
                [$raceStatus, $raceBody] = ftBuildDuplicateVerifyResponsePhp(
                    $pdo,
                    $raceTx,
                    $orderId,
                    $paymentId,
                    $orderUserId,
                    $videoId,
                    'premium_video_upload',
                    'Concurrent recovery detected and resolved safely without duplicate accounting.'
                );
                if ($raceStatus === 200) {
                    $stmtRaceVid = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1');
                    $stmtRaceVid->execute([$videoId]);
                    $raceVid = $stmtRaceVid->fetch(PDO::FETCH_ASSOC) ?: null;
                    $raceBody['recovered'] = true;
                    $raceBody['videoId'] = $videoId;
                    $raceBody['videoPublished'] = false;
                    $raceBody['alreadyPublished'] = (bool)$raceVid;
                    if ($raceVid) {
                        $raceBody['video'] = $raceVid;
                    }
                } else {
                    $raceBody['recovered'] = false;
                    $raceBody['videoId'] = $videoId;
                }
                jsonResponse($raceBody, $raceStatus);
            }
        } catch (Throwable $_eRace) {
            // Fall through
        }

        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Conflict: Duplicate accounting entry prevented transaction recording. Transaction safely rolled back.',
        ], 409);
    }

    error_log('[recover-captured.php] Transaction error: ' . $txErr->getMessage());
    if (ftIsConnectionUnavailablePhp($txErr)) {
        jsonResponse([
            'recovered' => false,
            'verified' => false,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'error' => 'Database connection unavailable during recovery. Transaction was safely rolled back.',
        ], 503);
    }
    jsonResponse([
        'recovered' => false,
        'verified' => false,
        'paymentId' => $paymentId,
        'orderId' => $orderId,
        'videoId' => $videoId,
        'error' => 'Internal server error during payment recovery.',
    ], 500);
}
