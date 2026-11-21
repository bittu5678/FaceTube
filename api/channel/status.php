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

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method !== 'GET') {
    jsonResponse([
        'success' => false,
        'error' => 'Method Not Allowed'
    ], 405);
}

$readStringField = static function ($val, string $default = ''): string {
    if (is_string($val) || is_int($val) || is_float($val)) {
        return trim((string)$val);
    }
    return $default;
};

$creatorUserId = $readStringField($_GET['creator_user_id'] ?? ($_GET['creatorId'] ?? ($_GET['creator_id'] ?? '')));

if ($creatorUserId === '') {
    jsonResponse([
        'success' => false,
        'error' => 'Creator user ID is required.'
    ], 400);
}

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

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[channel/status.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

$pdo = getDatabaseConnection();
$suppliedBearerToken = getBearerToken();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[channel/status.php][AUTH] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable during authentication check.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Database error during authentication check.'
    ], 500);
}

// Never silently downgrade an invalid or expired supplied Bearer token to anonymous access
if ($suppliedBearerToken !== null && trim($suppliedBearerToken) !== '' && (!$authUser || empty($authUser['user_id']))) {
    jsonResponse([
        'success' => false,
        'error' => 'Invalid or expired authentication session. Please log in again.'
    ], 401);
}

try {
    // Resolve canonical creator user_id
    $stmtCreator = $pdo->prepare('SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1');
    if ($stmtCreator === false) {
        throw new RuntimeException('Failed to prepare creator lookup query.');
    }
    if ($stmtCreator->execute([$creatorUserId, $creatorUserId]) === false) {
        throw new RuntimeException('Failed to execute creator lookup query.');
    }
    $creatorRow = $stmtCreator->fetch(PDO::FETCH_ASSOC);
    if ($creatorRow && !empty($creatorRow['user_id'])) {
        $creatorUserId = trim((string)$creatorRow['user_id']);
    }

    // Get creator's total subscribers
    $stmtCount = $pdo->prepare('
        SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
        FROM channel_subscriptions
        WHERE UPPER(creator_user_id) = UPPER(?)
    ');
    if ($stmtCount === false) {
        throw new RuntimeException('Failed to prepare subscriber count query.');
    }
    if ($stmtCount->execute([$creatorUserId]) === false) {
        throw new RuntimeException('Failed to execute subscriber count query.');
    }
    $countRow = $stmtCount->fetch(PDO::FETCH_ASSOC);
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

    $subscriberUserId = trim((string)($authUser['user_id'] ?? ''));
    if ($subscriberUserId === '') {
        jsonResponse([
            'success' => false,
            'error' => 'Invalid or expired authentication session. Please log in again.'
        ], 401);
    }

    $isSelf = (strcasecmp($subscriberUserId, $creatorUserId) === 0);

    $stmtCheck = $pdo->prepare('
        SELECT id FROM channel_subscriptions
        WHERE UPPER(creator_user_id) = UPPER(?) AND UPPER(subscriber_user_id) = UPPER(?)
        LIMIT 1
    ');
    if ($stmtCheck === false) {
        throw new RuntimeException('Failed to prepare subscription check query.');
    }
    if ($stmtCheck->execute([$creatorUserId, $subscriberUserId]) === false) {
        throw new RuntimeException('Failed to execute subscription check query.');
    }
    $isSubscribed = (bool)$stmtCheck->fetch(PDO::FETCH_ASSOC);

    jsonResponse([
        'success' => true,
        'authenticated' => true,
        'subscribed' => $isSubscribed,
        'creator_user_id' => $creatorUserId,
        'subscriber_count' => $subscriberCount,
        'is_self' => $isSelf
    ]);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[channel/status.php] Database error: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while checking channel status.'
        ], 503);
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to check channel status due to a server error.'
    ], 500);
}
