<?php
/**
 * FaceTube - Get Authenticated Creator Subscriber Count API
 * GET /api/channel/subscribers.php
 *
 * Returns the real database-backed subscriber count for the authenticated creator.
 * Enforces creator isolation: regular creators only view their own subscriber counts.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required to access creator subscriber count.'
    ], 401);
}

// User isolation: authenticated creator inspects their own channel subscribers.
// Administrators can optionally inspect a specific creator by passing creator_user_id.
$creatorUserId = trim($authUser['user_id'] ?? '');
$requestedCreatorId = trim($_GET['creator_user_id'] ?? ($_GET['creatorId'] ?? ($_GET['creator_id'] ?? '')));

if (!empty($requestedCreatorId)) {
    if (($authUser['role'] ?? '') === 'admin' || strcasecmp($requestedCreatorId, $creatorUserId) === 0) {
        $creatorUserId = $requestedCreatorId;
    } else {
        jsonResponse([
            'success' => false,
            'error' => 'Forbidden: You can only view your own creator subscriber count.'
        ], 403);
    }
}

try {
    // Resolve canonical creator user_id
    $stmtCreator = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1');
    $stmtCreator->execute([$creatorUserId, $creatorUserId]);
    $creatorRow = $stmtCreator->fetch();
    if ($creatorRow && !empty($creatorRow['user_id'])) {
        $creatorUserId = $creatorRow['user_id'];
    }

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
        'creator_user_id' => $creatorUserId,
        'subscriber_count' => $subscriberCount
    ]);
} catch (PDOException $e) {
    jsonResponse([
        'success' => false,
        'error' => 'Database error: ' . $e->getMessage()
    ], 500);
}
