<?php
/**
 * FaceTube - List Uploaded Images API
 * GET /api/images/list.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$userId = trim($_GET['userId'] ?? ($_GET['user_id'] ?? ''));
$category = trim($_GET['category'] ?? '');
$limit = max(1, min(100, intval($_GET['limit'] ?? 50)));

$where = [];
$params = [];

if (!empty($userId)) {
    $where[] = 'UPPER(i.user_id) = UPPER(?)';
    $params[] = $userId;
}

if (!empty($category) && $category !== 'All') {
    $where[] = 'i.category = ?';
    $params[] = $category;
}

$whereSql = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';

try {
    $hasMusicCol = false;
    try {
        $colStmt = $pdo->query("SHOW COLUMNS FROM uploaded_images LIKE 'music_json'");
        $hasMusicCol = $colStmt && $colStmt->fetch() !== false;
    } catch (PDOException $colErr) {
        $hasMusicCol = false;
    }

    $musicSelect = $hasMusicCol ? ', i.music_json' : '';
    $sql = "
        SELECT
            i.id, i.user_id, i.creator_name, i.title, i.description, i.image_url, i.thumbnail_url, i.category, i.views, i.likes, i.created_at{$musicSelect},
            u.channel_logo_url AS creator_channel_logo_url,
            u.channel_name AS creator_channel_name
        FROM uploaded_images i
        LEFT JOIN users u ON UPPER(u.user_id) = UPPER(i.user_id)
        {$whereSql}
        ORDER BY i.created_at DESC
        LIMIT {$limit}
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rawImages = $stmt->fetchAll();
    $images = array_map(function ($img) {
        $rawLogo = isset($img['creator_channel_logo_url']) ? trim((string)$img['creator_channel_logo_url']) : '';
        $channelLogoUrl = ($rawLogo !== '' && strtolower($rawLogo) !== 'null' && strtolower($rawLogo) !== 'undefined')
            ? toAbsoluteMediaUrl($rawLogo, 'logos')
            : null;
        if ($channelLogoUrl === '') {
            $channelLogoUrl = null;
        }

        $rawChannelName = isset($img['creator_channel_name']) ? trim((string)$img['creator_channel_name']) : '';
        $rawCreatorName = isset($img['creator_name']) ? trim((string)$img['creator_name']) : '';
        $channelName = $rawChannelName !== ''
            ? $rawChannelName
            : ($rawCreatorName !== '' ? $rawCreatorName : 'FaceTube Creator');
        $creatorName = $rawCreatorName !== '' ? $rawCreatorName : $channelName;

        $music = null;
        if (!empty($img['music_json']) && is_string($img['music_json'])) {
            $decodedMusic = json_decode($img['music_json'], true);
            if (is_array($decodedMusic) && !empty($decodedMusic['trackId'])) {
                $music = $decodedMusic;
            }
        }

        unset($img['creator_channel_logo_url'], $img['creator_channel_name'], $img['music_json']);

        $img['userId'] = $img['user_id'] ?? '';
        $img['creatorName'] = $creatorName;
        $img['creator_name'] = $creatorName;
        $img['channelName'] = $channelName;
        $img['channel_name'] = $channelName;
        $img['channelLogoUrl'] = $channelLogoUrl;
        $img['channel_logo_url'] = $channelLogoUrl;
        $img['image_url'] = toAbsoluteMediaUrl($img['image_url'] ?? '', 'images');
        $img['imageUrl'] = $img['image_url'];
        $img['thumbnail_url'] = toAbsoluteMediaUrl($img['thumbnail_url'] ?? '', 'images');
        $img['thumbnailUrl'] = $img['thumbnail_url'];
        $img['music'] = $music;
        return $img;
    }, $rawImages);

    jsonResponse(['success' => true, 'images' => $images, 'total' => count($images)]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error while fetching images.'], 500);
}
