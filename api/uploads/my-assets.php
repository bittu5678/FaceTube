<?php
/**
 * FaceTube - List Authenticated User's Uploaded Video Assets
 * GET /api/uploads/my-assets.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../payments/premium-settlement.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed. Use GET.'], 405);
}

$pdo = getDatabaseConnection();

try {
    $authUser = getAuthUser($pdo, true);
} catch (Throwable $authErr) {
    error_log('[uploads/my-assets.php] Auth DB error: ' . $authErr->getMessage());
    $isConnErr = ftIsConnectionUnavailablePhp($authErr);
    jsonResponse([
        'success' => false,
        'error' => $isConnErr
            ? 'Database connection unavailable while listing uploaded assets.'
            : 'Authentication service error.',
    ], $isConnErr ? 503 : 500);
}

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required to view uploaded assets.',
    ], 401);
}

$authUid = trim((string)($authUser['user_id'] ?? ''));
$seenPaths = [];
$assets = [];
$schemaReady = false;

try {
    $schemaReady = ftCheckUploadAssetsTableExistsPhp($pdo);
    if ($schemaReady) {
        $stmtAssets = $pdo->prepare('
            SELECT id, file_name, relative_path, public_url, video_id, order_id, size_bytes, format, created_at
            FROM uploaded_video_assets
            WHERE UPPER(user_id) = UPPER(?)
            ORDER BY created_at DESC
            LIMIT 50
        ');
        $stmtAssets->execute([$authUid]);
        $assetRows = $stmtAssets->fetchAll(PDO::FETCH_ASSOC) ?: [];
        foreach ($assetRows as $r) {
            $rel = ftExtractCanonicalVideoAssetRelativePathPhp((string)($r['relative_path'] ?? ''));
            if (!$rel || isset($seenPaths[$rel])) {
                continue;
            }
            $seenPaths[$rel] = true;
            $diskValid = ftValidateUploadedVideoAssetPhp($rel);
            $ext = strtolower((string)pathinfo($rel, PATHINFO_EXTENSION));
            $assets[] = [
                'id' => (string)$r['id'],
                'fileName' => (string)($r['file_name'] ?: str_replace('/uploads/videos/', '', $rel)),
                'relativePath' => $rel,
                'publicUrl' => !empty($diskValid['publicUrl'])
                    ? (string)$diskValid['publicUrl']
                    : (string)($r['public_url'] ?: $rel),
                'videoId' => !empty($r['video_id']) ? (string)$r['video_id'] : null,
                'orderId' => !empty($r['order_id']) ? (string)$r['order_id'] : null,
                'sizeBytes' => (int)($r['size_bytes'] ?? 0),
                'format' => (string)($r['format'] ?: ($ext ?: 'mp4')),
                'uploadedAt' => (string)($r['created_at'] ?: date('c')),
                'fileExists' => !empty($diskValid['valid']),
            ];
        }
    }

    $stmtVids = $pdo->prepare('
        SELECT id, video_url, created_at
        FROM uploaded_videos
        WHERE UPPER(user_id) = UPPER(?)
        ORDER BY created_at DESC
        LIMIT 50
    ');
    $stmtVids->execute([$authUid]);
    $vidRows = $stmtVids->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($vidRows as $v) {
        $rel = ftExtractCanonicalVideoAssetRelativePathPhp((string)($v['video_url'] ?? ''));
        if (!$rel || isset($seenPaths[$rel])) {
            continue;
        }
        $diskValid = ftValidateUploadedVideoAssetPhp($rel);
        if (empty($diskValid['valid'])) {
            continue;
        }
        $seenPaths[$rel] = true;
        $ext = strtolower((string)pathinfo($rel, PATHINFO_EXTENSION));
        $assets[] = [
            'id' => 'vid-asset-' . (string)$v['id'],
            'fileName' => str_replace('/uploads/videos/', '', $rel),
            'relativePath' => $rel,
            'publicUrl' => !empty($diskValid['publicUrl']) ? (string)$diskValid['publicUrl'] : $rel,
            'videoId' => (string)$v['id'],
            'orderId' => null,
            'sizeBytes' => 0,
            'format' => $ext ?: 'mp4',
            'uploadedAt' => (string)($v['created_at'] ?: date('c')),
            'fileExists' => true,
        ];
    }

    jsonResponse([
        'success' => true,
        'schemaReady' => $schemaReady,
        'assets' => $assets,
    ]);
} catch (Throwable $err) {
    error_log('[uploads/my-assets.php] Lookup error: ' . $err->getMessage());
    $isConnErr = ftIsConnectionUnavailablePhp($err);
    jsonResponse([
        'success' => false,
        'error' => $isConnErr
            ? 'Database connection unavailable while listing uploaded assets.'
            : 'Database error listing uploaded assets.',
    ], $isConnErr ? 503 : 500);
}
