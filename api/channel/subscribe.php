<?php
/**
 * FaceTube - Subscribe to Creator Channel API
 * POST /api/channel/subscribe.php
 *
 * Secure, authenticated subscription to a content creator channel.
 * Derives subscriber identity strictly from verified server-side session.
 * Prevents self-subscription and duplicate subscriptions.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required to subscribe to a channel.'
    ], 401);
}

$subscriberUserId = trim($authUser['user_id'] ?? '');
if (empty($subscriberUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Invalid subscriber user identity.'
    ], 400);
}

$input = getRequestPayload();
$creatorUserId = trim($input['creator_user_id'] ?? ($input['creatorId'] ?? ($input['creator_id'] ?? '')));

if (empty($creatorUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Creator user ID is required.'
    ], 400);
}

try {
    // Resolve canonical creator user_id if UUID or casing variation was provided
    $stmtCreator = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1');
    $stmtCreator->execute([$creatorUserId, $creatorUserId]);
    $creatorRow = $stmtCreator->fetch();
    if ($creatorRow && !empty($creatorRow['user_id'])) {
        $creatorUserId = $creatorRow['user_id'];
    }

    // Prevent self-subscription
    if (strcasecmp($subscriberUserId, $creatorUserId) === 0) {
        jsonResponse([
            'success' => false,
            'error' => 'You cannot subscribe to your own channel.'
        ], 400);
    }

    // Insert idempotently (prevent duplicate entries)
    $stmtInsert = $pdo->prepare('
        INSERT INTO channel_subscriptions (creator_user_id, subscriber_user_id, created_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE created_at = created_at
    ');
    $stmtInsert->execute([$creatorUserId, $subscriberUserId]);

    // Query real updated subscriber count
    $stmtCount = $pdo->prepare('
        SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
        FROM channel_subscriptions
        WHERE UPPER(creator_user_id) = UPPER(?)
    ');
    $stmtCount->execute([$creatorUserId]);
    $countRow = $stmtCount->fetch();
    $subscriberCount = intval($countRow['subscriber_count'] ?? 0);

    jsonResponse([
        'success' => true,
        'subscribed' => true,
        'creator_user_id' => $creatorUserId,
        'subscriber_count' => $subscriberCount
    ]);
} catch (PDOException $e) {
    jsonResponse([
        'success' => false,
        'error' => 'Database error: ' . $e->getMessage()
    ], 500);
}
