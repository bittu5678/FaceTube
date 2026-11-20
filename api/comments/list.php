<?php
/**
 * FaceTube - List Video Comments API
 * GET /api/comments/list.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$videoId = trim($_GET['videoId'] ?? ($_GET['video_id'] ?? ''));

if (empty($videoId)) {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}

try {
    $stmt = $pdo->prepare('
        SELECT
            c.id, c.video_id, c.user_id, c.user_name, c.avatar_url, c.comment, c.created_at,
            u.channel_logo_url AS user_channel_logo_url,
            u.channel_name AS user_channel_name
        FROM video_comments c
        LEFT JOIN users u ON UPPER(u.user_id) = UPPER(c.user_id)
        WHERE c.video_id = ?
        ORDER BY c.created_at DESC
        LIMIT 100
    ');
    $stmt->execute([$videoId]);
    $rows = $stmt->fetchAll();

    $comments = array_map(function ($r) {
        $resolvedLogo = !empty($r['user_channel_logo_url'])
            ? toAbsoluteMediaUrl($r['user_channel_logo_url'], 'logos')
            : (!empty($r['avatar_url']) ? toAbsoluteMediaUrl($r['avatar_url'], 'logos') : '');
        $displayName = !empty($r['user_channel_name']) ? $r['user_channel_name'] : $r['user_name'];

        return [
            'id' => $r['id'],
            'videoId' => $r['video_id'],
            'video_id' => $r['video_id'],
            'userId' => $r['user_id'],
            'user_id' => $r['user_id'],
            'userName' => $displayName,
            'user_name' => $displayName,
            'avatarUrl' => $resolvedLogo,
            'avatar_url' => $resolvedLogo,
            'channelLogoUrl' => $resolvedLogo ?: null,
            'channel_logo_url' => $resolvedLogo ?: null,
            'comment' => $r['comment'],
            'createdAt' => $r['created_at'],
            'created_at' => $r['created_at'],
        ];
    }, $rows);

    jsonResponse(['success' => true, 'comments' => $comments, 'total' => count($comments)]);
} catch (PDOException $e) {
    // If table doesn't exist yet, return empty list gracefully
    jsonResponse(['success' => true, 'comments' => [], 'total' => 0]);
}
