<?php
/**
 * FaceTube - Create Uploaded Video API
 * POST /api/videos/create.php
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
    error_log('[videos/create.php] Auth Database Exception: ' . $authErr->getMessage());
    if ($isConnectionUnavailable($authErr)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Authentication service error during video creation.'], 500);
}

if (!$authUser) {
    jsonResponse(['success' => false, 'error' => 'Authentication required. Please provide a valid Bearer session token.'], 401);
}

$input = getRequestPayload();
$isAuthAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = (string)$authUser['user_id'];
$requestedUserId = trim((string)($input['user_id'] ?? ($input['userId'] ?? '')));
$userId = $authUserId;

if ($requestedUserId !== '') {
    $matchesAuth = strcasecmp($requestedUserId, $authUserId) === 0
        || (!empty($authUser['id']) && strcasecmp($requestedUserId, (string)$authUser['id']) === 0);
    if (!$matchesAuth) {
        if (!$isAuthAdmin) {
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Cross-user video creation is restricted to verified administrators.'
            ], 403);
        }
        $userId = strtoupper($requestedUserId);
    }
}

$id = trim((string)($input['id'] ?? ('vid_' . round(microtime(true) * 1000) . '_' . substr(md5(random_bytes(6)), 0, 6))));
if ($id === '') {
    $id = 'vid_' . round(microtime(true) * 1000) . '_' . substr(md5(random_bytes(6)), 0, 6);
}

$creatorName = trim((string)($input['creator_name'] ?? ($input['creatorName'] ?? ($authUser['channel_name'] ?? ($authUser['name'] ?? 'FaceTube Creator')))));
if ($creatorName === '') {
    $creatorName = 'FaceTube Creator';
}
$title = trim((string)($input['title'] ?? ''));
$description = trim((string)($input['description'] ?? ''));
$videoUrl = trim((string)($input['video_url'] ?? ($input['videoUrl'] ?? '')));

if (empty($title)) {
    jsonResponse(['success' => false, 'error' => 'Video title is required.'], 400);
}
if (empty($videoUrl)) {
    jsonResponse(['success' => false, 'error' => 'Video URL or file is required.'], 400);
}

$rawVisibility = $input['visibility'] ?? null;
$hasExplicitVisibility = $rawVisibility !== null && trim((string)$rawVisibility) !== '';
$visibility = 'public';
if ($hasExplicitVisibility) {
    $normalizedVisibility = strtolower(trim((string)$rawVisibility));
    if (!in_array($normalizedVisibility, ['public', 'unlisted', 'private'], true)) {
        jsonResponse(['success' => false, 'error' => 'Invalid visibility value. Allowed values: public, unlisted, private.'], 400);
    }
    $visibility = $normalizedVisibility;
}

$rawVideoType = $input['video_type'] ?? ($input['videoType'] ?? 'free');
$videoType = strtolower(trim((string)$rawVideoType));
if ($videoType === '') {
    $videoType = 'free';
}
if (!in_array($videoType, ['free', 'premium'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid video_type. Allowed values: free, premium.'], 400);
}

$rawContentType = $input['content_type'] ?? ($input['contentType'] ?? 'long');
$contentType = strtolower(trim((string)$rawContentType));
if ($contentType === '') {
    $contentType = 'long';
}
if (!in_array($contentType, ['short', 'long'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid content_type. Allowed values: short, long.'], 400);
}

$category = trim((string)($input['category'] ?? 'General'));
if ($category === '') {
    $category = 'General';
}
$duration = trim((string)($input['duration'] ?? '0:00'));
if ($duration === '') {
    $duration = '0:00';
}

// Never trust client-supplied paymentStatus, paymentAmount, or isPromoted
$requestedPaymentId = !empty($input['payment_id'])
    ? trim((string)$input['payment_id'])
    : (!empty($input['paymentId']) ? trim((string)$input['paymentId']) : null);

$paymentStatus = 'not_required';
$paymentId = null;
$paymentAmount = 0.00;

if ($videoType === 'premium') {
    if (empty($requestedPaymentId)) {
        jsonResponse([
            'success' => false,
            'error' => 'Verified ₹6 payment_id is required for Sponsor (premium) video uploads.'
        ], 400);
    }
    $paymentId = $requestedPaymentId;
}

$rawThumbnailUrl = $input['thumbnail_url'] ?? ($input['thumbnailUrl'] ?? '');
$thumbnailUrl = is_string($rawThumbnailUrl) ? trim($rawThumbnailUrl) : '';
if (in_array(strtolower($thumbnailUrl), ['null', 'undefined', 'nan'], true)) {
    $thumbnailUrl = '';
}

// Normalize relative video URL to absolute public URL
$videoUrl = toAbsoluteMediaUrl($videoUrl, 'videos');

$safeRollback = static function (PDO $conn): void {
    try {
        if ($conn->inTransaction()) {
            $conn->rollBack();
        }
    } catch (Throwable $_rollbackErr) {
        error_log('[videos/create.php][ROLLBACK] Rollback failed: ' . $_rollbackErr->getMessage());
    }
};

try {
    $pdo->beginTransaction();

    // 1. Check existing video ownership before allowing updates
    $stmtExisting = $pdo->prepare('
        SELECT id, user_id, visibility, payment_status, payment_id, payment_amount, is_promoted, promotion_plan, promotion_expires_at, created_at
        FROM uploaded_videos
        WHERE id = ?
        FOR UPDATE
    ');
    $stmtExisting->execute([$id]);
    $existingVideo = $stmtExisting->fetch();

    if ($existingVideo) {
        $existingOwner = (string)$existingVideo['user_id'];
        if (strcasecmp($existingOwner, $userId) !== 0 && !$isAuthAdmin) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Cannot overwrite a video owned by another creator.'
            ], 403);
        }
        // Preserve original owner if Admin updates without specifying a target user
        if ($isAuthAdmin && $requestedUserId === '') {
            $userId = $existingOwner;
        }
        // Preserve existing visibility when update omits visibility
        if (!$hasExplicitVisibility) {
            $existingVisibility = strtolower(trim((string)($existingVideo['visibility'] ?? '')));
            $visibility = in_array($existingVisibility, ['public', 'unlisted', 'private'], true)
                ? $existingVisibility
                : 'public';
        }
    }

    // 2. Verify ₹6 Sponsor payment against payment_orders & payment_transactions for premium videos
    if ($videoType === 'premium') {
        // Prevent payment ID reuse across multiple videos
        $stmtReuse = $pdo->prepare('SELECT id FROM uploaded_videos WHERE payment_id = ? AND id != ? LIMIT 1 FOR UPDATE');
        $stmtReuse->execute([$paymentId, $id]);
        if ($stmtReuse->fetch()) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Conflict: Payment ID has already been used for another video.'
            ], 409);
        }

        // Verify payment_orders record
        $stmtOrder = $pdo->prepare('SELECT * FROM payment_orders WHERE payment_id = ? LIMIT 1 FOR UPDATE');
        $stmtOrder->execute([$paymentId]);
        $orderRow = $stmtOrder->fetch();

        if (!$orderRow) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Verified payment order not found for the supplied payment_id.'
            ], 400);
        }

        if (strtolower((string)($orderRow['status'] ?? '')) !== 'paid') {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment order is not verified as paid.'
            ], 400);
        }

        if (strtolower((string)($orderRow['purpose'] ?? '')) !== 'premium_video_upload') {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment purpose mismatch: expected premium_video_upload.'
            ], 400);
        }

        if (strtoupper((string)($orderRow['currency'] ?? 'INR')) !== 'INR') {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment currency mismatch: expected INR.'
            ], 400);
        }

        if (abs(floatval($orderRow['amount'] ?? 0) - 6.00) > 0.01) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment amount mismatch: Sponsor video upload requires verified ₹6.00 INR payment.'
            ], 400);
        }

        $orderOwner = (string)($orderRow['user_id'] ?? '');
        $orderOwnerMatchesTarget = strcasecmp($orderOwner, $userId) === 0;
        $orderOwnerMatchesAuth = strcasecmp($orderOwner, $authUserId) === 0;
        if (!$orderOwnerMatchesTarget && !($isAuthAdmin && $orderOwnerMatchesAuth)) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Payment order belongs to another user.'
            ], 403);
        }

        $orderVideoId = trim((string)($orderRow['video_id'] ?? ''));
        if ($orderVideoId !== '' && $orderVideoId !== $id) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Conflict: Payment order is bound to a different video ID.'
            ], 409);
        }

        // Verify payment_transactions record
        $stmtTx = $pdo->prepare('SELECT * FROM payment_transactions WHERE payment_id = ? LIMIT 1 FOR UPDATE');
        $stmtTx->execute([$paymentId]);
        $txRow = $stmtTx->fetch();

        if (!$txRow) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Verified payment transaction record not found.'
            ], 400);
        }

        if (strtolower((string)($txRow['purpose'] ?? '')) !== 'premium_video_upload') {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment transaction purpose mismatch: expected premium_video_upload.'
            ], 400);
        }

        if (abs(floatval($txRow['amount'] ?? 0) - 6.00) > 0.01) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Payment transaction amount mismatch: expected ₹6.00 INR.'
            ], 400);
        }

        $txOwner = (string)($txRow['user_id'] ?? '');
        $txOwnerMatchesTarget = strcasecmp($txOwner, $userId) === 0;
        $txOwnerMatchesAuth = strcasecmp($txOwner, $authUserId) === 0;
        if (!$txOwnerMatchesTarget && !($isAuthAdmin && $txOwnerMatchesAuth)) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Unauthorized: Payment transaction belongs to another user.'
            ], 403);
        }

        $txVideoId = trim((string)($txRow['video_id'] ?? ''));
        if ($txVideoId !== '' && $txVideoId !== $id) {
            $safeRollback($pdo);
            jsonResponse([
                'success' => false,
                'error' => 'Conflict: Payment transaction is bound to a different video ID.'
            ], 409);
        }

        $paymentStatus = 'paid';
        $paymentAmount = 6.00;
    }

    // 3. Process thumbnail only AFTER authentication, ownership, and payment verification pass
    if (!empty($thumbnailUrl) && str_starts_with($thumbnailUrl, 'data:image/')) {
        $imgData = explode(',', $thumbnailUrl, 2);
        if (count($imgData) === 2) {
            $decoded = base64_decode($imgData[1]);
            if ($decoded !== false) {
                $imgUploadDir = ensureMediaStorageDir('images');
                if ($imgUploadDir) {
                    $imgExt = 'jpg';
                    if (str_contains($imgData[0], 'png')) $imgExt = 'png';
                    else if (str_contains($imgData[0], 'webp')) $imgExt = 'webp';

                    $safeVidId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $id);
                    $imgFileName = 'thumb_' . $safeVidId . '.' . $imgExt;
                    $imgPath = $imgUploadDir . $imgFileName;
                    if (@file_put_contents($imgPath, $decoded)) {
                        $allDirs = getMediaStorageDirectories('images');
                        foreach ($allDirs as $otherDir) {
                            if ($otherDir !== $imgUploadDir && is_dir($otherDir) && is_writable($otherDir)) {
                                @copy($imgPath, $otherDir . $imgFileName);
                            }
                        }
                        $thumbnailUrl = toAbsoluteMediaUrl('/uploads/images/' . $imgFileName, 'images');
                    }
                }
            }
        }
    }

    if (empty($thumbnailUrl) || strlen($thumbnailUrl) > 60000) {
        $categoryThumbnails = [
            'Cartoon' => 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=80',
            'Agriculture' => 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=800&auto=format&fit=crop&q=80',
            'Coding' => 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=80',
            'Motivational' => 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=80',
            'Comedy' => 'https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=800&auto=format&fit=crop&q=80',
            'Entertainment' => 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&auto=format&fit=crop&q=80',
            'Finance' => 'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=800&auto=format&fit=crop&q=80',
            'Share Market' => 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80',
            'General' => 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60',
        ];
        $thumbnailUrl = $categoryThumbnails[$category] ?? $categoryThumbnails['General'];
    } else {
        $thumbnailUrl = toAbsoluteMediaUrl($thumbnailUrl, 'images');
    }

    // 4. Persist record (never trust client is_promoted on insert or overwrite on update)
    $stmt = $pdo->prepare('
        INSERT INTO uploaded_videos (
            id, user_id, creator_name, title, description, video_url, thumbnail_url,
            video_type, content_type, category, duration, views, likes,
            payment_status, payment_id, payment_amount, is_promoted, visibility,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, 0, 0,
            ?, ?, ?, 0, ?,
            NOW(), NOW()
        )
        ON DUPLICATE KEY UPDATE
            creator_name = VALUES(creator_name),
            title = VALUES(title),
            description = VALUES(description),
            video_url = VALUES(video_url),
            thumbnail_url = VALUES(thumbnail_url),
            video_type = VALUES(video_type),
            content_type = VALUES(content_type),
            category = VALUES(category),
            duration = VALUES(duration),
            payment_status = VALUES(payment_status),
            payment_id = VALUES(payment_id),
            payment_amount = VALUES(payment_amount),
            visibility = VALUES(visibility),
            updated_at = NOW()
    ');

    $stmt->execute([
        $id,
        $userId,
        $creatorName,
        $title,
        $description,
        $videoUrl,
        $thumbnailUrl,
        $videoType,
        $contentType,
        $category,
        $duration,
        $paymentStatus,
        $paymentId,
        $paymentAmount,
        $visibility
    ]);

    $pdo->commit();

    $persistedIsPromoted = $existingVideo ? (bool)$existingVideo['is_promoted'] : false;

    jsonResponse([
        'success' => true,
        'video' => [
            'id' => $id,
            'userId' => $userId,
            'user_id' => $userId,
            'creatorName' => $creatorName,
            'creator_name' => $creatorName,
            'title' => $title,
            'description' => $description,
            'videoUrl' => $videoUrl,
            'video_url' => $videoUrl,
            'thumbnailUrl' => $thumbnailUrl,
            'thumbnail_url' => $thumbnailUrl,
            'videoType' => $videoType,
            'video_type' => $videoType,
            'contentType' => $contentType,
            'content_type' => $contentType,
            'category' => $category,
            'duration' => $duration,
            'visibility' => $visibility,
            'paymentStatus' => $paymentStatus,
            'payment_status' => $paymentStatus,
            'paymentId' => $paymentId,
            'payment_id' => $paymentId,
            'paymentAmount' => $paymentAmount,
            'payment_amount' => $paymentAmount,
            'isPromoted' => $persistedIsPromoted,
            'is_promoted' => $persistedIsPromoted,
            'created_at' => $existingVideo['created_at'] ?? date('c'),
        ]
    ], 201);
} catch (Throwable $e) {
    $safeRollback($pdo);
    error_log('[videos/create.php] Database Exception: ' . $e->getMessage());
    if ($isConnectionUnavailable($e)) {
        jsonResponse(['success' => false, 'error' => 'Database connection unavailable during video creation. Please try again.'], 503);
    }
    jsonResponse(['success' => false, 'error' => 'Database error while saving video. Please try again.'], 500);
}
