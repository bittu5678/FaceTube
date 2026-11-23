<?php
/**
 * FaceTube - Live Streams API
 * GET /api/live/streams.php - List all live and upcoming streams
 * POST /api/live/streams.php - Create or update a live stream broadcast
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$isConnectionUnavailable = static function (Throwable $e): bool {
    if (function_exists('isDatabaseConnectionUnavailableError')) {
        return isDatabaseConnectionUnavailableError($e);
    }
    $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
    $driverCode = ($e instanceof PDOException && isset($e->errorInfo[1])) ? (int)$e->errorInfo[1] : 0;
    return str_starts_with($sqlState, '08') || in_array($driverCode, [1040, 1042, 1053, 1129, 1203, 2002, 2003, 2005, 2006, 2013], true);
};

$isMissingColumnError = static function (Throwable $e): bool {
    if (!($e instanceof PDOException)) {
        return false;
    }
    $sqlState = (string)($e->errorInfo[0] ?? $e->getCode());
    $driverCode = isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
    return $sqlState === '42S22' || $driverCode === 1054;
};

$pdo = getDatabaseConnection();
$method = $_SERVER['REQUEST_METHOD'] ?? '';

if ($method === 'GET') {
    try {
        $primarySql = "
            SELECT
                s.id,
                s.user_id,
                s.title,
                s.description,
                s.category,
                s.playback_url,
                s.thumbnail_url,
                s.status,
                s.viewers_count,
                s.started_at,
                s.ended_at,
                s.created_at,
                s.updated_at,
                COALESCE(NULLIF(NULLIF(NULLIF(TRIM(u.channel_name), ''), 'null'), 'undefined'), u.name) AS streamer_name,
                COALESCE(NULLIF(NULLIF(NULLIF(TRIM(u.channel_name), ''), 'null'), 'undefined'), u.name) AS channel_name,
                u.avatar_url,
                COALESCE(NULLIF(NULLIF(NULLIF(TRIM(u.channel_logo_url), ''), 'null'), 'undefined'), u.avatar_url) AS channel_logo_url
            FROM live_streams s
            LEFT JOIN users u ON UPPER(s.user_id) = UPPER(u.user_id)
            WHERE s.status IN ('live', 'upcoming')
            ORDER BY (s.status = 'live') DESC, s.viewers_count DESC, s.created_at DESC
        ";

        $streams = [];
        try {
            $stmt = $pdo->query($primarySql);
            $streams = $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $primaryErr) {
            if (!$isMissingColumnError($primaryErr) || !preg_match('/\b(channel_name|channel_logo_url|playback_url|updated_at)\b/i', $primaryErr->getMessage())) {
                throw $primaryErr;
            }

            error_log('[live/streams.php][GET] Optional column fallback triggered: ' . $primaryErr->getMessage());
            $includePlaybackAndUpdated = !preg_match('/\b(playback_url|updated_at)\b/i', $primaryErr->getMessage());

            $buildFallbackSql = static function (bool $withPlaybackAndUpdated): string {
                $optionalStreamCols = $withPlaybackAndUpdated
                    ? "s.playback_url, s.updated_at,"
                    : "'' AS playback_url, s.created_at AS updated_at,";
                return "
                    SELECT
                        s.id,
                        s.user_id,
                        s.title,
                        s.description,
                        s.category,
                        {$optionalStreamCols}
                        s.thumbnail_url,
                        s.status,
                        s.viewers_count,
                        s.started_at,
                        s.ended_at,
                        s.created_at,
                        u.name AS streamer_name,
                        u.name AS channel_name,
                        u.avatar_url,
                        u.avatar_url AS channel_logo_url
                    FROM live_streams s
                    LEFT JOIN users u ON UPPER(s.user_id) = UPPER(u.user_id)
                    WHERE s.status IN ('live', 'upcoming')
                    ORDER BY (s.status = 'live') DESC, s.viewers_count DESC, s.created_at DESC
                ";
            };

            try {
                $stmt = $pdo->query($buildFallbackSql($includePlaybackAndUpdated));
                $streams = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } catch (Throwable $fallbackErr) {
                if (
                    $includePlaybackAndUpdated &&
                    $isMissingColumnError($fallbackErr) &&
                    preg_match('/\b(playback_url|updated_at)\b/i', $fallbackErr->getMessage())
                ) {
                    $stmt = $pdo->query($buildFallbackSql(false));
                    $streams = $stmt->fetchAll(PDO::FETCH_ASSOC);
                } else {
                    throw $fallbackErr;
                }
            }
        }

        foreach ($streams as &$s) {
            $s['id'] = (string)($s['id'] ?? '');
            $s['viewers_count'] = (int)($s['viewers_count'] ?? 0);
            if (!empty($s['channel_logo_url'])) {
                $normalizedLogo = toAbsoluteMediaUrl($s['channel_logo_url'], 'logos');
                $s['channel_logo_url'] = $normalizedLogo !== '' ? $normalizedLogo : null;
            } else {
                $s['channel_logo_url'] = null;
            }
        }
        unset($s);

        jsonResponse([
            'success' => true,
            'streams' => $streams,
        ]);
    } catch (Throwable $e) {
        error_log('[live/streams.php][GET] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while loading live streams.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Database error while loading live streams.'], 500);
    }
}

if ($method === 'POST') {
    try {
        $authUser = getAuthUser($pdo, true);
    } catch (Throwable $e) {
        error_log('[live/streams.php][POST][AUTH] Database error: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable during authentication check.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Database error during authentication check.'], 500);
    }

    if (!$authUser) {
        jsonResponse(['success' => false, 'error' => 'Authentication required to start a live stream'], 401);
    }

    $rawBody = file_get_contents('php://input');
    if (is_string($rawBody) && trim($rawBody) !== '') {
        $decodedJson = json_decode($rawBody, true);
        if (json_last_error() !== JSON_ERROR_NONE || !is_array($decodedJson)) {
            jsonResponse(['success' => false, 'error' => 'Invalid JSON request body'], 400);
        }
        $input = $decodedJson;
    } else {
        $input = $_POST ?: [];
    }

    $title = trim((string)($input['title'] ?? ''));
    $description = trim((string)($input['description'] ?? ''));
    $category = trim((string)($input['category'] ?? 'Coding & Tech'));
    $thumbnailUrl = trim((string)($input['thumbnail_url'] ?? ($input['thumbnailUrl'] ?? '')));
    $requestedPlaybackUrl = trim((string)($input['playback_url'] ?? ($input['playbackUrl'] ?? '')));

    if (empty($title)) {
        jsonResponse(['success' => false, 'error' => 'Stream title is required'], 400);
    }

    $streamId = 'live_' . (int)round(microtime(true) * 1000) . '_' . bin2hex(random_bytes(3));
    $roomName = 'room_' . $streamId;
    $streamKey = 'sk_live_' . bin2hex(random_bytes(16));
    $playbackUrl = $requestedPlaybackUrl !== '' ? $requestedPlaybackUrl : ('https://live.facetube.online/hls/' . $streamId . '/index.m3u8');

    try {
        $pdo->beginTransaction();

        try {
            $stmt = $pdo->prepare("
                INSERT INTO live_streams (id, user_id, title, description, category, stream_key, playback_url, thumbnail_url, livekit_room_name, status, viewers_count, started_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, NOW(), NOW())
            ");
            $stmt->execute([
                $streamId,
                $authUser['user_id'],
                $title,
                $description,
                $category,
                $streamKey,
                $playbackUrl,
                $thumbnailUrl ?: null,
                $roomName
            ]);
        } catch (Throwable $colErr) {
            $isMissingRoomNameCol = $isMissingColumnError($colErr)
                && stripos($colErr->getMessage(), 'livekit_room_name') !== false;

            if (!$isMissingRoomNameCol) {
                throw $colErr;
            }

            // Fallback when optional livekit_room_name column migration is not yet applied
            $stmt = $pdo->prepare("
                INSERT INTO live_streams (id, user_id, title, description, category, stream_key, playback_url, thumbnail_url, status, viewers_count, started_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, NOW(), NOW())
            ");
            $stmt->execute([
                $streamId,
                $authUser['user_id'],
                $title,
                $description,
                $category,
                $streamKey,
                $playbackUrl,
                $thumbnailUrl ?: null
            ]);
        }

        $pdo->commit();

        jsonResponse([
            'success' => true,
            'message' => 'Live stream created successfully',
            'stream' => [
                'id' => $streamId,
                'user_id' => $authUser['user_id'],
                'title' => $title,
                'description' => $description,
                'category' => $category,
                'stream_key' => $streamKey,
                'playback_url' => $playbackUrl,
                'thumbnail_url' => $thumbnailUrl,
                'livekit_room_name' => $roomName,
                'status' => 'live',
                'viewers_count' => 1,
            ]
        ], 201);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('[live/streams.php][POST] Failed to create live stream: ' . $e->getMessage());
        if ($isConnectionUnavailable($e)) {
            jsonResponse(['success' => false, 'error' => 'Database connection unavailable while creating live stream.'], 503);
        }
        jsonResponse(['success' => false, 'error' => 'Failed to create live stream.'], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
