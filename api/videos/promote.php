<?php
/**
 * FaceTube - Promote Video API
 * POST /api/videos/promote.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    $msg = $e->getMessage();
    return str_starts_with($sqlState, '08')
        || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 1927, 2002, 2003, 2005, 2006, 2013, 2026], true)
        || preg_match('/server has gone away|lost connection|connection refused|connection timed out|too many connections|max_user_connections|too many user connections|server shutdown in progress|host .* is blocked|broken pipe|could not translate host|unknown mysql server host|getaddrinfo/i', $msg) === 1;
};

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[videos/promote.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error during video promotion.'], 500);
}

if (!$authUser) {
    jsonResponse(['success' => false, 'error' => 'Authentication required. Please provide a valid Bearer session token.'], 401);
}

$input = getRequestPayload();
$videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? '')));
$paymentId = trim((string)($input['paymentId'] ?? ($input['payment_id'] ?? '')));
$clientPlanId = trim((string)($input['planId'] ?? ($input['plan_id'] ?? '')));

if ($videoId === '') {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}
if ($paymentId === '') {
    jsonResponse(['success' => false, 'error' => 'Verified ads_promotion paymentId is required.'], 400);
}

$adPlans = [
    'plan-7-days' => ['days' => 7, 'price' => 100.00],
    'plan-15-days' => ['days' => 15, 'price' => 200.00],
    'plan-monthly' => ['days' => 30, 'price' => 300.00],
    'plan-yearly' => ['days' => 365, 'price' => 3000.00],
];

// Detect Phase 2B idempotency columns via INFORMATION_SCHEMA
$hasPromoPaymentIdCol = false;
$hasPromoAppliedAtCol = false;
try {
    $colStmt = $pdo->query("
        SELECT TABLE_NAME, COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'uploaded_videos' AND COLUMN_NAME = 'promotion_payment_id')
            OR (TABLE_NAME = 'payment_orders' AND COLUMN_NAME = 'promotion_applied_at')
          )
    ");
    if ($colStmt) {
        foreach ($colStmt->fetchAll(PDO::FETCH_ASSOC) as $colRow) {
            $tbl = strtolower((string)($colRow['TABLE_NAME'] ?? ''));
            $col = strtolower((string)($colRow['COLUMN_NAME'] ?? ''));
            if ($tbl === 'uploaded_videos' && $col === 'promotion_payment_id') {
                $hasPromoPaymentIdCol = true;
            } elseif ($tbl === 'payment_orders' && $col === 'promotion_applied_at') {
                $hasPromoAppliedAtCol = true;
            }
        }
    }
} catch (Throwable $_eCols) {
    // Keep safe defaults
}

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[videos/promote.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$isAuthAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = (string)$authUser['user_id'];

try {
    $pdo->beginTransaction();

    // 1. Lock and verify target video exists & caller is owner or admin
    $stmtVideo = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1 FOR UPDATE');
    $stmtVideo->execute([$videoId]);
    $videoRow = $stmtVideo->fetch();

    if (!$videoRow) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
    }

    $videoOwner = (string)($videoRow['user_id'] ?? '');
    if (strcasecmp($videoOwner, $authUserId) !== 0 && !$isAuthAdmin) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Unauthorized: You can only promote your own videos.'], 403);
    }

    // 2. Prevent payment ID reuse across different videos
    if ($hasPromoPaymentIdCol) {
        $stmtReuse = $pdo->prepare('SELECT id FROM uploaded_videos WHERE promotion_payment_id = ? AND id != ? LIMIT 1 FOR UPDATE');
        $stmtReuse->execute([$paymentId, $videoId]);
        if ($stmtReuse->fetch()) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Conflict: Payment ID has already been used to promote another video.'
            ], 409);
        }
    }

    // 3. Verify payment_orders record for ads_promotion
    $stmtOrder = $pdo->prepare('SELECT * FROM payment_orders WHERE payment_id = ? LIMIT 1 FOR UPDATE');
    $stmtOrder->execute([$paymentId]);
    $orderRow = $stmtOrder->fetch();

    if (!$orderRow) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Verified ads_promotion payment order not found.'], 400);
    }

    if (strtolower((string)($orderRow['status'] ?? '')) !== 'paid') {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment order is not verified as paid.'], 400);
    }

    if (strtolower((string)($orderRow['purpose'] ?? '')) !== 'ads_promotion') {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment purpose mismatch: expected ads_promotion.'], 400);
    }

    if (strtoupper((string)($orderRow['currency'] ?? 'INR')) !== 'INR') {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment currency mismatch: expected INR.'], 400);
    }

    $orderOwner = (string)($orderRow['user_id'] ?? '');
    $orderOwnerMatchesVideoOwner = strcasecmp($orderOwner, $videoOwner) === 0;
    $orderOwnerMatchesAuth = strcasecmp($orderOwner, $authUserId) === 0;
    if ((!$isAuthAdmin && !$orderOwnerMatchesAuth) || (!$orderOwnerMatchesVideoOwner && !($isAuthAdmin && $orderOwnerMatchesAuth))) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Unauthorized: Payment order belongs to another user.'], 403);
    }

    $orderVideoId = trim((string)($orderRow['video_id'] ?? ''));
    if ($orderVideoId === '' || $orderVideoId !== $videoId) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Conflict: Payment order is not bound to this video ID.'], 409);
    }

    $authoritativePlanId = trim((string)($orderRow['plan_id'] ?? ''));
    if (!isset($adPlans[$authoritativePlanId])) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Invalid ads promotion plan in verified payment order.'], 400);
    }

    $authoritativePlan = $adPlans[$authoritativePlanId];
    if (abs(floatval($orderRow['amount'] ?? 0) - $authoritativePlan['price']) > 0.01) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment order amount does not match authoritative promotion plan pricing.'], 400);
    }

    if ($clientPlanId !== '' && $clientPlanId !== $authoritativePlanId) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Requested planId does not match the verified payment order.'], 400);
    }

    // 4. Verify payment_transactions record
    $stmtTx = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? LIMIT 1 FOR UPDATE');
    $stmtTx->execute([$paymentId]);
    $txRow = $stmtTx->fetch();

    if (!$txRow) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Verified payment transaction record not found.'], 400);
    }

    if (strtolower((string)($txRow['purpose'] ?? '')) !== 'ads_promotion') {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment transaction purpose mismatch: expected ads_promotion.'], 400);
    }

    if (abs(floatval($txRow['amount'] ?? 0) - $authoritativePlan['price']) > 0.01) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Payment transaction amount does not match promotion plan pricing.'], 400);
    }

    $txOwner = (string)($txRow['user_id'] ?? '');
    if (strcasecmp($txOwner, $orderOwner) !== 0) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Unauthorized: Payment transaction payer mismatch.'], 403);
    }

    $txVideoId = trim((string)($txRow['video_id'] ?? ''));
    if ($txVideoId !== '' && $txVideoId !== $videoId) {
        $safeRollback($pdo);
        jsonResponse(['success' => false, 'error' => 'Conflict: Payment transaction is bound to a different video ID.'], 409);
    }

    // 5. Idempotency check using Phase 2B promotion_applied_at / promotion_payment_id foundation
    $alreadyAppliedOrder = $hasPromoAppliedAtCol && !empty($orderRow['promotion_applied_at']);
    $alreadyAppliedVideo = $hasPromoPaymentIdCol && ((string)($videoRow['promotion_payment_id'] ?? '') === $paymentId);

    if ($alreadyAppliedOrder || $alreadyAppliedVideo) {
        $pdo->commit();
        jsonResponse([
            'success' => true,
            'idempotent' => true,
            'message' => 'Video promotion already applied for this verified payment.',
            'promotionPlan' => $videoRow['promotion_plan'] ?? $authoritativePlanId,
            'promotionExpiresAt' => $videoRow['promotion_expires_at'] ?? null,
        ]);
    }

    // 6. Apply additive renewal using strictly server-derived duration (never client durationDays)
    $durationDays = $authoritativePlan['days'];
    $promoPaymentSetSql = $hasPromoPaymentIdCol ? ', promotion_payment_id = :paymentId' : '';
    $stmtPromo = $pdo->prepare("
        UPDATE uploaded_videos 
        SET is_promoted = 1,
            promotion_plan = :planId,
            promotion_expires_at = IF(
                promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW(),
                DATE_ADD(promotion_expires_at, INTERVAL :durationDays DAY),
                DATE_ADD(NOW(), INTERVAL :durationDays DAY)
            ){$promoPaymentSetSql},
            updated_at = NOW()
        WHERE id = :videoId
    ");
    $promoParams = [
        ':planId' => $authoritativePlanId,
        ':durationDays' => $durationDays,
        ':videoId' => $videoId,
    ];
    if ($hasPromoPaymentIdCol) {
        $promoParams[':paymentId'] = $paymentId;
    }
    $stmtPromo->execute($promoParams);

    if ($hasPromoAppliedAtCol) {
        $pdo->prepare('UPDATE payment_orders SET promotion_applied_at = NOW(), updated_at = NOW() WHERE order_id = ?')
            ->execute([$orderRow['order_id']]);
    }

    $stmtRefetch = $pdo->prepare('SELECT promotion_plan, promotion_expires_at FROM uploaded_videos WHERE id = ? LIMIT 1');
    $stmtRefetch->execute([$videoId]);
    $updatedVideo = $stmtRefetch->fetch();

    $pdo->commit();

    jsonResponse([
        'success' => true,
        'idempotent' => false,
        'message' => 'Video promoted successfully.',
        'promotionPlan' => $updatedVideo['promotion_plan'] ?? $authoritativePlanId,
        'promotionExpiresAt' => $updatedVideo['promotion_expires_at'] ?? null,
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[videos/promote.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during video promotion. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while promoting video. Please try again.'], 500);
}
