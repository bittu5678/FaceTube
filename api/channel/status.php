<?php
/**
 * FaceTube - Check Channel Subscription Status API
 * GET /api/channel/status.php
 *
 * Checks if the current authenticated visitor is subscribed to a creator channel.
 * Also returns the creator's real subscriber count.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$creatorUserId = trim($_GET['creator_user_id'] ?? ($_GET['creatorId'] ?? ($_GET['creator_id'] ?? '')));

if (empty($creatorUserId)) {
    jsonResponse([
        'success' => false,
        'error' => 'Creator user ID is required.'
    ], 400);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

try {
    // Resolve canonical creator user_id
    $stmtCreator = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1');
    $stmtCreator->execute([$creatorUserId, $creatorUserId]);
    $creatorRow = $stmtCreator->fetch();
    if ($creatorRow && !empty($creatorRow['user_id'])) {
        $creatorUserId = $creatorRow['user_id'];
    }

    // Get creator's total subscribers
    $stmtCount = $pdo->prepare('
        SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
        FROM channel_subscriptions
        WHERE UPPER(creator_user_id) = UPPER(?)
    ');
    $stmtCount->execute([$creatorUserId]);
    $countRow = $stmtCount->fetch();
    $subscriberCount = intval($countRow['subscriber_count'] ?? 0);

    if (!$authUser) {
        jsonResponse([
            'success' => true,
            'authenticated' => false,
            'subscribed' => false,
            'creator_user_id' => $creatorUserId,
            'subscriber_count' => $subscriberCount,
            'is_self' => false
        ]);
    }

    $subscriberUserId = trim($authUser['user_id'] ?? '');
    $isSelf = (strcasecmp($subscriberUserId, $creatorUserId) === 0);

    $stmtCheck = $pdo->prepare('
        SELECT id FROM channel_subscriptions
        WHERE UPPER(creator_user_id) = UPPER(?) AND UPPER(subscriber_user_id) = UPPER(?)
        LIMIT 1
    ');
    $stmtCheck->execute([$creatorUserId, $subscriberUserId]);
    $isSubscribed = (bool)$stmtCheck->fetch();

    jsonResponse([
        'success' => true,
        'authenticated' => true,
        'subscribed' => $isSubscribed,
        'creator_user_id' => $creatorUserId,
        'subscriber_count' => $subscriberCount,
        'is_self' => $isSelf
    ]);
} catch (PDOException $e) {
    jsonResponse([
        'success' => false,
        'error' => 'Database error: ' . $e->getMessage()
    ], 500);
}
